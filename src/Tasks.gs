/**
 * Tasks.gs
 * Task management (Sections 5.2, 6.2-6.5): assign tasks, update status,
 * write completion notes, flag overdue tasks, email the assignee.
 *
 * Access rules, enforced here on the server:
 *   - Staff: see tasks assigned to them.
 *   - Lead:  see tasks for themself and their direct reports, and can
 *            create tasks for those people.
 *   - Admin: see every task, can create tasks for any active staff member.
 *   - Status/note updates: the assignee, the person who assigned the task,
 *     or an Admin.
 * Tasks are never deleted. `active` = FALSE hides a task (blank = active).
 *
 * "Overdue" is calculated on every read (due date before today and status
 * not Completed). It is a flag, never stored, so it can't go stale.
 */

const Tasks = {

  // Used only when the Config tab has no rows for that category.
  DEFAULT_STATUSES: ['Not started', 'In progress', 'Blocked', 'Submitted', 'Completed'],
  DEFAULT_PRIORITIES: ['High', 'Medium', 'Low'],
  START_STATUS: 'Not started',
  DONE_STATUS: 'Completed',

  // Written as plain text so Sheets never converts them to date objects.
  TEXT_COLUMNS_: ['due_date', 'created_date', 'completed_date', 'updated_at'],

  clean_: function (v) {
    return String(v === undefined || v === null ? '' : v).trim();
  },

  isActive_: function (v) {
    return !(v === false || String(v).toLowerCase() === 'false');
  },

  nowStamp_: function () {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  },

  /** Dropdown values, read from Config with built-in fallbacks. */
  options: function (user) {
    const pick = function (category, fallback) {
      const values = configValues_(category);
      return values.length ? values : fallback;
    };
    return {
      statuses: pick('task_status', Tasks.DEFAULT_STATUSES),
      priorities: pick('priority', Tasks.DEFAULT_PRIORITIES),
      departments: configValues_('department'),
      programmes: Tasks.programmes_(),
      people: Tasks.people_(user)
    };
  },

  /** Programmes a task can be linked to (Programmes tab, may be empty). */
  programmes_: function () {
    const sheet = getDb_().getSheetByName('Programmes');
    if (!sheet) return [];
    const map = columnMap_('Programmes');
    return sheet.getDataRange().getValues().slice(1)
      .filter(function (row) {
        return String(row[map.programme_id - 1]) !== '' && Tasks.isActive_(row[map.active - 1]);
      })
      .map(function (row) {
        return { id: String(row[map.programme_id - 1]), name: String(row[map.programme - 1]) };
      });
  },

  /** Active staff the caller may assign tasks to or filter by. Staff get none. */
  people_: function (user) {
    if (user.accessLevel === 'Staff') return [];
    const visible = visibleStaffEmails_(user); // null = Admin, everyone
    return StaffDirectory.readAll_()
      .filter(function (s) {
        return s.status === 'Active' && (visible === null || visible.indexOf(s.email) !== -1);
      })
      .map(function (s) { return { email: s.email, name: s.full_name, department: s.department }; });
  },

  /** Stops with a clear message if the Tasks headers are missing columns. */
  checkHeaders_: function (sheet) {
    const want = SCHEMA.Tasks;
    const have = sheet.getRange(1, 1, 1, want.length).getValues()[0];
    for (let i = 0; i < want.length; i++) {
      if (have[i] !== want[i]) {
        throw new Error('The Tasks tab headers are out of date (expected "' + want[i] +
          '" in column ' + (i + 1) + '). Run setupSheets() once, then reload.');
      }
    }
  },

  /** Every Tasks row as a plain object, plus its sheet row number. */
  readAll_: function () {
    const ss = getDb_();
    const sheet = ss.getSheetByName('Tasks');
    Tasks.checkHeaders_(sheet);
    const tz = ss.getSpreadsheetTimeZone(); // dates in cells belong to the sheet's zone
    const dateOnly = { due_date: true, created_date: true, completed_date: true };
    return sheet.getDataRange().getValues().slice(1).map(function (row, i) {
      const rec = { rowIndex: i + 2 };
      SCHEMA.Tasks.forEach(function (name, c) {
        let v = row[c];
        if (v instanceof Date) {
          v = Utilities.formatDate(v, tz, dateOnly[name] ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
        }
        rec[name] = v === undefined || v === null ? '' : v;
      });
      rec.assignee_email = Tasks.clean_(rec.assignee_email).toLowerCase();
      rec.assigned_by = Tasks.clean_(rec.assigned_by).toLowerCase();
      rec.active = Tasks.isActive_(rec.active);
      return rec;
    }).filter(function (rec) { return Tasks.clean_(rec.task_id) !== ''; });
  },

  canUpdate_: function (user, task) {
    return user.accessLevel === 'Admin' ||
      task.assignee_email === user.email ||
      task.assigned_by === user.email;
  },

  /**
   * Tasks the caller may see, optionally narrowed by filters:
   * { assignee_email, department, linked_programme, status }.
   * Filters only ever narrow what the caller can already see.
   */
  list: function (user, filters) {
    filters = filters || {};
    const names = {};
    StaffDirectory.readAll_().forEach(function (s) { names[s.email] = s.full_name; });
    const visible = visibleStaffEmails_(user); // null = Admin, no filter
    const today = todayIso_();

    let rows = Tasks.readAll_().filter(function (t) {
      return t.active && (visible === null ||
        visible.indexOf(t.assignee_email) !== -1 ||
        t.assigned_by === user.email);
    });

    ['assignee_email', 'department', 'linked_programme', 'status'].forEach(function (key) {
      const want = Tasks.clean_(filters[key]);
      if (!want) return;
      const wantNorm = key === 'assignee_email' ? want.toLowerCase() : want;
      rows = rows.filter(function (t) { return t[key] === wantNorm; });
    });

    rows.forEach(function (t) {
      t.assignee_name = names[t.assignee_email] || t.assignee_email;
      t.assigned_by_name = names[t.assigned_by] || t.assigned_by;
      t.overdue = !!t.due_date && t.due_date < today && t.status !== Tasks.DONE_STATUS;
      t.canUpdate = Tasks.canUpdate_(user, t);
    });

    // Overdue first, then soonest due date, then id.
    rows.sort(function (a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
      return a.task_id < b.task_id ? -1 : 1;
    });
    return rows;
  },

  /** Validates the form, appends the task, then emails the assignee. */
  create: function (user, data) {
    if (user.accessLevel !== 'Admin' && user.accessLevel !== 'Lead') {
      throw new Error('Access denied: Lead or Admin only.');
    }
    data = data || {};
    const opts = Tasks.options(user);
    const clean = Tasks.clean_;

    const title = clean(data.title);
    const description = clean(data.description);
    const assignee = clean(data.assignee_email).toLowerCase();
    const priority = clean(data.priority);
    const dueDate = clean(data.due_date);
    const programme = clean(data.linked_programme);
    let department = clean(data.department);

    if (!title) throw new Error('Title is required.');
    if (!assignee) throw new Error('Choose who the task is assigned to.');
    if (opts.priorities.indexOf(priority) === -1) throw new Error('Choose a priority from the list.');
    if (!isIsoDate_(dueDate)) throw new Error('Due date must be a valid date.');

    // The people list is already limited to what this caller may assign to.
    const person = opts.people.filter(function (p) { return p.email === assignee; })[0];
    if (!person) throw new Error('You cannot assign a task to ' + assignee + '.');

    if (!department) department = person.department;
    if (opts.departments.indexOf(department) === -1) throw new Error('Choose a department from the list.');
    if (programme && !opts.programmes.some(function (p) { return p.id === programme; })) {
      throw new Error('Choose a programme from the list, or leave it blank.');
    }

    const created = withLock_(function () {
      const sheet = getDb_().getSheetByName('Tasks');
      const all = Tasks.readAll_(); // inside the lock so ids never clash

      let max = 0;
      all.forEach(function (t) {
        const m = /^TSK-(\d+)$/.exec(String(t.task_id));
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      const taskId = 'TSK-' + String(max + 1).padStart(4, '0');

      const record = {
        task_id: taskId, title: title, description: description,
        assignee_email: assignee, assigned_by: user.email, department: department,
        linked_programme: programme, priority: priority, status: Tasks.START_STATUS,
        due_date: dueDate, created_date: todayIso_(), completed_date: '', active: true,
        completion_note: '', updated_by: user.email, updated_at: Tasks.nowStamp_()
      };
      Tasks.writeRow_(sheet, sheet.getLastRow() + 1, record);
      return record;
    });

    // The task is saved; a mail failure must not undo it.
    let warning = '';
    if (assignee !== user.email) {
      try {
        Tasks.notifyAssigned_(created, user, person);
      } catch (e) {
        warning = 'Task saved, but the email to the assignee could not be sent.';
        Logger.log('Task email failed: ' + e);
      }
    }
    return { task_id: created.task_id, warning: warning };
  },

  /** Writes a whole new row, keeping date columns as plain text. */
  writeRow_: function (sheet, rowNumber, record) {
    const cols = columnMap_('Tasks');
    Tasks.TEXT_COLUMNS_.forEach(function (name) {
      sheet.getRange(rowNumber, cols[name]).setNumberFormat('@');
    });
    const row = SCHEMA.Tasks.map(function (name) { return record[name]; });
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  },

  notifyAssigned_: function (task, assigner, person) {
    let link = '';
    try { link = ScriptApp.getService().getUrl() || ''; } catch (e) { /* no web app URL yet */ }
    const body = [
      'Hello ' + person.name + ',',
      '',
      assigner.fullName + ' assigned you a new task.',
      '',
      'Task: ' + task.title,
      'Priority: ' + task.priority,
      'Due: ' + task.due_date,
      task.description ? '\n' + task.description : '',
      link ? '\nOpen the dashboard: ' + link : ''
    ].join('\n');
    sendMail_(person.email, 'New task assigned: ' + task.title, body);
  },

  /** Sets a task's status and (optionally) its completion note. */
  update: function (user, taskId, status, note) {
    taskId = Tasks.clean_(taskId);
    status = Tasks.clean_(status);
    note = Tasks.clean_(note);
    const opts = Tasks.options(user);
    if (opts.statuses.indexOf(status) === -1) throw new Error('Choose a status from the list.');

    return withLock_(function () {
      const task = Tasks.readAll_().filter(function (t) {
        return t.task_id === taskId && t.active;
      })[0];
      if (!task) throw new Error('Task not found.');
      if (!Tasks.canUpdate_(user, task)) throw new Error('Access denied: you cannot update this task.');

      const finalNote = note || Tasks.clean_(task.completion_note);
      if (status === Tasks.DONE_STATUS && !finalNote) {
        throw new Error('Add a completion note before marking a task Completed.');
      }

      let completedDate = Tasks.clean_(task.completed_date);
      if (status === Tasks.DONE_STATUS) {
        if (task.status !== Tasks.DONE_STATUS || !completedDate) completedDate = todayIso_();
      } else {
        completedDate = ''; // moved back out of Completed
      }

      const sheet = getDb_().getSheetByName('Tasks');
      const cols = columnMap_('Tasks');
      const changes = {
        status: status, completed_date: completedDate, completion_note: finalNote,
        updated_by: user.email, updated_at: Tasks.nowStamp_()
      };
      Object.keys(changes).forEach(function (name) {
        const cell = sheet.getRange(task.rowIndex, cols[name]);
        if (Tasks.TEXT_COLUMNS_.indexOf(name) !== -1) cell.setNumberFormat('@');
        cell.setValue(changes[name]);
      });
      return { task_id: taskId, status: status, completed_date: completedDate };
    });
  },

  /**
   * Monday summary: one email per active staff member who has open tasks,
   * listing overdue ones first. Returns how many emails were sent.
   */
  sendSummaries: function () {
    const today = todayIso_();
    const open = Tasks.readAll_().filter(function (t) {
      return t.active && t.status !== Tasks.DONE_STATUS;
    });
    let sent = 0;
    StaffDirectory.readAll_().filter(function (s) { return s.status === 'Active'; })
      .forEach(function (s) {
        const mine = open.filter(function (t) { return t.assignee_email === s.email; });
        if (!mine.length) return;
        const overdue = mine.filter(function (t) { return t.due_date && t.due_date < today; });
        const line = function (t) {
          return '- ' + t.title + ' (due ' + (t.due_date || 'no date') + ', ' + t.status + ')';
        };
        const parts = ['Hello ' + s.full_name + ',', '',
          'You have ' + mine.length + ' open task(s), ' + overdue.length + ' overdue.', ''];
        if (overdue.length) parts.push('OVERDUE', overdue.map(line).join('\n'), '');
        const rest = mine.filter(function (t) { return overdue.indexOf(t) === -1; });
        if (rest.length) parts.push('OPEN', rest.map(line).join('\n'), '');
        try {
          sendMail_(s.email, 'Your tasks for this week', parts.join('\n'));
          sent++;
        } catch (e) {
          Logger.log('Summary email failed for ' + s.email + ': ' + e);
        }
      });
    return sent;
  }
};

// ---- Functions callable from the browser (google.script.run) ----
// Each one re-checks the caller on the server. The UI is never trusted.

function tasksOptions() {
  return Tasks.options(requireUser_());
}

function tasksList(filters) {
  return Tasks.list(requireUser_(), filters);
}

function tasksCreate(data) {
  return Tasks.create(requireLeadOrAdmin_(), data);
}

function tasksUpdate(taskId, status, note) {
  return Tasks.update(requireUser_(), taskId, status, note);
}
