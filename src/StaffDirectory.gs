/**
 * StaffDirectory.gs
 * View, add and deactivate staff records (Section 6.4, Staff directory).
 *
 * Access rules, enforced here on the server:
 *   - Admin: sees every record (active and inactive), can add and deactivate.
 *   - Lead:  sees active records for themself and their direct reports.
 *   - Staff: sees only their own record.
 * Records are never deleted, only set to status = 'Inactive' (Section 8).
 *
 * google.script.run can only call top-level functions, so the logic lives
 * in the StaffDirectory object and the wrappers at the bottom expose it.
 */

const StaffDirectory = {

  // Used only when the Config tab has no rows for that category yet.
  DEFAULT_ACCESS_LEVELS: ['Staff', 'Lead', 'Admin'],
  DEFAULT_EMPLOYMENT_TYPES: ['Full time', 'Part time', 'Volunteer', 'Intern'],

  /** Dropdown values for the add form. Read from the Config tab. */
  options: function () {
    const pick = function (category, fallback) {
      const values = configValues_(category);
      return values.length ? values : fallback;
    };
    return {
      departments: configValues_('department'),
      accessLevels: pick('access_level', StaffDirectory.DEFAULT_ACCESS_LEVELS),
      employmentTypes: pick('employment_type', StaffDirectory.DEFAULT_EMPLOYMENT_TYPES)
    };
  },

  /** Every Staff row as a plain object, plus its sheet row number. */
  readAll_: function () {
    const sheet = getDb_().getSheetByName('Staff');
    const values = sheet.getDataRange().getValues();
    const headers = SCHEMA.Staff;
    const tz = Session.getScriptTimeZone();
    return values.slice(1).map(function (row, i) {
      const rec = { rowIndex: i + 2 };
      headers.forEach(function (name, c) {
        let v = row[c];
        // Date objects cannot be returned to the browser, so send text.
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        rec[name] = v;
      });
      rec.email = String(rec.email).toLowerCase().trim();
      return rec;
    }).filter(function (rec) { return rec.email !== ''; });
  },

  /** Records the caller is allowed to see. */
  list: function (user) {
    const visible = visibleStaffEmails_(user); // null means Admin, no filter
    return StaffDirectory.readAll_().filter(function (rec) {
      if (visible === null) return true;
      return rec.status === 'Active' && visible.indexOf(rec.email) !== -1;
    });
  },

  /** Validates the form input and appends a new Active record. */
  add: function (user, data) {
    if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
    data = data || {};
    const opts = StaffDirectory.options();
    const clean = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };

    const fullName = clean(data.full_name);
    const email = clean(data.email).toLowerCase();
    const role = clean(data.role);
    const department = clean(data.department);
    const reportsTo = clean(data.reports_to).toLowerCase();
    const accessLevel = clean(data.access_level);
    const employmentType = clean(data.employment_type);
    const startDate = clean(data.start_date) || todayIso_();

    if (!fullName) throw new Error('Full name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
    if (!role) throw new Error('Role is required.');
    if (opts.departments.indexOf(department) === -1) throw new Error('Choose a department from the list.');
    if (opts.accessLevels.indexOf(accessLevel) === -1) throw new Error('Choose an access level from the list.');
    if (opts.employmentTypes.indexOf(employmentType) === -1) throw new Error('Choose an employment type from the list.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || isNaN(new Date(startDate).getTime())) {
      throw new Error('Start date must be a valid date.');
    }

    return withLock_(function () {
      // Read inside the lock so two admins adding at once cannot clash.
      const all = StaffDirectory.readAll_();

      const existing = all.filter(function (r) { return r.email === email; })[0];
      if (existing) {
        throw new Error(existing.status === 'Active'
          ? 'A staff record with this email already exists.'
          : 'This email belongs to an inactive record. Set its status back to Active in the Sheet instead of adding a duplicate.');
      }
      if (reportsTo) {
        const manager = all.filter(function (r) { return r.email === reportsTo && r.status === 'Active'; })[0];
        if (!manager) throw new Error('"Reports to" must be the email of an active staff member.');
      }

      // Next ID = highest existing number + 1, so gaps never cause a repeat.
      let max = 0;
      all.forEach(function (r) {
        const m = /^ATX-(\d+)$/.exec(String(r.staff_id));
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      const staffId = 'ATX-' + String(max + 1).padStart(3, '0');

      const record = {
        staff_id: staffId, full_name: fullName, email: email, role: role,
        department: department, reports_to: reportsTo, access_level: accessLevel,
        employment_type: employmentType, start_date: startDate, status: 'Active'
      };
      const row = SCHEMA.Staff.map(function (name) { return record[name]; });
      getDb_().getSheetByName('Staff').appendRow(row);
      return { staff_id: staffId, email: email };
    });
  },

  /** Marks a record Inactive. Never deletes the row. */
  deactivate: function (user, email) {
    if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
    email = String(email || '').toLowerCase().trim();
    if (email === user.email) throw new Error('You cannot deactivate your own account.');

    return withLock_(function () {
      const all = StaffDirectory.readAll_();
      const target = all.filter(function (r) { return r.email === email; })[0];
      if (!target) throw new Error('No staff record found for ' + email + '.');
      if (target.status !== 'Active') throw new Error('This record is already inactive.');

      if (target.access_level === 'Admin') {
        const activeAdmins = all.filter(function (r) {
          return r.status === 'Active' && r.access_level === 'Admin';
        });
        if (activeAdmins.length <= 1) throw new Error('You cannot deactivate the last active Admin.');
      }

      const col = columnMap_('Staff').status;
      getDb_().getSheetByName('Staff').getRange(target.rowIndex, col).setValue('Inactive');
      return { email: email, status: 'Inactive' };
    });
  }
};

// ---- Functions callable from the browser (google.script.run) ----
// Each one re-checks the caller on the server. The UI is never trusted.

function staffDirectoryList() {
  return StaffDirectory.list(requireUser_());
}

function staffDirectoryOptions() {
  requireAdmin_();
  return StaffDirectory.options();
}

function staffDirectoryAdd(data) {
  return StaffDirectory.add(requireAdmin_(), data);
}

function staffDirectoryDeactivate(email) {
  return StaffDirectory.deactivate(requireAdmin_(), email);
}
