/**
 * Finance.gs
 * Expenses, approvals and budget tracking (Sections 5.5, 5.6, 6.2, 6.4, 6.5).
 *
 * Rules, enforced here on the server:
 *   - Anyone with an active Staff record can submit an expense (with a
 *     receipt) and see their OWN submissions and their status. Nothing else
 *     in Finance is visible to them, and they never see budget amounts.
 *   - Finance and Admin see every transaction and the budget dashboard.
 *     Finance and Admin can also record Income, which needs no approval.
 *   - Only an Admin approves, rejects or reverses. An Admin cannot decide
 *     their own submission, so a second Admin is needed for those.
 *   - Only Approved Expenditure counts towards `spent`. Income never does.
 *   - Approved transactions are never edited or deleted. A cancellation is a
 *     new, approved entry with a negative amount and `reversal_of` set.
 *   - Burn rate = spent / months elapsed. "Remaining per month" (remaining /
 *     months remaining) is a separate figure.
 *   - One currency per budget line. An expense must be in that currency.
 *   - Every string is written with setCellSafe_ / writeRowSafe_ so text that
 *     starts with "=" can never become a formula.
 */

const Finance = {

  CURRENCIES: ['NGN', 'USD'],
  DIRECTIONS: ['Income', 'Expenditure'],
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DEFAULT_CATEGORIES: ['Payroll', 'Stipends', 'Programme delivery', 'Equipment',
    'Travel', 'Software', 'Other'],

  MAX_RECEIPT_BYTES: 5 * 1024 * 1024,
  MAX_AMOUNT: 1000000000,
  MAX_TEXT: 500,
  LIST_LIMIT: 500,

  // Set to false only if the organisation really has a single approver.
  BLOCK_SELF_APPROVAL: true,

  RECEIPT_TYPES: {
    'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46] },
    'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4E, 0x47] },
    'image/jpeg': { ext: 'jpg', magic: [0xFF, 0xD8, 0xFF] }
  },

  // ---- small helpers ----

  clean_: function (v) {
    return String(v === undefined || v === null ? '' : v).trim();
  },

  isActive_: function (v) {
    return !(v === false || String(v).toLowerCase() === 'false');
  },

  nowStamp_: function () {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  },

  /** Money is summed as whole cents so 0.1 + 0.2 never drifts. */
  cents_: function (n) { return Math.round(n * 100); },
  fromCents_: function (c) { return c / 100; },
  round2_: function (n) { return Math.round(n * 100) / 100; },

  canSeeAll_: function (user) {
    return user.accessLevel === 'Finance' || user.accessLevel === 'Admin';
  },

  categories_: function () {
    const values = configValues_('finance_category');
    return values.length ? values : Finance.DEFAULT_CATEGORIES;
  },

  /** Stops with a clear message if a tab's headers are out of date. */
  checkHeaders_: function (sheet, tabName) {
    const want = SCHEMA[tabName];
    const have = sheet.getRange(1, 1, 1, want.length).getValues()[0];
    for (let i = 0; i < want.length; i++) {
      if (have[i] !== want[i]) {
        throw new Error('The ' + tabName + ' tab headers are out of date (expected "' + want[i] +
          '" in column ' + (i + 1) + '). Run setupSheets() once, then reload.');
      }
    }
  },

  // ---- reading ----

  /** Every Finance row as a plain object, plus its sheet row number. */
  readAll_: function () {
    const ss = getDb_();
    const sheet = ss.getSheetByName('Finance');
    Finance.checkHeaders_(sheet, 'Finance');
    const tz = ss.getSpreadsheetTimeZone();
    const stamps = { decided_at: true, submitted_at: true };
    const lower = { submitted_by: true, approved_by: true, decided_by: true };
    return sheet.getDataRange().getValues().slice(1).map(function (row, i) {
      const rec = { rowIndex: i + 2 };
      SCHEMA.Finance.forEach(function (name, c) {
        let v = row[c];
        if (v instanceof Date) {
          v = Utilities.formatDate(v, tz, stamps[name] ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
        }
        rec[name] = v === undefined || v === null ? '' : v;
      });
      SCHEMA.Finance.forEach(function (name) {
        if (typeof rec[name] === 'string') rec[name] = rec[name].trim();
      });
      Object.keys(lower).forEach(function (k) { rec[k] = String(rec[k]).toLowerCase(); });
      rec.currency = String(rec.currency).toUpperCase();
      rec.active = Finance.isActive_(rec.active);

      const amount = typeof rec.amount === 'number'
        ? rec.amount : Number(String(rec.amount).replace(/,/g, ''));
      rec.amount_ok = rec.amount !== '' && isFinite(amount);
      rec.amount = rec.amount_ok ? amount : 0;

      // Rows migrated from older trackers have no status yet: an approver
      // means Approved, no approver means Pending.
      const known = [Finance.PENDING, Finance.APPROVED, Finance.REJECTED].filter(function (s) {
        return s.toLowerCase() === String(rec.status).toLowerCase();
      })[0];
      rec.status = known || (rec.approved_by ? Finance.APPROVED : Finance.PENDING);
      return rec;
    }).filter(function (rec) { return rec.transaction_id !== ''; });
  },

  /** Every Budget row as a plain object, plus its sheet row number. */
  readBudgets_: function () {
    const ss = getDb_();
    const sheet = ss.getSheetByName('Budget');
    Finance.checkHeaders_(sheet, 'Budget');
    const tz = ss.getSpreadsheetTimeZone();
    return sheet.getDataRange().getValues().slice(1).map(function (row, i) {
      const rec = { rowIndex: i + 2 };
      SCHEMA.Budget.forEach(function (name, c) {
        let v = row[c];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        rec[name] = v === undefined || v === null ? '' : v;
      });
      ['budget_id', 'budget_line', 'grant_source', 'period', 'period_start', 'period_end']
        .forEach(function (k) { rec[k] = String(rec[k]).trim(); });
      rec.currency = String(rec.currency).trim().toUpperCase();
      rec.active = Finance.isActive_(rec.active);
      const allocated = Number(String(rec.allocated).replace(/,/g, ''));
      rec.allocated = isFinite(allocated) ? allocated : 0;
      return rec;
    }).filter(function (rec) { return rec.budget_line !== ''; });
  },

  // ---- budget maths (pure: no sheet access, so it is easy to test) ----

  monthIndex_: function (iso) {
    return parseInt(iso.slice(0, 4), 10) * 12 + parseInt(iso.slice(5, 7), 10) - 1;
  },

  /** { start, end } as yyyy-MM-dd, or null when the period cannot be worked out. */
  periodDates_: function (b) {
    if (isIsoDate_(b.period_start) && isIsoDate_(b.period_end) && b.period_start <= b.period_end) {
      return { start: b.period_start, end: b.period_end };
    }
    if (!b.period_start && !b.period_end && /^\d{4}$/.test(b.period)) {
      return { start: b.period + '-01-01', end: b.period + '-12-31' };
    }
    return null;
  },

  /**
   * Months elapsed counts calendar months from the period start through the
   * current month, inclusive, capped to the period. Months remaining is the
   * rest of the period.
   */
  months_: function (period, today) {
    const total = Finance.monthIndex_(period.end) - Finance.monthIndex_(period.start) + 1;
    const raw = Finance.monthIndex_(today) - Finance.monthIndex_(period.start) + 1;
    const elapsed = Math.max(0, Math.min(total, raw));
    return { total: total, elapsed: elapsed, remaining: total - elapsed };
  },

  /**
   * Figures per budget line and per grant from the raw rows.
   * Only Approved Expenditure in the line's own currency counts as spent.
   */
  compute_: function (budgets, txns, today) {
    const live = txns.filter(function (t) { return t.active; });
    const known = {};
    budgets.forEach(function (b) { if (b.active) known[b.budget_line] = true; });

    const lines = budgets.filter(function (b) { return b.active; }).map(function (b) {
      const warnings = [];
      let spent = 0, pending = 0, mismatched = 0;
      live.forEach(function (t) {
        if (t.budget_line !== b.budget_line || t.direction !== 'Expenditure') return;
        if (!t.amount_ok) { warnings.push(t.transaction_id + ' has an amount that is not a number.'); return; }
        if (t.currency !== b.currency) { mismatched++; return; }
        if (t.status === Finance.APPROVED) spent += Finance.cents_(t.amount);
        else if (t.status === Finance.PENDING) pending += Finance.cents_(t.amount);
      });
      if (!b.currency) warnings.push('No currency is set for this budget line.');
      else if (Finance.CURRENCIES.indexOf(b.currency) === -1) warnings.push('Currency must be NGN or USD.');
      if (mismatched) warnings.push(mismatched + ' transaction(s) are in a different currency and are not counted.');

      const period = Finance.periodDates_(b);
      const m = period ? Finance.months_(period, today) : null;
      if (!period) warnings.push('Set period_start and period_end (or a four-digit year as the period).');

      const spentAmt = Finance.fromCents_(spent);
      const remaining = Finance.round2_(b.allocated - spentAmt);
      return {
        budget_id: b.budget_id, budget_line: b.budget_line, grant_source: b.grant_source,
        period: b.period, currency: b.currency,
        period_start: period ? period.start : '', period_end: period ? period.end : '',
        allocated: b.allocated, spent: spentAmt, remaining: remaining,
        burn_rate: m ? (m.elapsed > 0 ? Finance.round2_(spentAmt / m.elapsed) : 0) : null,
        months_total: m ? m.total : null,
        months_elapsed: m ? m.elapsed : null,
        months_remaining: m ? m.remaining : null,
        remaining_per_month: m && m.remaining > 0 ? Finance.round2_(remaining / m.remaining) : null,
        remaining_pct: b.allocated > 0 ? remaining / b.allocated : null,
        pending: Finance.fromCents_(pending),
        warnings: warnings, rowIndex: b.rowIndex
      };
    });

    const unmatched = live.filter(function (t) { return !known[t.budget_line]; })
      .map(function (t) { return t.transaction_id; });

    // Per grant (and currency, so NGN and USD are never added together).
    const grants = {};
    const grantOf = function (name, currency) {
      const key = name + '|' + currency;
      if (!grants[key]) {
        grants[key] = { grant_source: name, currency: currency, allocated: 0, spent: 0,
          remaining: 0, burn_rate: 0, funds_received: 0, lines: 0 };
      }
      return grants[key];
    };
    lines.forEach(function (l) {
      const g = grantOf(l.grant_source, l.currency);
      g.allocated = Finance.round2_(g.allocated + l.allocated);
      g.spent = Finance.round2_(g.spent + l.spent);
      g.remaining = Finance.round2_(g.remaining + l.remaining);
      g.burn_rate = Finance.round2_(g.burn_rate + (l.burn_rate || 0));
      g.lines++;
    });
    const income = {};
    live.forEach(function (t) {
      if (t.direction !== 'Income' || t.status !== Finance.APPROVED || !t.amount_ok || !t.grant_source) return;
      const key = t.grant_source + '|' + t.currency;
      income[key] = (income[key] || 0) + Finance.cents_(t.amount);
      grantOf(t.grant_source, t.currency);
    });
    Object.keys(income).forEach(function (key) {
      grants[key].funds_received = Finance.fromCents_(income[key]);
    });

    return {
      lines: lines,
      grants: Object.keys(grants).map(function (k) { return grants[k]; })
        .sort(function (a, b) { return a.grant_source < b.grant_source ? -1 : 1; }),
      unmatched: unmatched,
      today: today
    };
  },

  /**
   * Writes spent, remaining and burn_rate back to the Budget tab so the Sheet
   * always shows the current figures. Returns the computed result.
   */
  recalcBudget_: function () {
    const result = Finance.compute_(Finance.readBudgets_(), Finance.readAll_(), todayIso_());
    const sheet = getDb_().getSheetByName('Budget');
    const col = columnMap_('Budget').spent; // spent, remaining, burn_rate sit side by side
    result.lines.forEach(function (l) {
      sheet.getRange(l.rowIndex, col, 1, 3).setValues([[
        l.spent, l.remaining, l.burn_rate === null ? '' : l.burn_rate
      ]]);
    });
    return result;
  },

  // ---- dropdowns ----

  options: function (user) {
    const budgets = Finance.readBudgets_().filter(function (b) {
      return b.active && Finance.CURRENCIES.indexOf(b.currency) !== -1;
    });
    return {
      // Names and currency only. Allocations are never sent to plain staff.
      budgetLines: budgets.map(function (b) { return { name: b.budget_line, currency: b.currency }; }),
      categories: Finance.categories_(),
      currencies: Finance.CURRENCIES,
      directions: Finance.canSeeAll_(user) ? Finance.DIRECTIONS : ['Expenditure'],
      canSeeAll: Finance.canSeeAll_(user),
      isAdmin: user.accessLevel === 'Admin',
      maxReceiptMb: Finance.MAX_RECEIPT_BYTES / (1024 * 1024),
      today: todayIso_()
    };
  },

  // ---- submitting ----

  nextId_: function (all) {
    let max = 0;
    all.forEach(function (r) {
      const m = /^T(\d+)$/.exec(r.transaction_id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'T' + String(max + 1).padStart(4, '0');
  },

  /** Validates an uploaded receipt and returns its decoded bytes. */
  checkReceipt_: function (receipt) {
    if (!receipt || typeof receipt !== 'object') throw new Error('Attach the receipt.');
    const type = Finance.clean_(receipt.type).toLowerCase();
    const spec = Finance.RECEIPT_TYPES[type];
    if (!spec) throw new Error('The receipt must be a PDF, PNG or JPEG file.');
    const text = String(receipt.data || '');
    // Reject oversize before decoding: 4 base64 characters carry 3 bytes.
    if (text.length > Math.ceil(Finance.MAX_RECEIPT_BYTES / 3) * 4 + 4) {
      throw new Error('The receipt is larger than ' + (Finance.MAX_RECEIPT_BYTES / (1024 * 1024)) + ' MB.');
    }
    if (!text || !/^[A-Za-z0-9+\/]+=*$/.test(text)) throw new Error('The receipt file could not be read.');
    const bytes = Utilities.base64Decode(text);
    if (!bytes.length) throw new Error('The receipt file is empty.');
    if (bytes.length > Finance.MAX_RECEIPT_BYTES) {
      throw new Error('The receipt is larger than ' + (Finance.MAX_RECEIPT_BYTES / (1024 * 1024)) + ' MB.');
    }
    const ok = spec.magic.every(function (b, i) { return (bytes[i] & 0xFF) === b; });
    if (!ok) throw new Error('The file contents do not match a ' + spec.ext.toUpperCase() + ' file.');
    return { bytes: bytes, type: type, ext: spec.ext, name: Finance.clean_(receipt.name) };
  },

  saveReceipt_: function (id, r) {
    const base = r.name.replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 60) || 'receipt';
    const blob = Utilities.newBlob(r.bytes, r.type, id + '_' + base + '.' + r.ext);
    return getFolder_('RECEIPTS_FOLDER_ID').createFile(blob);
  },

  submit: function (user, data) {
    data = data || {};
    const clean = Finance.clean_;
    const canAll = Finance.canSeeAll_(user);
    const today = todayIso_();

    const direction = clean(data.direction) || 'Expenditure';
    if (Finance.DIRECTIONS.indexOf(direction) === -1) throw new Error('Choose Income or Expenditure.');
    if (direction === 'Income' && !canAll) throw new Error('Access denied: only Finance or Admin can record income.');

    const date = clean(data.date);
    if (!isIsoDate_(date)) throw new Error('Enter a valid transaction date.');
    if (date > today) throw new Error('The transaction date cannot be in the future.');

    const category = clean(data.category);
    if (Finance.categories_().indexOf(category) === -1) throw new Error('Choose a category from the list.');

    const description = clean(data.description);
    if (!description) throw new Error('Add a description.');
    if (description.length > Finance.MAX_TEXT) throw new Error('The description is too long (500 characters at most).');

    const amountText = clean(data.amount).replace(/,/g, '');
    const amount = amountText === '' ? NaN : Number(amountText);
    if (!isFinite(amount) || amount <= 0) throw new Error('Amount must be a number greater than zero.');
    if (amount > Finance.MAX_AMOUNT) throw new Error('That amount is too large.');
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      throw new Error('Amount can have at most 2 decimal places.');
    }

    const currency = clean(data.currency).toUpperCase();
    if (Finance.CURRENCIES.indexOf(currency) === -1) throw new Error('Choose NGN or USD.');

    const lineName = clean(data.budget_line);
    const budget = Finance.readBudgets_().filter(function (b) {
      return b.active && b.budget_line === lineName;
    })[0];
    if (!budget) throw new Error('Choose a budget line from the list.');
    if (!budget.currency) throw new Error('The budget line "' + lineName + '" has no currency set. Ask an Admin.');
    if (budget.currency !== currency) {
      throw new Error('The budget line "' + lineName + '" is in ' + budget.currency +
        '. Enter the expense in ' + budget.currency + '.');
    }

    let receipt = null;
    if (direction === 'Expenditure' || data.receipt) receipt = Finance.checkReceipt_(data.receipt);

    return withLock_(function () {
      const all = Finance.readAll_();
      const id = Finance.nextId_(all);
      const now = Finance.nowStamp_();

      let file = null;
      if (receipt) file = Finance.saveReceipt_(id, receipt);

      // Income from Finance/Admin needs no approval; expenses always do.
      const auto = direction === 'Income';
      const record = {
        transaction_id: id, date: date, direction: direction, category: category,
        description: description, amount: amount, currency: currency,
        budget_line: lineName, grant_source: budget.grant_source,
        submitted_by: user.email, approved_by: auto ? user.email : '',
        receipt_link: file ? file.getUrl() : '', active: true,
        status: auto ? Finance.APPROVED : Finance.PENDING,
        decision_note: '', decided_by: auto ? user.email : '', decided_at: auto ? now : '',
        reversal_of: '', submitted_at: now
      };
      try {
        const sheet = getDb_().getSheetByName('Finance');
        writeRowSafe_(sheet, sheet.getLastRow() + 1, SCHEMA.Finance, record);
        if (auto) Finance.recalcBudget_();
      } catch (e) {
        if (file) file.setTrashed(true);
        throw e;
      }
      return { transaction_id: id, status: record.status };
    });
  },

  // ---- reading lists ----

  names_: function () {
    const names = {};
    StaffDirectory.readAll_().forEach(function (s) { names[s.email] = s.full_name; });
    return names;
  },

  shape_: function (t, names, reversedIds) {
    return {
      transaction_id: t.transaction_id, date: t.date, direction: t.direction,
      category: t.category, description: t.description, amount: t.amount,
      currency: t.currency, budget_line: t.budget_line, grant_source: t.grant_source,
      submitted_by: t.submitted_by, submitted_by_name: names[t.submitted_by] || t.submitted_by,
      approved_by: t.approved_by, decided_by_name: names[t.decided_by] || t.decided_by,
      receipt_link: /^https:\/\//.test(t.receipt_link) ? t.receipt_link : '',
      status: t.status, decision_note: t.decision_note, decided_at: t.decided_at,
      reversal_of: t.reversal_of, submitted_at: t.submitted_at,
      reversed: !!reversedIds[t.transaction_id]
    };
  },

  reversedIds_: function (all) {
    const ids = {};
    all.forEach(function (t) { if (t.active && t.reversal_of) ids[t.reversal_of] = true; });
    return ids;
  },

  newestFirst_: function (a, b) {
    const ka = (a.date + ' ' + a.transaction_id), kb = (b.date + ' ' + b.transaction_id);
    return ka < kb ? 1 : -1;
  },

  /** The caller's own submissions, whatever their access level. */
  mine: function (user) {
    const all = Finance.readAll_();
    const names = Finance.names_();
    const rev = Finance.reversedIds_(all);
    return all.filter(function (t) { return t.active && t.submitted_by === user.email && !t.reversal_of; })
      .sort(Finance.newestFirst_).slice(0, Finance.LIST_LIMIT)
      .map(function (t) {
        const s = Finance.shape_(t, names, rev);
        // Their own rows only: the approver's identity is not needed.
        delete s.approved_by; delete s.decided_by_name; delete s.grant_source;
        return s;
      });
  },

  /** Every transaction, for Finance and Admin. filters: { status, budget_line, direction }. */
  list: function (user, filters) {
    if (!Finance.canSeeAll_(user)) throw new Error('Access denied: Finance or Admin only.');
    filters = filters || {};
    const all = Finance.readAll_();
    const names = Finance.names_();
    const rev = Finance.reversedIds_(all);
    let rows = all.filter(function (t) { return t.active; });
    ['status', 'budget_line', 'direction'].forEach(function (key) {
      const want = Finance.clean_(filters[key]);
      if (want) rows = rows.filter(function (t) { return t[key] === want; });
    });
    rows.sort(Finance.newestFirst_);
    const total = rows.length;
    return {
      total: total,
      rows: rows.slice(0, Finance.LIST_LIMIT).map(function (t) { return Finance.shape_(t, names, rev); })
    };
  },

  dashboard: function (user) {
    if (!Finance.canSeeAll_(user)) throw new Error('Access denied: Finance or Admin only.');
    const result = Finance.compute_(Finance.readBudgets_(), Finance.readAll_(), todayIso_());
    result.lines.forEach(function (l) { delete l.rowIndex; });
    return result;
  },

  // ---- decisions ----

  decide: function (user, id, decision, note) {
    if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
    id = Finance.clean_(id);
    decision = Finance.clean_(decision);
    note = Finance.clean_(note);
    if (decision !== 'Approve' && decision !== 'Reject') throw new Error('Choose Approve or Reject.');
    if (decision === 'Reject' && !note) throw new Error('Give a reason when rejecting an expense.');
    if (note.length > 300) throw new Error('The note is too long (300 characters at most).');

    const outcome = withLock_(function () {
      const t = Finance.readAll_().filter(function (r) { return r.transaction_id === id && r.active; })[0];
      if (!t) throw new Error('No transaction found with id ' + id + '.');
      if (t.status !== Finance.PENDING) throw new Error(id + ' has already been ' + t.status.toLowerCase() + '.');
      if (Finance.BLOCK_SELF_APPROVAL && t.submitted_by === user.email) {
        throw new Error('You cannot approve or reject your own submission. Ask another Admin.');
      }
      if (decision === 'Approve') {
        const b = Finance.readBudgets_().filter(function (x) { return x.active && x.budget_line === t.budget_line; })[0];
        if (!b) throw new Error('The budget line "' + t.budget_line + '" is missing or inactive.');
        if (b.currency !== t.currency) {
          throw new Error('This is in ' + t.currency + ' but the budget line is in ' + (b.currency || 'no currency') + '.');
        }
        if (!t.amount_ok || t.amount <= 0) throw new Error('This transaction has no valid amount.');
      }

      const sheet = getDb_().getSheetByName('Finance');
      const cols = columnMap_('Finance');
      const put = function (name, value) { setCellSafe_(sheet.getRange(t.rowIndex, cols[name]), value); };
      put('status', decision === 'Approve' ? Finance.APPROVED : Finance.REJECTED);
      put('decided_by', user.email);
      put('decided_at', Finance.nowStamp_());
      put('decision_note', note);
      if (decision === 'Approve') put('approved_by', user.email);

      let warning = '';
      if (decision === 'Approve') {
        const line = Finance.recalcBudget_().lines.filter(function (l) { return l.budget_line === t.budget_line; })[0];
        if (line && line.remaining < 0) {
          warning = line.budget_line + ' is now over its allocation by ' + Math.abs(line.remaining) + ' ' + line.currency + '.';
        }
      }
      return { t: t, warning: warning };
    });

    const emailWarning = Finance.notifyDecision_(outcome.t, decision, user, note);
    return {
      transaction_id: id,
      status: decision === 'Approve' ? Finance.APPROVED : Finance.REJECTED,
      warning: [outcome.warning, emailWarning].filter(Boolean).join(' ')
    };
  },

  notifyDecision_: function (t, decision, admin, note) {
    try {
      const names = Finance.names_();
      const word = decision === 'Approve' ? 'approved' : 'rejected';
      const lines = ['Hello ' + (names[t.submitted_by] || ''), '',
        'Your expense ' + t.transaction_id + ' (' + t.description + ') for ' + t.amount + ' ' +
        t.currency + ' on ' + t.budget_line + ' has been ' + word + '.'];
      if (note) lines.push('', 'Note from ' + (names[admin.email] || admin.email) + ': ' + note);
      sendMail_(t.submitted_by, 'Expense ' + word + ': ' + t.description, lines.join('\n'));
      return '';
    } catch (e) {
      Logger.log('Expense email failed: ' + e);
      return 'The decision was saved but the email to the submitter failed.';
    }
  },

  /** Cancels an approved transaction with a new negative entry. The original is untouched. */
  reverse: function (user, id, reason) {
    if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
    id = Finance.clean_(id);
    reason = Finance.clean_(reason);
    if (!reason) throw new Error('Give a reason for the reversal.');
    if (reason.length > 300) throw new Error('The reason is too long (300 characters at most).');

    return withLock_(function () {
      const all = Finance.readAll_();
      const t = all.filter(function (r) { return r.transaction_id === id && r.active; })[0];
      if (!t) throw new Error('No transaction found with id ' + id + '.');
      if (t.reversal_of) throw new Error('A reversal cannot be reversed. Add a new transaction instead.');
      if (t.status !== Finance.APPROVED) throw new Error('Only an approved transaction can be reversed.');
      if (Finance.reversedIds_(all)[id]) throw new Error(id + ' has already been reversed.');
      if (!t.amount_ok) throw new Error('This transaction has no valid amount.');

      const newId = Finance.nextId_(all);
      const now = Finance.nowStamp_();
      const text = ('Reversal of ' + id + ': ' + reason).slice(0, Finance.MAX_TEXT);
      const sheet = getDb_().getSheetByName('Finance');
      writeRowSafe_(sheet, sheet.getLastRow() + 1, SCHEMA.Finance, {
        transaction_id: newId, date: todayIso_(), direction: t.direction, category: t.category,
        description: text, amount: -t.amount, currency: t.currency,
        budget_line: t.budget_line, grant_source: t.grant_source,
        submitted_by: user.email, approved_by: user.email, receipt_link: '', active: true,
        status: Finance.APPROVED, decision_note: reason, decided_by: user.email,
        decided_at: now, reversal_of: id, submitted_at: now
      });
      Finance.recalcBudget_();
      return { transaction_id: newId, reversal_of: id };
    });
  },

  recalculate: function (user) {
    if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
    return withLock_(function () {
      const r = Finance.recalcBudget_();
      return { lines: r.lines.length, unmatched: r.unmatched,
        warnings: r.lines.reduce(function (n, l) { return n + l.warnings.length; }, 0) };
    });
  },

  // ---- tidying rows pasted in from the old trackers ----

  /**
   * Run once after the analysts paste historical transactions into the
   * Finance tab. It tidies the rows (it never deletes one), then recalculates
   * the Budget tab. Safe to run again. Returns a summary.
   */
  normalise: function (user) {
    if (user.accessLevel !== 'Admin') throw new Error('Access denied: Admin only.');
    return withLock_(function () {
      const ss = getDb_();
      const sheet = ss.getSheetByName('Finance');
      Finance.checkHeaders_(sheet, 'Finance');
      const cols = columnMap_('Finance');
      const raw = sheet.getDataRange().getValues().slice(1);
      const tz = ss.getSpreadsheetTimeZone();
      const budgets = Finance.readBudgets_();
      const summary = { rows: 0, cellsChanged: 0, problems: [] };

      raw.forEach(function (row, i) {
        const rowNumber = i + 2;
        const get = function (name) { return row[cols[name] - 1]; };
        const id = Finance.clean_(get('transaction_id'));
        if (!id) return;
        summary.rows++;
        const change = function (name, value) {
          const range = sheet.getRange(rowNumber, cols[name]);
          setCellSafe_(range, value);
          summary.cellsChanged++;
        };
        const text = function (name) {
          const v = get(name);
          return v === undefined || v === null ? '' : String(v);
        };

        // date: a real date value becomes yyyy-MM-dd text
        const d = get('date');
        if (d instanceof Date) change('date', Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
        else if (!isIsoDate_(Finance.clean_(d))) summary.problems.push(id + ': date "' + d + '" is not yyyy-MM-dd.');
        else if (text('date') !== Finance.clean_(d)) change('date', Finance.clean_(d));

        // direction / currency: tidy the case
        const dir = Finance.clean_(get('direction'));
        const wantDir = Finance.DIRECTIONS.filter(function (x) { return x.toLowerCase() === dir.toLowerCase(); })[0];
        if (!wantDir) summary.problems.push(id + ': direction "' + dir + '" must be Income or Expenditure.');
        else if (text('direction') !== wantDir) change('direction', wantDir);
        const cur = Finance.clean_(get('currency')).toUpperCase();
        if (Finance.CURRENCIES.indexOf(cur) === -1) summary.problems.push(id + ': currency "' + cur + '" must be NGN or USD.');
        else if (text('currency') !== cur) change('currency', cur);

        // amount: numeric text becomes a number
        const a = get('amount');
        if (typeof a !== 'number') {
          const n = Number(String(a).replace(/,/g, ''));
          if (String(a).trim() !== '' && isFinite(n)) {
            sheet.getRange(rowNumber, cols.amount).setValue(n);
            summary.cellsChanged++;
          } else {
            summary.problems.push(id + ': amount "' + a + '" is not a number.');
          }
        }

        // text columns: trim; emails in lower case
        ['category', 'description', 'budget_line', 'grant_source', 'receipt_link'].forEach(function (name) {
          if (text(name) !== text(name).trim()) change(name, text(name).trim());
        });
        ['submitted_by', 'approved_by'].forEach(function (name) {
          const want = text(name).trim().toLowerCase();
          if (text(name) !== want) change(name, want);
        });

        // grant_source from the budget line when blank
        const line = budgets.filter(function (b) { return b.budget_line === Finance.clean_(get('budget_line')); })[0];
        if (!line) summary.problems.push(id + ': budget line "' + get('budget_line') + '" is not in the Budget tab.');
        else if (!Finance.clean_(get('grant_source'))) change('grant_source', line.grant_source);

        // status, active
        if (!Finance.clean_(get('status'))) {
          change('status', Finance.clean_(get('approved_by')) ? Finance.APPROVED : Finance.PENDING);
        }
        const act = get('active');
        if (act === '' || act === undefined || act === null) {
          sheet.getRange(rowNumber, cols.active).setValue(true);
          summary.cellsChanged++;
        }
      });

      // Budget lines with no currency: fill it only when it is unambiguous.
      const currencies = {};
      Finance.readAll_().forEach(function (t) {
        currencies[t.budget_line] = currencies[t.budget_line] || {};
        currencies[t.budget_line][t.currency] = true;
      });
      const bsheet = ss.getSheetByName('Budget');
      const bcols = columnMap_('Budget');
      budgets.forEach(function (b) {
        if (b.currency) return;
        const seen = Object.keys(currencies[b.budget_line] || {});
        if (seen.length === 1) {
          setCellSafe_(bsheet.getRange(b.rowIndex, bcols.currency), seen[0]);
          summary.cellsChanged++;
        } else {
          summary.problems.push('Budget line "' + b.budget_line + '" needs a currency (' +
            (seen.length ? 'its transactions use ' + seen.join(' and ') : 'it has no transactions') + ').');
        }
      });

      const result = Finance.recalcBudget_();
      summary.unmatched = result.unmatched;
      Logger.log('normaliseFinanceRows: ' + JSON.stringify(summary));
      return summary;
    });
  }
};

// ---- Functions callable from the browser (google.script.run) ----
// Each one re-checks the caller on the server. The UI is never trusted.

function financeOptions() {
  return Finance.options(requireUser_());
}

function financeSubmit(data) {
  return Finance.submit(requireUser_(), data);
}

function financeMine() {
  return Finance.mine(requireUser_());
}

function financeTransactions(filters) {
  return Finance.list(requireFinanceOrAdmin_(), filters);
}

function financeDashboard() {
  return Finance.dashboard(requireFinanceOrAdmin_());
}

function financeDecide(id, decision, note) {
  return Finance.decide(requireAdmin_(), id, decision, note);
}

function financeReverse(id, reason) {
  return Finance.reverse(requireAdmin_(), id, reason);
}

function financeRecalculate() {
  return Finance.recalculate(requireAdmin_());
}

/** Run from the Apps Script editor after pasting legacy rows into the Finance tab. */
function normaliseFinanceRows() {
  return Finance.normalise(requireAdmin_());
}
