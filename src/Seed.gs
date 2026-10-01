/**
 * Seed.gs
 * Fills a dev Sheet with fake data so you can test every access level
 * without needing real staff accounts. Refuses to run against prod.
 *
 * Usage on a fresh dev environment:
 *   1. Set Script Properties (SHEET_ID, ENV=dev, ...)
 *   2. Run setupSheets()
 *   3. Run seedDummyData()
 *   4. Set EMAIL_OVERRIDE to one of the seeded emails below to test as
 *      that access level (see Auth.gs)
 */

function seedDummyData() {
  if (isProd_()) {
    throw new Error('Refusing to seed dummy data into a prod environment.');
  }

  const ss = getDb_();
  seedStaff_(ss);
  seedConfig_(ss);
  seedTasks_(ss);
  seedReports_(ss);
  seedAttendance_(ss);
  Logger.log('Dummy data seeded.');
}

/**
 * Sample attendance, relative to today:
 *   Leo: checked in and out yesterday; checked in this morning (still in).
 *   Sam: checked in yesterday and never checked out (shows "No check-out");
 *        nothing today, so the check-in button is available to test.
 * Skipped if the Attendance tab already has data.
 */
function seedAttendance_(ss) {
  const sheet = ss.getSheetByName('Attendance');
  if (sheet.getLastRow() > 1) return;

  const today = Attendance.today_();
  const yesterday = Reports.addDays_(today, -1);
  const samples = [
    { staff_email: 'lead@example.org', date: yesterday, check_in: yesterday + ' 09:02:11',
      check_out: yesterday + ' 17:30:45', work_mode: 'Office' },
    { staff_email: 'staff@example.org', date: yesterday, check_in: yesterday + ' 09:30:00',
      check_out: '', work_mode: 'Remote' },
    { staff_email: 'lead@example.org', date: today, check_in: today + ' 08:55:20',
      check_out: '', work_mode: 'Office' }
  ];
  samples.forEach(function (s, i) {
    s.attendance_id = 'ATT-' + String(i + 1).padStart(5, '0');
    s.active = true;
    Attendance.writeRow_(sheet, 2 + i, s);
  });
}

/**
 * Sample reports, relative to today so they stay current:
 *   Leo filed this week and last week (no blockers).
 *   Sam filed last week with a blocker, nothing for this week or the week
 *   before, so his history shows one Filed, one Missed and one Due.
 * Skipped if the Reports tab already has data.
 */
function seedReports_(ss) {
  const sheet = ss.getSheetByName('Reports');
  if (sheet.getLastRow() > 1) return;

  const cur = Reports.currentWeekEnding_();
  const prev = Reports.addDays_(cur, -7);
  const stamp = Reports.nowStamp_();
  const samples = [
    { staff_email: 'lead@example.org', week_ending: prev, hours_worked: 40,
      work_completed: 'Reviewed pull requests and planned the sprint.',
      blockers: 'None', next_week_plan: 'Start the reporting module.' },
    { staff_email: 'lead@example.org', week_ending: cur, hours_worked: 41,
      work_completed: 'Shipped the staff directory.',
      blockers: 'None', next_week_plan: 'Mentor the new intern.' },
    { staff_email: 'staff@example.org', week_ending: prev, hours_worked: 38,
      work_completed: 'Drafted the onboarding checklist.',
      blockers: 'Waiting on access to the shared drive.', next_week_plan: 'Finish the checklist.' }
  ];
  samples.forEach(function (s, i) {
    s.report_id = 'RPT-' + String(i + 1).padStart(4, '0');
    s.submitted_at = stamp;
    s.active = true;
    Reports.writeRow_(sheet, 2 + i, s);
  });
}

/** Today plus/minus n days, as yyyy-MM-dd in the script's time zone. */
function isoOffset_(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Three sample tasks: one due soon, one overdue, one already completed.
 * Dates are relative to today, so the overdue one is always overdue.
 * Skipped if the Tasks tab already has data.
 */
function seedTasks_(ss) {
  const sheet = ss.getSheetByName('Tasks');
  if (sheet.getLastRow() > 1) return;

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const samples = [
    { task_id: 'TSK-0001', title: 'Set up onboarding checklist', description: 'Draft the checklist new interns follow in week one.',
      assignee_email: 'staff@example.org', assigned_by: 'lead@example.org', department: 'Engineering',
      priority: 'High', status: 'In progress', due_date: isoOffset_(3), created_date: isoOffset_(-4) },
    { task_id: 'TSK-0002', title: 'Draft weekly update template', description: 'One page, plain language.',
      assignee_email: 'staff@example.org', assigned_by: 'lead@example.org', department: 'Engineering',
      priority: 'Medium', status: 'Not started', due_date: isoOffset_(-5), created_date: isoOffset_(-10) },
    { task_id: 'TSK-0003', title: 'Review programme plan', description: 'Comment on the Q4 plan.',
      assignee_email: 'lead@example.org', assigned_by: 'admin@example.org', department: 'Engineering',
      priority: 'Low', status: 'Completed', due_date: isoOffset_(-2), created_date: isoOffset_(-9),
      completed_date: isoOffset_(-3), completion_note: 'Reviewed, comments left in the doc.' }
  ];

  const cols = columnMap_('Tasks');
  samples.forEach(function (s, i) {
    s.linked_programme = '';
    s.active = true;
    s.completed_date = s.completed_date || '';
    s.completion_note = s.completion_note || '';
    s.updated_by = s.assigned_by;
    s.updated_at = stamp;
    const rowNumber = 2 + i;
    Tasks.TEXT_COLUMNS_.forEach(function (name) {
      sheet.getRange(rowNumber, cols[name]).setNumberFormat('@');
    });
    const row = SCHEMA.Tasks.map(function (name) { return s[name]; });
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  });
}

function seedStaff_(ss) {
  const sheet = ss.getSheetByName('Staff');
  if (sheet.getLastRow() > 1) return; // already seeded, don't duplicate

  const rows = [
    ['ATX-001', 'Ada Admin', 'admin@example.org', 'Programme Director', 'Operations', '', 'Admin', 'Full time', '2024-01-10', 'Active'],
    ['ATX-002', 'Leo Lead', 'lead@example.org', 'Engineering Lead', 'Engineering', 'admin@example.org', 'Lead', 'Full time', '2024-03-01', 'Active'],
    ['ATX-003', 'Sam Staff', 'staff@example.org', 'Software Intern', 'Engineering', 'lead@example.org', 'Staff', 'Intern', '2026-06-01', 'Active']
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

/**
 * Adds Config rows for any category that has none yet, so re-running this
 * on an already-seeded Sheet picks up newly added dropdowns (for example
 * `priority`) without duplicating or touching existing values.
 */
function seedConfig_(ss) {
  const sheet = ss.getSheetByName('Config');
  const existingCategories = {};
  sheet.getDataRange().getValues().slice(1).forEach(function (r) {
    existingCategories[r[0]] = true;
  });

  const all = [
    ['department', 'Programmes'],
    ['department', 'Engineering'],
    ['department', 'Finance'],
    ['department', 'Communications'],
    ['department', 'Operations'],
    ['task_status', 'Not started'],
    ['task_status', 'In progress'],
    ['task_status', 'Blocked'],
    ['task_status', 'Submitted'],
    ['task_status', 'Completed'],
    ['finance_category', 'Payroll'],
    ['finance_category', 'Stipends'],
    ['finance_category', 'Programme delivery'],
    ['finance_category', 'Equipment'],
    ['finance_category', 'Travel'],
    ['finance_category', 'Software'],
    ['finance_category', 'Other'],
    ['access_level', 'Staff'],
    ['access_level', 'Lead'],
    ['access_level', 'Admin'],
    ['employment_type', 'Full time'],
    ['employment_type', 'Part time'],
    ['employment_type', 'Volunteer'],
    ['employment_type', 'Intern'],
    ['priority', 'High'],
    ['priority', 'Medium'],
    ['priority', 'Low'],
    ['report_history_weeks', '8'],
    ['work_mode', 'Remote'],
    ['work_mode', 'Office'],
    ['work_mode', 'Field'],
    ['admin_email', 'admin@example.org']
  ];

  const rows = all.filter(function (r) { return !existingCategories[r[0]]; });
  if (!rows.length) return;
  // Write below the last row that has content (getLastRow ignores blanks).
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
}
