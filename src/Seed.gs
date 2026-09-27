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
  Logger.log('Dummy data seeded.');
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

function seedConfig_(ss) {
  const sheet = ss.getSheetByName('Config');
  if (sheet.getLastRow() > 1) return;

  const rows = [
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
    ['admin_email', 'admin@example.org']
  ];
  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}
