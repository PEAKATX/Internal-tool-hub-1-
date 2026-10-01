/**
 * Reports.gs
 * Weekly reports (Sections 5.3, 6.2-6.5): a submission form, a history of
 * reports filed and missed, team compliance and blockers for Leads and
 * Admins, and the Friday reminder email.
 *
 * Rules, enforced here on the server:
 *   - A report is always filed as the signed-in user. The browser never
 *     supplies who is submitting.
 *   - One report per person per week ending. Reports are not edited or
 *     deleted after submission (Section 8, Auditability).
 *   - A "week ending" is a Friday. Monday to Friday belong to that week's
 *     Friday. Saturday and Sunday still belong to the Friday just gone, so
 *     the weekend counts as a grace period, and Monday starts a new week.
 *   - Late reports are allowed for recent weeks (Config: report_history_weeks,
 *     default 8). A week only shows as Missed once its weekend has passed.
 *   - Everyone with an active Staff record is expected to report, from the
 *     first Friday on or after their start date.
 */

const Reports = {

  DEFAULT_HISTORY_WEEKS: 8,
  MAX_HOURS: 168,
  MAX_TEXT: 5000,

  // Written as plain text so dates stay yyyy-MM-dd strings and free text that
  // starts with "=" is stored as text instead of being run as a formula.
  TEXT_COLUMNS_: ['week_ending', 'work_completed', 'blockers', 'next_week_plan', 'submitted_at'],

  // Blocker answers that mean "nothing to report".
  NO_BLOCKER_: ['', 'none', 'n/a', 'na', 'no', 'nil', '-', 'no blockers', 'none.'],

  clean_: function (v) {
    return String(v === undefined || v === null ? '' : v).trim();
  },

  isActive_: function (v) {
    return !(v === false || String(v).toLowerCase() === 'false');
  },

  nowStamp_: function () {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  },

  // ---- date helpers (all dates are yyyy-MM-dd strings) ----

  utc_: function (iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  },

  addDays_: function (iso, n) {
    const d = Reports.utc_(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  },

  /** The Friday a report filed on this date belongs to (see header). */
  weekEndingFor_: function (iso) {
    const dow = Reports.utc_(iso).getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 6) return Reports.addDays_(iso, -1);
    if (dow === 0) return Reports.addDays_(iso, -2);
    return Reports.addDays_(iso, 5 - dow);
  },

  /** First Friday on or after a date: the first week someone is expected to report. */
  firstFridayOnOrAfter_: function (iso) {
    const dow = Reports.utc_(iso).getUTCDay();
    return Reports.addDays_(iso, (5 - dow + 7) % 7);
  },

  currentWeekEnding_: function () {
    return Reports.weekEndingFor_(todayIso_());
  },

  historyWeeks_: function () {
    const n = parseInt(configValues_('report_history_weeks')[0], 10);
    return n > 0 && n <= 52 ? n : Reports.DEFAULT_HISTORY_WEEKS;
  },

  /** Week endings a person can file for, newest first (current week back N weeks, not before they started). */
  windowFor_: function (startDate) {
    const current = Reports.currentWeekEnding_();
    const first = isIsoDate_(startDate) ? Reports.firstFridayOnOrAfter_(startDate) : '0000-00-00';
    const weeks = [];
    for (let i = 0; i < Reports.historyWeeks_(); i++) {
      const w = Reports.addDays_(current, -7 * i);
      if (w >= first) weeks.push(w);
    }
    return weeks;
  },

  // ---- reading ----

  /** Stops with a clear message if the Reports headers do not match SCHEMA. */
  checkHeaders_: function (sheet) {
    const want = SCHEMA.Reports;
    const have = sheet.getRange(1, 1, 1, want.length).getValues()[0];
    for (let i = 0; i < want.length; i++) {
      if (have[i] !== want[i]) {
        throw new Error('The Reports tab headers are out of date (expected "' + want[i] +
          '" in column ' + (i + 1) + '). Run setupSheets() once, then reload.');
      }
    }
  },

  /** Every active Reports row as a plain object. */
  readAll_: function () {
    const ss = getDb_();
    const sheet = ss.getSheetByName('Reports');
    Reports.checkHeaders_(sheet);
    const tz = ss.getSpreadsheetTimeZone(); // dates in cells belong to the sheet's zone
    return sheet.getDataRange().getValues().slice(1).map(function (row, i) {
      const rec = { rowIndex: i + 2 };
      SCHEMA.Reports.forEach(function (name, c) {
        let v = row[c];
        if (v instanceof Date) {
          v = Utilities.formatDate(v, tz, name === 'week_ending' ? 'yyyy-MM-dd' : 'yyyy-MM-dd HH:mm');
        }
        rec[name] = v === undefined || v === null ? '' : v;
      });
      rec.staff_email = Reports.clean_(rec.staff_email).toLowerCase();
      rec.week_ending = Reports.clean_(rec.week_ending);
      rec.active = Reports.isActive_(rec.active);
      return rec;
    }).filter(function (rec) {
      return Reports.clean_(rec.report_id) !== '' && rec.active;
    });
  },

  /** Active staff who are expected to have reported for a given week ending. */
  expectedStaff_: function (weekEnding) {
    return StaffDirectory.readAll_().filter(function (s) {
      if (s.status !== 'Active') return false;
      return !isIsoDate_(s.start_date) || Reports.firstFridayOnOrAfter_(s.start_date) <= weekEnding;
    });
  },

  staffRecord_: function (email) {
    return StaffDirectory.readAll_().filter(function (s) { return s.email === email; })[0];
  },

  // ---- the signed-in person's own view ----

  /** Pre-filled form details and the weeks they can still file for. */
  form: function (user) {
    const me = Reports.staffRecord_(user.email) || {};
    const filed = {};
    Reports.readAll_().forEach(function (r) {
      if (r.staff_email === user.email) filed[r.week_ending] = true;
    });
    const open = Reports.windowFor_(me.start_date).filter(function (w) { return !filed[w]; });
    return {
      full_name: user.fullName,
      email: user.email,
      role: user.role,
      department: user.department,
      current_week_ending: Reports.currentWeekEnding_(),
      open_weeks: open
    };
  },

  /** The last N weeks, each Filed, Missed or Due, newest first. */
  history: function (user) {
    const me = Reports.staffRecord_(user.email) || {};
    const current = Reports.currentWeekEnding_();
    const mine = {};
    Reports.readAll_().forEach(function (r) {
      if (r.staff_email === user.email) mine[r.week_ending] = r;
    });
    return Reports.windowFor_(me.start_date).map(function (w) {
      const r = mine[w];
      if (r) {
        return {
          week_ending: w, status: 'Filed', hours_worked: r.hours_worked,
          submitted_at: r.submitted_at, work_completed: r.work_completed,
          blockers: r.blockers, next_week_plan: r.next_week_plan
        };
      }
      return { week_ending: w, status: w >= current ? 'Due' : 'Missed' };
    });
  },

  /** Validates the form and appends the report, always as the signed-in user. */
  submit: function (user, data) {
    data = data || {};
    const clean = Reports.clean_;
    const weekEnding = clean(data.week_ending);
    const work = clean(data.work_completed);
    const blockers = clean(data.blockers);
    const plan = clean(data.next_week_plan);
    const hoursText = clean(data.hours_worked);
    const hours = hoursText === '' ? NaN : Number(hoursText);

    if (!work) throw new Error('Describe the work you completed.');
    if (!plan) throw new Error("Add your plan for next week.");
    if (!isFinite(hours) || hours < 0 || hours > Reports.MAX_HOURS) {
      throw new Error('Hours worked must be a number between 0 and ' + Reports.MAX_HOURS + '.');
    }
    [work, blockers, plan].forEach(function (text) {
      if (text.length > Reports.MAX_TEXT) {
        throw new Error('Each answer must be under ' + Reports.MAX_TEXT + ' characters.');
      }
    });

    return withLock_(function () {
      const me = Reports.staffRecord_(user.email) || {};
      if (Reports.windowFor_(me.start_date).indexOf(weekEnding) === -1) {
        throw new Error('Choose a week ending from the list.');
      }
      const all = Reports.readAll_(); // inside the lock so ids and duplicates cannot clash
      const dup = all.filter(function (r) {
        return r.staff_email === user.email && r.week_ending === weekEnding;
      })[0];
      if (dup) throw new Error('You have already filed a report for the week ending ' + weekEnding + '.');

      let max = 0;
      all.forEach(function (r) {
        const m = /^RPT-(\d+)$/.exec(String(r.report_id));
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      const reportId = 'RPT-' + String(max + 1).padStart(4, '0');

      const sheet = getDb_().getSheetByName('Reports');
      Reports.writeRow_(sheet, sheet.getLastRow() + 1, {
        report_id: reportId, staff_email: user.email, week_ending: weekEnding,
        work_completed: work, blockers: blockers, next_week_plan: plan,
        hours_worked: hours, submitted_at: Reports.nowStamp_(), active: true
      });
      return { report_id: reportId, week_ending: weekEnding };
    });
  },

  /** Writes a whole new row, keeping text columns as plain text. */
  writeRow_: function (sheet, rowNumber, record) {
    const cols = columnMap_('Reports');
    Reports.TEXT_COLUMNS_.forEach(function (name) {
      sheet.getRange(rowNumber, cols[name]).setNumberFormat('@');
    });
    const row = SCHEMA.Reports.map(function (name) { return record[name]; });
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  },

  // ---- Lead and Admin views ----

  /** Who has and has not filed for the current week, within the caller's scope. */
  compliance: function (user) {
    const week = Reports.currentWeekEnding_();
    const visible = visibleStaffEmails_(user); // null = Admin, everyone
    const filed = {};
    Reports.readAll_().forEach(function (r) {
      if (r.week_ending === week) filed[r.staff_email] = r;
    });
    const rows = Reports.expectedStaff_(week)
      .filter(function (s) { return visible === null || visible.indexOf(s.email) !== -1; })
      .map(function (s) {
        const r = filed[s.email];
        return {
          email: s.email, name: s.full_name, department: s.department,
          submitted: !!r, submitted_at: r ? r.submitted_at : ''
        };
      });
    rows.sort(function (a, b) {
      if (a.submitted !== b.submitted) return a.submitted ? 1 : -1;
      return a.name < b.name ? -1 : 1;
    });
    return {
      week_ending: week,
      submitted_count: rows.filter(function (r) { return r.submitted; }).length,
      total: rows.length,
      rows: rows
    };
  },

  /**
   * Blockers from each person's most recent report, in one list. Leads see
   * their direct reports; Admins see everyone. Never the caller's own.
   * An answer like "none" or "n/a" is not a blocker.
   */
  blockers: function (user) {
    const visible = visibleStaffEmails_(user);
    const names = {};
    StaffDirectory.readAll_().forEach(function (s) { names[s.email] = s.full_name; });

    const latest = {};
    Reports.readAll_().forEach(function (r) {
      const cur = latest[r.staff_email];
      if (!cur || r.week_ending > cur.week_ending ||
          (r.week_ending === cur.week_ending && String(r.submitted_at) > String(cur.submitted_at))) {
        latest[r.staff_email] = r;
      }
    });

    return Object.keys(latest)
      .filter(function (email) {
        return email !== user.email && (visible === null || visible.indexOf(email) !== -1);
      })
      .map(function (email) { return latest[email]; })
      .filter(function (r) {
        return Reports.NO_BLOCKER_.indexOf(Reports.clean_(r.blockers).toLowerCase()) === -1;
      })
      .map(function (r) {
        return { name: names[r.staff_email] || r.staff_email, email: r.staff_email,
                 week_ending: r.week_ending, blockers: r.blockers };
      })
      .sort(function (a, b) { return a.week_ending < b.week_ending ? 1 : -1; });
  },

  /** Friday reminder: one email to each expected person who has not filed this week. */
  sendReminders: function () {
    const week = Reports.currentWeekEnding_();
    const filed = {};
    Reports.readAll_().forEach(function (r) {
      if (r.week_ending === week) filed[r.staff_email] = true;
    });
    let link = '';
    try { link = ScriptApp.getService().getUrl() || ''; } catch (e) { /* no web app URL yet */ }

    let sent = 0;
    Reports.expectedStaff_(week).forEach(function (s) {
      if (filed[s.email]) return;
      const body = [
        'Hello ' + s.full_name + ',',
        '',
        'You have not yet filed your weekly report for the week ending ' + week + '.',
        'It takes about three minutes.',
        link ? '\nFile it here: ' + link : ''
      ].join('\n');
      try {
        sendMail_(s.email, 'Reminder: weekly report for the week ending ' + week, body);
        sent++;
      } catch (e) {
        Logger.log('Reminder failed for ' + s.email + ': ' + e);
      }
    });
    return sent;
  }
};

// ---- Functions callable from the browser (google.script.run) ----
// Each one re-checks the caller on the server. The UI is never trusted.

function reportsForm() {
  return Reports.form(requireUser_());
}

function reportsHistory() {
  return Reports.history(requireUser_());
}

function reportsSubmit(data) {
  return Reports.submit(requireUser_(), data);
}

function reportsCompliance() {
  return Reports.compliance(requireLeadOrAdmin_());
}

function reportsBlockers() {
  return Reports.blockers(requireLeadOrAdmin_());
}
