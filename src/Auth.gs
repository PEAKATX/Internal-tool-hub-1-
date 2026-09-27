/**
 * Auth.gs
 * Server-side authentication and access control (Section 6.1, 8-Security).
 * Every module must call currentUser_() and check .accessLevel itself —
 * access is never assumed from the UI layer.
 */

/**
 * Returns the signed-in email. In dev, allows an EMAIL_OVERRIDE Script
 * Property so a developer can test as any Staff/Lead/Admin record without
 * needing multiple real Google identities. The override is ignored
 * outright in prod, no matter what is set.
 */
function currentUserEmail_() {
  if (!isProd_()) {
    const override = PropertiesService.getScriptProperties().getProperty('EMAIL_OVERRIDE');
    if (override) return override.toLowerCase().trim();
  }
  const email = Session.getActiveUser().getEmail();
  if (!email) throw new Error('Could not resolve signed-in user email.');
  return email.toLowerCase().trim();
}

/**
 * Looks up the caller in the Staff tab and returns their record, or null
 * if no active Staff record matches. This is the single gate described in
 * Section 6.1 — "If no active record exists, access is denied."
 */
function currentUser_() {
  const email = currentUserEmail_();
  const sheet = getDb_().getSheetByName('Staff');
  const rows = sheet.getDataRange().getValues();
  const map = columnMap_('Staff');
  const headerless = rows.slice(1);

  for (let i = 0; i < headerless.length; i++) {
    const row = headerless[i];
    if (String(row[map.email - 1]).toLowerCase().trim() === email) {
      if (row[map.status - 1] !== 'Active') return null;
      return {
        rowIndex: i + 2, // 1-based, +1 for header
        staffId: row[map.staff_id - 1],
        fullName: row[map.full_name - 1],
        email: email,
        role: row[map.role - 1],
        department: row[map.department - 1],
        reportsTo: row[map.reports_to - 1],
        accessLevel: row[map.access_level - 1], // 'Staff' | 'Lead' | 'Admin'
        employmentType: row[map.employment_type - 1]
      };
    }
  }
  return null;
}

/** Throws if there is no active Staff record for the caller. */
function requireUser_() {
  const user = currentUser_();
  if (!user) throw new Error('Access denied: no active Staff record for this account.');
  return user;
}

/** Throws unless the caller is Admin. */
function requireAdmin_() {
  const user = requireUser_();
  if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
  return user;
}

/** Throws unless the caller is Lead or Admin. */
function requireLeadOrAdmin_() {
  const user = requireUser_();
  if (user.accessLevel !== 'Lead' && user.accessLevel !== 'Admin') {
    throw new Error('Access denied: Lead or Admin only.');
  }
  return user;
}

/**
 * Returns the list of staff emails a Lead can see: themself plus anyone
 * whose reports_to matches their email. Admins should bypass this and see
 * everyone; Staff should be restricted to just their own email.
 */
function visibleStaffEmails_(user) {
  if (user.accessLevel === 'Admin') return null; // null == no filter, sees all
  if (user.accessLevel === 'Staff') return [user.email];

  const sheet = getDb_().getSheetByName('Staff');
  const rows = sheet.getDataRange().getValues();
  const map = columnMap_('Staff');
  const reports = rows.slice(1)
    .filter(function (row) {
      return String(row[map.reports_to - 1]).toLowerCase().trim() === user.email;
    })
    .map(function (row) { return String(row[map.email - 1]).toLowerCase().trim(); });

  return reports.concat([user.email]);
}
