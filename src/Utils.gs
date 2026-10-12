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
  // Outside prod, mail goes to the developer, never to the real recipient.
  // getActiveUser() is empty inside time-driven triggers, so fall back to
  // the script owner (effective user) rather than to the real address.
  const target = isProd_()
    ? toEmail
    : (Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail());

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

/**
 * True only for a real calendar date written yyyy-MM-dd. new Date() alone
 * is not enough: V8 quietly accepts "2026-02-31" and rolls it to March 3.
 */
function isIsoDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Writes a value into one cell so that text stays text. setValue() and
 * setValues() evaluate a string that starts with "=" as a formula even in a
 * cell formatted as plain text (tested in Sheets: "=1+1" became 2). Rich text
 * is never evaluated, so every string goes through it. Numbers and booleans
 * are written normally. Use this for any value a person can type.
 */
function setCellSafe_(range, value) {
  if (typeof value === 'string') {
    range.setNumberFormat('@');
    range.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(value).build());
  } else {
    range.setValue(value === undefined ? '' : value);
  }
}

/**
 * Writes one whole row, in header order, with every string stored as
 * literal text (see setCellSafe_). `record` is keyed by column name.
 */
function writeRowSafe_(sheet, rowNumber, headers, record) {
  const plain = headers.map(function (name) {
    const v = record[name];
    return (typeof v === 'string' || v === undefined || v === null) ? '' : v;
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([plain]);
  headers.forEach(function (name, i) {
    const v = record[name];
    if (typeof v === 'string' && v !== '') {
      setCellSafe_(sheet.getRange(rowNumber, i + 1), v);
    } else if (typeof v === 'string') {
      sheet.getRange(rowNumber, i + 1).setNumberFormat('@');
    }
  });
}
