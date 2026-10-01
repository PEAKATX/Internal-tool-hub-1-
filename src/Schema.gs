/**
 * Schema.gs
 * Single source of truth for the data model (System Requirements, Section 5).
 * Column names here are normative — every module must read/write through
 * these names, never through hardcoded column indexes.
 *
 * KNOWN GAPS carried over from the requirements doc — flagged, not yet fixed.
 * Confirm the resolution with the team before changing column names, since
 * that means migrating any sheets already seeded from this file.
 *   1. Budget has no currency field; Finance allows NGN and USD. Decide:
 *      one currency per budget_line (validated on submit), or store a
 *      converted amount + rate.
 *   2. Programmes, Attendance and Budget have no unique ID column, but
 *      Tasks.linked_programme and Finance.budget_line need something to
 *      point at. Added programme_id / attendance_id / budget_id below as
 *      a starting proposal — confirm before relying on them.
 *   3. "Never hard-deleted" (Section 8, Auditability) only has a `status`
 *      column on Staff. Added `active` to every other table below so
 *      records can be marked inactive instead of deleted. Confirm.
 */

const SCHEMA = {
  Staff: [
    'staff_id', 'full_name', 'email', 'role', 'department', 'reports_to',
    'access_level', 'employment_type', 'start_date', 'status'
  ],
  Tasks: [
    'task_id', 'title', 'description', 'assignee_email', 'assigned_by',
    'department', 'linked_programme', 'priority', 'status', 'due_date',
    'created_date', 'completed_date', 'active',
    // Added for the Task module (not in Section 5.2 of the requirements):
    // the Staff view asks for a completion note, and Section 8 (Auditability)
    // asks for a user and timestamp on every record. Confirm with the team.
    'completion_note', 'updated_by', 'updated_at'
  ],
  Reports: [
    'report_id', 'staff_email', 'week_ending', 'work_completed', 'blockers',
    'next_week_plan', 'hours_worked', 'submitted_at', 'active'
  ],
  Attendance: [
    'attendance_id', 'staff_email', 'date', 'check_in', 'check_out',
    'work_mode', 'active'
  ],
  Finance: [
    'transaction_id', 'date', 'direction', 'category', 'description',
    'amount', 'currency', 'budget_line', 'grant_source', 'submitted_by',
    'approved_by', 'receipt_link', 'active'
  ],
  Budget: [
    'budget_id', 'budget_line', 'grant_source', 'period', 'allocated',
    'spent', 'remaining', 'burn_rate', 'active'
  ],
  Programmes: [
    'programme_id', 'programme', 'cohort', 'lead', 'status',
    'learner_count', 'milestone_dates', 'active'
  ],
  Config: [
    'category', 'value'
    // rows look like: ('department', 'Engineering'), ('access_level', 'Admin')
    // admin emails: ('admin_email', 'someone@org.example')
  ]
};

/**
 * Creates any missing tab and header row, and adds any columns that were
 * appended to SCHEMA since the tab was built. Safe to run repeatedly.
 * Run once per new environment (dev, prod), right after setting Script
 * Properties, and again after pulling a change that adds columns.
 *
 * It only ever fills in blank header cells at the END of a header row. If
 * an existing header differs from SCHEMA (renamed, reordered), it logs a
 * warning and leaves that tab alone, because rewriting it could scramble
 * live data.
 */
function setupSheets() {
  const ss = getDb_();
  Object.keys(SCHEMA).forEach(function (tabName) {
    let sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }
    const headers = SCHEMA[tabName];
    if (sheet.getMaxColumns() < headers.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    }
    const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];

    // How many leading headers already match SCHEMA exactly?
    let matched = 0;
    while (matched < headers.length && existing[matched] === headers[matched]) matched++;

    const restIsBlank = existing.slice(matched).every(function (cell) { return cell === ''; });
    if (!restIsBlank) {
      Logger.log('WARNING: header row of "' + tabName + '" does not match SCHEMA. Left unchanged.');
      return;
    }
    if (matched < headers.length) {
      sheet.getRange(1, matched + 1, 1, headers.length - matched)
        .setValues([headers.slice(matched)]);
      Logger.log(tabName + ': wrote ' + (headers.length - matched) + ' header(s).');
    }
    sheet.setFrozenRows(1);
  });
  // Remove the default first sheet Google adds to every new Spreadsheet,
  // if it's still there and empty.
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }
  Logger.log('setupSheets complete for ' + ss.getUrl());
}

/**
 * Returns the header-name -> column-index (1-based) map for a tab, so
 * every module reads columns by name, never by position.
 */
function columnMap_(tabName) {
  const headers = SCHEMA[tabName];
  if (!headers) throw new Error('Unknown tab: ' + tabName);
  const map = {};
  headers.forEach(function (name, i) { map[name] = i + 1; });
  return map;
}
