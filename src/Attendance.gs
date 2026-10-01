/**
 * Attendance.gs
 * Check in / check out (Sections 5.4, 6.2): writes exact server timestamps
 * to the Attendance tab, shows a person's own history, and gives Leads and
 * Admins a view of who has checked in on a given day.
 *
 * Rules, enforced here on the server:
 *   - Timestamps always come from the server clock. The browser never
 *     supplies a time, a date or who is checking in.
 *   - One row per person per day: one check-in, then one check-out. The
 *     day is the calendar date in the script's time zone.
 *   - A check-out only ever closes TODAY's row. If someone forgets to check
 *     out, that day shows "No check-out" in their history and an Admin
 *     corrects the Sheet row. (Overnight shifts are not supported.)
 *   - Work mode (Remote / Office / Field) is chosen at check-in and the
 *     options come from the Config tab.
 *   - Rows are never deleted. active = FALSE hides a row.
 *   - Staff see their own records. Leads see themself and their direct
 *     reports. Admins see everyone.
 */

const Attendance = {

  DEFAULT_MODES: ['Remote', 'Office', 'Field'],
  HISTORY_ROWS: 30,

  // Plain-text columns: dates and timestamps stay strings, never date objects.
  TEXT_COLUMNS_: ['date', 'check_in', 'check_out'],

  clean_: function (v) {
    return String(v === undefined || v === null ? '' : v).trim();
  },

  isActive_: function (v) {
    return !(v === false || String(v).toLowerCase() === 'false');
  },

  /** The one source of "now": a yyyy-MM-dd HH:mm:ss stamp in the script's time zone. */
  now_: function () {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  },

  today_: function () {
    return Attendance.now_().slice(0, 10);
  },

  modes_: function () {
    const values = configValues_('work_mode');
    return values.length ? values : Attendance.DEFAULT_MODES;
  },

  /** Minutes between two stamps, or null if either is missing or unreadable. */
  minutesBetween_: function (from, to) {
    const parse = function (s) {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s));
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
    };
    const a = parse(from), b = parse(to);
    if (a === null || b === null || b < a) return null;
    return Math.floor((b - a) / 60000);
  },

  durationText_: function (from, to) {
    const mins = Attendance.minutesBetween_(from, to);
    if (mins === null) return '';
    return Math.floor(mins / 60) + 'h ' + String(mins % 60).padStart(2, '0') + 'm';
  },

  // ---- reading ----

  /** Stops with a clear message if the Attendance headers do not match SCHEMA. */
  checkHeaders_: function (sheet) {
    const want = SCHEMA.Attendance;
    const have = sheet.getRange(1, 1, 1, want.length).getValues()[0];
    for (let i = 0; i < want.length; i++) {
      if (have[i] !== want[i]) {
        throw new Error('The Attendance tab headers are out of date (expected "' + want[i] +
          '" in column ' + (i + 1) + '). Run setupSheets() once, then reload.');
      }
    }
  },

  /** Every active Attendance row as a plain object, plus its sheet row number. */
  readAll_: function () {
    const ss = getDb_();
    const sheet = ss.getSheetByName('Attendance');
    Attendance.checkHeaders_(sheet);
    const tz = ss.getSpreadsheetTimeZone(); // dates typed into cells belong to the sheet's zone
    return sheet.getDataRange().getValues().slice(1).map(function (row, i) {
      const rec = { rowIndex: i + 2 };
      SCHEMA.Attendance.forEach(function (name, c) {
        let v = row[c];
        if (v instanceof Date) {
          v = Utilities.formatDate(v, tz, name === 'date' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm:ss');
        }
        rec[name] = v === undefined || v === null ? '' : v;
      });
      rec.staff_email = Attendance.clean_(rec.staff_email).toLowerCase();
      rec.date = Attendance.clean_(rec.date);
      rec.check_in = Attendance.clean_(rec.check_in);
      rec.check_out = Attendance.clean_(rec.check_out);
      rec.active = Attendance.isActive_(rec.active);
      return rec;
    }).filter(function (rec) {
      return Attendance.clean_(rec.attendance_id) !== '' && rec.active;
    });
  },

  findRow_: function (all, email, date) {
    return all.filter(function (r) { return r.staff_email === email && r.date === date; })[0];
  },

  /** Writes a whole new row, keeping date and time columns as plain text. */
  writeRow_: function (sheet, rowNumber, record) {
    const cols = columnMap_('Attendance');
    Attendance.TEXT_COLUMNS_.forEach(function (name) {
      sheet.getRange(rowNumber, cols[name]).setNumberFormat('@');
    });
    const row = SCHEMA.Attendance.map(function (name) { return record[name]; });
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  },

  // ---- the signed-in person ----

  /** Today's state for the buttons: none (can check in), in (can check out) or out (done). */
  today: function (user) {
    const now = Attendance.now_();
    const date = now.slice(0, 10);
    const rec = Attendance.findRow_(Attendance.readAll_(), user.email, date);
    let state = 'none';
    if (rec) state = rec.check_out ? 'out' : 'in';
    return {
      date: date,
      time: now.slice(11, 16),
      state: state,
      modes: Attendance.modes_(),
      work_mode: rec ? rec.work_mode : '',
      check_in: rec ? rec.check_in : '',
      check_out: rec ? rec.check_out : '',
      duration: rec && rec.check_out ? Attendance.durationText_(rec.check_in, rec.check_out) : ''
    };
  },

  checkIn: function (user, workMode) {
    workMode = Attendance.clean_(workMode);
    if (Attendance.modes_().indexOf(workMode) === -1) throw new Error('Choose a work mode from the list.');

    return withLock_(function () {
      const now = Attendance.now_();
      const date = now.slice(0, 10);
      const all = Attendance.readAll_(); // inside the lock so a double click cannot add two rows
      const existing = Attendance.findRow_(all, user.email, date);
      if (existing) {
        throw new Error(existing.check_out
          ? 'You have already checked in and out today.'
          : 'You are already checked in today (' + existing.check_in.slice(11, 16) + ').');
      }

      let max = 0;
      all.forEach(function (r) {
        const m = /^ATT-(\d+)$/.exec(String(r.attendance_id));
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      const id = 'ATT-' + String(max + 1).padStart(5, '0');

      const sheet = getDb_().getSheetByName('Attendance');
      Attendance.writeRow_(sheet, sheet.getLastRow() + 1, {
        attendance_id: id, staff_email: user.email, date: date, check_in: now,
        check_out: '', work_mode: workMode, active: true
      });
      return { attendance_id: id, check_in: now };
    });
  },

  checkOut: function (user) {
    return withLock_(function () {
      const now = Attendance.now_();
      const date = now.slice(0, 10);
      const rec = Attendance.findRow_(Attendance.readAll_(), user.email, date);
      if (!rec) throw new Error('You have not checked in today.');
      if (rec.check_out) throw new Error('You have already checked out today (' + rec.check_out.slice(11, 16) + ').');

      const cell = getDb_().getSheetByName('Attendance')
        .getRange(rec.rowIndex, columnMap_('Attendance').check_out);
      cell.setNumberFormat('@');
      cell.setValue(now);
      return { check_out: now, duration: Attendance.durationText_(rec.check_in, now) };
    });
  },

  /** The caller's own recent days, newest first. */
  history: function (user) {
    const today = Attendance.today_();
    return Attendance.readAll_()
      .filter(function (r) { return r.staff_email === user.email; })
      .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); })
      .slice(0, Attendance.HISTORY_ROWS)
      .map(function (r) {
        return {
          date: r.date, work_mode: r.work_mode, check_in: r.check_in, check_out: r.check_out,
          duration: r.check_out ? Attendance.durationText_(r.check_in, r.check_out) : '',
          status: r.check_out ? 'Complete' : (r.date < today ? 'No check-out' : 'In progress')
        };
      });
  },

  // ---- Lead and Admin view ----

  /** Who has checked in on a day (default today), within the caller's scope. */
  team: function (user, date) {
    const today = Attendance.today_();
    date = Attendance.clean_(date) || today;
    if (!isIsoDate_(date)) throw new Error('Choose a valid date.');
    if (date > today) throw new Error('Choose today or an earlier date.');

    const visible = visibleStaffEmails_(user); // null = Admin, everyone
    const byEmail = {};
    Attendance.readAll_().forEach(function (r) {
      if (r.date === date) byEmail[r.staff_email] = r;
    });

    const rows = StaffDirectory.readAll_()
      .filter(function (s) {
        return s.status === 'Active' && (visible === null || visible.indexOf(s.email) !== -1);
      })
      .map(function (s) {
        const r = byEmail[s.email];
        let status = 'Not checked in';
        if (r) status = r.check_out ? 'Checked out' : (date < today ? 'No check-out' : 'Checked in');
        return {
          name: s.full_name, email: s.email, department: s.department, status: status,
          work_mode: r ? r.work_mode : '', check_in: r ? r.check_in : '',
          check_out: r ? r.check_out : '',
          duration: r && r.check_out ? Attendance.durationText_(r.check_in, r.check_out) : ''
        };
      })
      .sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

    return {
      date: date,
      present: rows.filter(function (r) { return r.status !== 'Not checked in'; }).length,
      total: rows.length,
      rows: rows
    };
  }
};

// ---- Functions callable from the browser (google.script.run) ----
// Each one re-checks the caller on the server. The UI is never trusted.

function attendanceToday() {
  return Attendance.today(requireUser_());
}

function attendanceCheckIn(workMode) {
  return Attendance.checkIn(requireUser_(), workMode);
}

function attendanceCheckOut() {
  return Attendance.checkOut(requireUser_());
}

function attendanceHistory() {
  return Attendance.history(requireUser_());
}

function attendanceTeam(date) {
  return Attendance.team(requireLeadOrAdmin_(), date);
}
