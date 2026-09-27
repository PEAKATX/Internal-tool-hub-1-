/**
 * Utils.gs
 * Small helpers every module should route through, so dev testing never
 * emails real staff and concurrent sheet writes don't clobber each other.
 */

/**
 * Sends mail, redirected to the developer's own address in any non-prod
 * environment. Route ALL outbound mail through this — never call
 * MailApp/GmailApp directly from a feature module.
 */
function sendMail_(toEmail, subject, body) {
  const target = isProd_()
    ? toEmail
    : (Session.getActiveUser().getEmail() || toEmail);

  const finalSubject = isProd_() ? subject : '[DEV] ' + subject + ' (real recipient: ' + toEmail + ')';

  MailApp.sendEmail({
    to: target,
    subject: finalSubject,
    body: body
  });
}

/**
 * Runs fn() while holding the script lock, so simultaneous writes (e.g.
 * two staff checking in at once) don't interleave. Wrap any function that
 * appends or edits a row with this.
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Generates the next sequential ID for a tab, e.g. nextId_('Staff', 'ATX-') -> 'ATX-004' */
function nextId_(tabName, prefix, padding) {
  padding = padding || 3;
  const sheet = getDb_().getSheetByName(tabName);
  const lastRow = sheet.getLastRow();
  const n = lastRow <= 1 ? 1 : lastRow; // header row = 1
  return prefix + String(n).padStart(padding, '0');
}

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
