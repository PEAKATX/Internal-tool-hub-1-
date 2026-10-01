/**
 * Triggers.gs
 * Time-driven triggers (Section 6.5). `clasp push` does NOT install these —
 * run installTriggers() manually, once, per environment (staging/prod).
 * Running it twice would create duplicate triggers, so it clears existing
 * ones first.
 */

function installTriggers() {
  // Clear any triggers this project already owns, so re-running this
  // function is safe and doesn't stack duplicates.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('sendWeeklyReportReminders')
    .timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(9)
    .create();

  ScriptApp.newTrigger('sendMondayTaskSummaries')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8)
    .create();

  Logger.log('Triggers installed for env=' + getEnv_());
}

/** Friday reminder to anyone who hasn't submitted a report for the current week. */
function sendWeeklyReportReminders() {
  const sent = Reports.sendReminders();
  Logger.log('Weekly report reminders sent: ' + sent);
}

/** Monday summary of each staff member's open/overdue tasks. */
function sendMondayTaskSummaries() {
  const sent = Tasks.sendSummaries();
  Logger.log('Monday task summaries sent: ' + sent);
}
