/**
 * tests/finance.test.js
 * Run with:  node tests/finance.test.js     (no install step, Node 18+)
 * Tests the Finance, Budget and access-control server code against an
 * in-memory stand-in for Google Sheets (see mock.js).
 */
const assert = require('assert/strict');
const { freshSeeded, createEnv, FILES } = require('./mock');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

const ADA = 'admin@example.org', LEO = 'lead@example.org', SAM = 'staff@example.org';

function addPerson(env, email, level, reportsTo) {
  env.as(ADA);
  env.ctx.staffDirectoryAdd({ full_name: email.split('@')[0], email, role: 'Test', department: 'Finance',
    reports_to: reportsTo || '', access_level: level, employment_type: 'Full time', start_date: '2026-01-01' });
}
function setup() {
  const env = freshSeeded();
  addPerson(env, 'fin@example.org', 'Finance', LEO);
  addPerson(env, 'admin2@example.org', 'Admin');
  addPerson(env, 'intern@example.org', 'Staff', 'fin@example.org');   // someone reports to the Finance user
  return env;
}
const good = over => Object.assign({
  direction: 'Expenditure', date: '2026-10-10', category: 'Travel', description: 'Train to Abuja',
  amount: '125.50', currency: 'USD', budget_line: 'Travel',
  receipt: { name: 'ticket.pdf', type: 'application/pdf', data: FILES.pdf }
}, over || {});
const call = (env, who, fn, ...args) => env.as(who).ctx[fn](...args);
function throwsMsg(fn, re) {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, 'expected an error matching ' + re);
  assert.match(err.message, re);
}
const line = (env, name) => env.plain(call(env, ADA, 'financeDashboard')).lines.filter(l => l.budget_line === name)[0];

console.log('Finance');

test('setup adds the new columns and seeds the analysts\' sample data', () => {
  const env = freshSeeded();
  const budget = env.rows('Budget'), fin = env.rows('Finance');
  assert.equal(budget.length, 7);
  assert.equal(fin.length, 14);
  assert.equal(typeof budget[0].period, 'string');            // "2026" must stay text
  assert.equal(typeof budget[0].allocated, 'number');
  assert.equal(budget[0].currency, 'USD');
  assert.equal(typeof fin[0].date, 'string');                  // dates must stay text
  assert.equal(fin[0].status, 'Approved');
  assert.equal(fin[1].status, 'Pending');
  assert.deepEqual(env.formulas('Finance').concat(env.formulas('Budget')), []);
  env.ctx.seedDummyData();                                     // running again must not duplicate
  assert.equal(env.rows('Budget').length, 7);
  assert.equal(env.rows('Finance').length, 14);
});

test('seeding stores spent, remaining and burn rate in the Budget tab', () => {
  const env = freshSeeded();
  const travel = env.rows('Budget').filter(r => r.budget_line === 'Travel')[0];
  assert.equal(travel.spent, 7000);
  assert.equal(travel.remaining, 13000);
  assert.equal(travel.burn_rate, 700);                         // 7000 over 10 months
});

test('dashboard follows the analysts\' rules (approved spend only, burn = spent / months elapsed)', () => {
  const env = freshSeeded();
  const d = env.plain(call(env, ADA, 'financeDashboard'));
  const t = d.lines.filter(l => l.budget_line === 'Travel')[0];
  assert.deepEqual([t.spent, t.remaining, t.burn_rate, t.pending], [7000, 13000, 700, 3000]);
  assert.deepEqual([t.months_total, t.months_elapsed, t.months_remaining], [12, 10, 2]);
  assert.equal(t.remaining_per_month, 6500);                   // remaining / months remaining, a separate figure
  assert.equal(t.remaining_pct, 0.65);
  const pay = d.lines.filter(l => l.budget_line === 'Payroll')[0];
  assert.deepEqual([pay.spent, pay.burn_rate, pay.remaining], [0, 0, 120000]);
  const g1 = d.grants.filter(g => g.grant_source === 'Sample Funder 1')[0];
  const g2 = d.grants.filter(g => g.grant_source === 'Sample Funder 2')[0];
  assert.deepEqual([g1.allocated, g1.spent, g1.remaining, g1.burn_rate], [240000, 12000, 228000, 1200]);
  assert.deepEqual([g2.allocated, g2.spent, g2.remaining, g2.burn_rate], [100000, 8000, 92000, 800]);
  assert.equal(g2.funds_received, 0);                          // the income rows have no approver yet
});

test('only Finance and Admin see transactions and the dashboard', () => {
  const env = setup();
  [SAM, LEO].forEach(who => {
    throwsMsg(() => call(env, who, 'financeTransactions', {}), /Finance or Admin only/);
    throwsMsg(() => call(env, who, 'financeDashboard'), /Finance or Admin only/);
  });
  ['fin@example.org', ADA].forEach(who => {
    assert.equal(env.plain(call(env, who, 'financeTransactions', {})).total, 14);
    assert.equal(call(env, who, 'financeDashboard').lines.length, 7);
  });
  const o = env.plain(call(env, SAM, 'financeOptions'));
  assert.deepEqual(o.directions, ['Expenditure']);
  assert.equal(o.budgetLines.length, 7);
  assert.deepEqual(Object.keys(o.budgetLines[0]).sort(), ['currency', 'name']);   // no allocations for staff
  throwsMsg(() => call(env, 'nobody@example.org', 'financeOptions'), /no active Staff record/);
});

test('only an Admin decides, reverses, recalculates or normalises', () => {
  const env = setup();
  ['fin@example.org', LEO, SAM].forEach(who => {
    throwsMsg(() => call(env, who, 'financeDecide', 'T0002', 'Approve', ''), /Admin only/);
    throwsMsg(() => call(env, who, 'financeReverse', 'T0001', 'x'), /Admin only/);
    throwsMsg(() => call(env, who, 'financeRecalculate'), /Admin only/);
    throwsMsg(() => call(env, who, 'normaliseFinanceRows'), /Admin only/);
  });
});

test('the Finance level gets no team view and cannot assign tasks', () => {
  const env = setup();
  const seen = env.plain(env.as('fin@example.org').ctx.visibleStaffEmails_(env.ctx.requireUser_()));
  assert.deepEqual(seen, ['fin@example.org']);                       // not the intern who reports to them
  assert.equal(env.plain(call(env, 'fin@example.org', 'staffDirectoryList')).length, 1);
  assert.deepEqual(env.plain(call(env, 'fin@example.org', 'tasksOptions').people), []);
  throwsMsg(() => call(env, 'fin@example.org', 'tasksCreate', {}), /Lead or Admin only/);
});

test('submit stores a Pending expense as the caller, whatever the browser sends', () => {
  const env = setup();
  const res = env.plain(call(env, SAM, 'financeSubmit', Object.assign(good(),
    { submitted_by: ADA, approved_by: ADA, status: 'Approved', grant_source: 'Evil Funder', active: false })));
  assert.deepEqual(res, { transaction_id: 'T0015', status: 'Pending' });
  const row = env.rows('Finance').filter(r => r.transaction_id === 'T0015')[0];
  assert.equal(row.submitted_by, SAM);
  assert.equal(row.approved_by, '');
  assert.equal(row.status, 'Pending');
  assert.equal(row.grant_source, 'Sample Funder 1');           // taken from the budget line
  assert.equal(row.amount, 125.5);
  assert.equal(typeof row.date, 'string');
  assert.equal(row.active, true);
  assert.match(row.submitted_at, /^2026-10-18 12:00$/);
  assert.match(row.receipt_link, /^https:\/\//);
  assert.equal(env.state.files.length, 1);
  assert.equal(env.state.files[0].blob.name, 'T0015_ticket.pdf');
  assert.equal(line(env, 'Travel').spent, 7000);               // pending does not count as spent
});

test('submit rejects bad input', () => {
  const env = setup();
  const bad = [
    [{ direction: 'Income' }, /only Finance or Admin can record income/],
    [{ direction: 'Refund' }, /Income or Expenditure/],
    [{ date: '2026-02-31' }, /valid transaction date/],
    [{ date: '2026-12-01' }, /cannot be in the future/],
    [{ category: 'Gold bars' }, /category/],
    [{ description: '   ' }, /Add a description/],
    [{ description: 'x'.repeat(501) }, /too long/],
    [{ amount: '0' }, /greater than zero/],
    [{ amount: '-5' }, /greater than zero/],
    [{ amount: 'abc' }, /greater than zero/],
    [{ amount: '' }, /greater than zero/],
    [{ amount: '12.345' }, /2 decimal places/],
    [{ amount: '2000000000' }, /too large/],
    [{ currency: 'EUR' }, /NGN or USD/],
    [{ currency: 'NGN' }, /is in USD/],
    [{ budget_line: 'Nope' }, /budget line from the list/],
    [{ receipt: null }, /Attach the receipt/],
    [{ receipt: { name: 'a.html', type: 'text/html', data: FILES.html } }, /PDF, PNG or JPEG/],
    [{ receipt: { name: 'a.pdf', type: 'application/pdf', data: FILES.png } }, /do not match/],
    [{ receipt: { name: 'a.pdf', type: 'application/pdf', data: 'not base64!!' } }, /could not be read/],
    [{ receipt: { name: 'a.pdf', type: 'application/pdf', data: Buffer.alloc(5 * 1024 * 1024 + 10, 1).toString('base64') } }, /larger than 5 MB/]
  ];
  bad.forEach(([over, re]) => throwsMsg(() => call(env, SAM, 'financeSubmit', good(over)), re));
  assert.equal(env.rows('Finance').length, 14);                // nothing was written
  assert.equal(env.state.files.length, 0);                     // and no file was saved
});

test('PNG and JPEG receipts are accepted', () => {
  const env = setup();
  call(env, SAM, 'financeSubmit', good({ receipt: { name: 'p.png', type: 'image/png', data: FILES.png } }));
  call(env, SAM, 'financeSubmit', good({ receipt: { name: 'j.JPG', type: 'image/jpeg', data: FILES.jpg } }));
  assert.deepEqual(env.state.files.map(f => f.blob.name), ['T0015_p.png', 'T0016_j.jpg']);
});

test('a failed upload writes no row; a failed row write trashes the file', () => {
  const env = setup();
  env.state.failFile = true;
  throwsMsg(() => call(env, SAM, 'financeSubmit', good()), /drive down/);
  assert.equal(env.rows('Finance').length, 14);
});

test('text that starts with "=" is stored as text everywhere in Finance', () => {
  const env = setup();
  call(env, SAM, 'financeSubmit', good({ description: '=1+1', receipt: { name: '=HYPERLINK("x").pdf', type: 'application/pdf', data: FILES.pdf } }));
  call(env, ADA, 'financeDecide', 'T0015', 'Approve', '=2+2');
  call(env, ADA, 'financeReverse', 'T0015', '=3+3');
  assert.deepEqual(env.formulas('Finance'), []);
  const rows = env.rows('Finance');
  assert.equal(rows.filter(r => r.transaction_id === 'T0015')[0].description, '=1+1');
  assert.equal(rows.filter(r => r.transaction_id === 'T0015')[0].decision_note, '=2+2');
  assert.match(rows.filter(r => r.transaction_id === 'T0016')[0].description, /^Reversal of T0015: =3\+3$/);
});

test('approving updates the Budget tab and emails the submitter', () => {
  const env = setup();
  call(env, SAM, 'financeSubmit', good());
  const res = env.plain(call(env, ADA, 'financeDecide', 'T0015', 'Approve', 'Looks fine'));
  assert.equal(res.status, 'Approved');
  const row = env.rows('Finance').filter(r => r.transaction_id === 'T0015')[0];
  assert.deepEqual([row.status, row.approved_by, row.decided_by, row.decision_note], ['Approved', ADA, ADA, 'Looks fine']);
  assert.match(row.decided_at, /^2026-10-18 12:00$/);
  const travel = env.rows('Budget').filter(r => r.budget_line === 'Travel')[0];
  assert.deepEqual([travel.spent, travel.remaining, travel.burn_rate], [7125.5, 12874.5, 712.55]);
  assert.equal(env.state.mails.length, 1);
  assert.match(env.state.mails[0].subject, /^\[DEV\] Expense approved: Train to Abuja.*real recipient: staff@example\.org/);
  assert.match(env.state.mails[0].body, /125.5 USD on Travel has been approved/);
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0015', 'Approve', ''), /already been approved/);
});

test('rejecting needs a reason, leaves the budget alone and emails the submitter', () => {
  const env = setup();
  call(env, SAM, 'financeSubmit', good());
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0015', 'Reject', ''), /reason when rejecting/);
  call(env, ADA, 'financeDecide', 'T0015', 'Reject', 'Receipt unreadable');
  const row = env.rows('Finance').filter(r => r.transaction_id === 'T0015')[0];
  assert.deepEqual([row.status, row.approved_by, row.decided_by], ['Rejected', '', ADA]);
  assert.equal(env.rows('Budget').filter(r => r.budget_line === 'Travel')[0].spent, 7000);
  assert.match(env.state.mails[0].subject, /Expense rejected/);
  assert.match(env.state.mails[0].body, /Receipt unreadable/);
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0015', 'Approve', ''), /already been rejected/);
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0099', 'Approve', ''), /No transaction found/);
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0015', 'Maybe', ''), /Approve or Reject/);
});

test('an Admin cannot decide their own submission; a second Admin can', () => {
  const env = setup();
  call(env, ADA, 'financeSubmit', good({ description: 'Ada lunch' }));
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0015', 'Approve', ''), /your own submission/);
  throwsMsg(() => call(env, ADA, 'financeDecide', 'T0015', 'Reject', 'no'), /your own submission/);
  call(env, 'admin2@example.org', 'financeDecide', 'T0015', 'Approve', '');
  assert.equal(env.rows('Finance').filter(r => r.transaction_id === 'T0015')[0].status, 'Approved');
});

test('approving past the allocation warns but still records it', () => {
  const env = setup();
  call(env, SAM, 'financeSubmit', good({ amount: '14000' }));
  const res = env.plain(call(env, ADA, 'financeDecide', 'T0015', 'Approve', ''));
  assert.match(res.warning, /Travel is now over its allocation by 1000 USD/);
  assert.equal(line(env, 'Travel').remaining, -1000);
});

test('a mail failure does not undo the decision', () => {
  const env = setup();
  call(env, SAM, 'financeSubmit', good());
  env.state.failMail = true;
  const res = env.plain(call(env, ADA, 'financeDecide', 'T0015', 'Approve', ''));
  assert.match(res.warning, /email to the submitter failed/);
  assert.equal(env.rows('Finance').filter(r => r.transaction_id === 'T0015')[0].status, 'Approved');
});

test('a reversal adds a negative entry and never touches the original', () => {
  const env = setup();
  const before = env.rows('Finance').filter(r => r.transaction_id === 'T0006')[0];
  throwsMsg(() => call(env, ADA, 'financeReverse', 'T0006', ''), /reason for the reversal/);
  const res = env.plain(call(env, ADA, 'financeReverse', 'T0006', 'Flight cancelled'));
  assert.deepEqual(res, { transaction_id: 'T0015', reversal_of: 'T0006' });
  const after = env.rows('Finance').filter(r => r.transaction_id === 'T0006')[0];
  assert.deepEqual(after, before);
  const rev = env.rows('Finance').filter(r => r.transaction_id === 'T0015')[0];
  assert.deepEqual([rev.amount, rev.status, rev.reversal_of, rev.direction, rev.budget_line], [-4000, 'Approved', 'T0006', 'Expenditure', 'Travel']);
  assert.equal(line(env, 'Travel').spent, 3000);
  throwsMsg(() => call(env, ADA, 'financeReverse', 'T0006', 'again'), /already been reversed/);
  throwsMsg(() => call(env, ADA, 'financeReverse', 'T0015', 'undo'), /cannot be reversed/);
  throwsMsg(() => call(env, ADA, 'financeReverse', 'T0002', 'x'), /Only an approved transaction/);
  const list = env.plain(call(env, ADA, 'financeTransactions', {})).rows;
  assert.equal(list.filter(r => r.transaction_id === 'T0006')[0].reversed, true);
});

test('income from Finance needs no approval and is never counted as spent', () => {
  const env = setup();
  const res = env.plain(call(env, 'fin@example.org', 'financeSubmit',
    good({ direction: 'Income', budget_line: 'Other', category: 'Other', description: 'Grant tranche', amount: '5000', receipt: null })));
  assert.equal(res.status, 'Approved');
  assert.equal(line(env, 'Other').spent, 0);
  const g2 = env.plain(call(env, ADA, 'financeDashboard')).grants.filter(g => g.grant_source === 'Sample Funder 2')[0];
  assert.equal(g2.funds_received, 5000);
  throwsMsg(() => call(env, SAM, 'financeSubmit', good({ direction: 'Income', receipt: null })), /only Finance or Admin/);
});

test('legacy income with no approver becomes funds received once approved', () => {
  const env = setup();
  call(env, ADA, 'financeDecide', 'T0011', 'Approve', '');
  const g2 = env.plain(call(env, ADA, 'financeDashboard')).grants.filter(g => g.grant_source === 'Sample Funder 2')[0];
  assert.equal(g2.funds_received, 20000);
  assert.equal(line(env, 'Other').spent, 0);
});

test('"my expenses" shows only the caller\'s own rows and no approver detail', () => {
  const env = setup();
  assert.equal(env.plain(call(env, SAM, 'financeMine')).length, 14);
  assert.equal(env.plain(call(env, LEO, 'financeMine')).length, 0);
  assert.equal(env.plain(call(env, 'fin@example.org', 'financeMine')).length, 0);
  call(env, ADA, 'financeReverse', 'T0006', 'x');
  assert.equal(env.plain(call(env, ADA, 'financeMine')).length, 0);          // a reversal is not their submission
  const mine = env.plain(call(env, SAM, 'financeMine'));
  assert.equal(mine[0].transaction_id, 'T0014');                              // newest first
  ['approved_by', 'grant_source', 'decided_by_name'].forEach(k => assert.ok(!(k in mine[0])));
});

test('months and burn rate edge cases', () => {
  const env = createEnv();
  const F = env.get('Finance');
  const b = over => Object.assign({ budget_id: 'B', budget_line: 'L', grant_source: 'G', period: '', currency: 'USD',
    period_start: '', period_end: '', allocated: 1200, active: true, rowIndex: 2 }, over);
  const tx = (amt, over) => Object.assign({ transaction_id: 'T1', budget_line: 'L', direction: 'Expenditure', currency: 'USD',
    status: 'Approved', amount: amt, amount_ok: true, active: true, grant_source: 'G' }, over || {});
  const run = (budget, txns) => env.plain(F.compute_([budget], txns, '2026-10-18')).lines[0];

  let l = run(b({ period: '2025' }), [tx(1200)]);                              // period over: all 12 months elapsed
  assert.deepEqual([l.months_elapsed, l.months_remaining, l.burn_rate, l.remaining_per_month], [12, 0, 100, null]);
  l = run(b({ period_start: '2027-01-01', period_end: '2027-12-31' }), [tx(100)]);   // not started
  assert.deepEqual([l.months_elapsed, l.burn_rate, l.remaining_per_month], [0, 0, 91.67]);
  l = run(b({ period_start: '2026-07-01', period_end: '2026-12-31' }), [tx(600)]);   // explicit dates win
  assert.deepEqual([l.months_total, l.months_elapsed, l.burn_rate], [6, 4, 150]);
  l = run(b({ period: 'FY26 Q3' }), [tx(100)]);                                // cannot work out the period
  assert.equal(l.burn_rate, null);
  assert.match(l.warnings.join(' '), /Set period_start/);
  l = run(b({ period: '2026', currency: '' }), [tx(100)]);
  assert.match(l.warnings.join(' '), /No currency is set/);
  l = run(b({ period: '2026' }), [tx(100), tx(50, { transaction_id: 'T2', currency: 'NGN' }), tx(7, { transaction_id: 'T3', status: 'Rejected' }),
    tx(9, { transaction_id: 'T4', status: 'Pending' }), tx(11, { transaction_id: 'T5', active: false }), tx(13, { transaction_id: 'T6', direction: 'Income' })]);
  assert.equal(l.spent, 100);                                                  // only approved, own-currency expenditure
  assert.equal(l.pending, 9);
  assert.match(l.warnings.join(' '), /1 transaction\(s\) are in a different currency/);
  l = run(b({ period: '2026', allocated: 0.3 }), [tx(0.1), tx(0.2, { transaction_id: 'T2' })]);
  assert.equal(l.spent, 0.3);                                                  // no floating point drift
  assert.equal(l.remaining, 0);
});

test('the Budget tab is rewritten by Recalculate', () => {
  const env = setup();
  const sh = env.sheet('Budget');
  sh.getRange(2, 6, 1, 3).setValues([[999, 999, 999]]);                        // someone typed over the figures
  assert.equal(env.plain(call(env, ADA, 'financeRecalculate')).lines, 7);
  const r = env.rows('Budget')[0];
  assert.deepEqual([r.spent, r.remaining, r.burn_rate], [0, 120000, 0]);
});

test('normalise tidies rows pasted in from the old trackers', () => {
  const env = setup();
  const sh = env.sheet('Finance');
  const cols = env.get('columnMap_')('Finance');
  const put = (row, obj) => Object.keys(obj).forEach(k => sh.getRange(row, cols[k]).setValue(obj[k]));
  const D = s => new Date(s + 'T00:00:00Z');
  put(16, { transaction_id: 'T0100', date: D('2026-08-03'), direction: 'expenditure', category: 'Software ', description: ' Hosting ',
    amount: '1,200.50', currency: 'usd', budget_line: 'Software', submitted_by: 'Staff@AfroTechXcel.org', approved_by: 'Admin@AfroTechXcel.org' });
  put(17, { transaction_id: 'T0101', date: '2026-08-04', direction: 'Expenditure', category: 'Travel', description: 'Taxi',
    amount: 80, currency: 'USD', budget_line: 'Travel', submitted_by: SAM });
  put(18, { transaction_id: 'T0102', date: '04/08/2026', direction: 'Expenditure', category: 'Other', description: 'Odd',
    amount: 10, currency: 'USD', budget_line: 'Mystery', submitted_by: SAM });
  const curCol = env.get('columnMap_')('Budget').currency;
  env.sheet('Budget').getRange(2, curCol).setValue('');                                              // Payroll: no transactions
  env.sheet('Budget').getRange(6, curCol).setValue('');                                              // Travel: all USD
  const s = env.plain(call(env, ADA, 'normaliseFinanceRows'));
  assert.equal(s.rows, 17);
  const rows = env.rows('Finance');
  const a = rows.filter(r => r.transaction_id === 'T0100')[0];
  assert.deepEqual([a.date, a.direction, a.category, a.description, a.amount, a.currency, a.submitted_by, a.approved_by, a.status, a.grant_source, a.active],
    ['2026-08-03', 'Expenditure', 'Software', 'Hosting', 1200.5, 'USD', 'staff@afrotechxcel.org', 'admin@afrotechxcel.org', 'Approved', 'Sample Funder 2', true]);
  const b = rows.filter(r => r.transaction_id === 'T0101')[0];
  assert.deepEqual([b.status, b.grant_source], ['Pending', 'Sample Funder 1']);
  assert.ok(s.problems.some(p => /T0102.*date "04\/08\/2026"/.test(p)));
  assert.ok(s.problems.some(p => /T0102.*budget line "Mystery"/.test(p)));
  assert.ok(s.problems.some(p => /Payroll.*needs a currency.*no transactions/.test(p)));   // cannot be guessed
  assert.ok(!s.problems.some(p => /Travel/.test(p)));
  assert.equal(env.rows('Budget')[0].currency, '');                             // left for a person to set
  assert.equal(env.rows('Budget')[4].currency, 'USD');                          // Travel: unambiguous, filled in
  assert.equal(line(env, 'Software').spent, 4000 + 1200.5);                    // T0100 now counts
  assert.deepEqual(s.unmatched, ['T0102']);
  const again = env.plain(call(env, ADA, 'normaliseFinanceRows'));             // a second run changes nothing
  assert.equal(again.cellsChanged, 0);
  assert.deepEqual(env.formulas('Finance'), []);
});

test('Finance is added once to an access_level list that already exists', () => {
  const env = createEnv();
  env.ctx.setupSheets();
  const cfg = env.sheet('Config');
  [['access_level', 'Staff'], ['access_level', 'Lead'], ['access_level', 'Admin']].forEach((r, i) => cfg.getRange(2 + i, 1, 1, 2).setValues([r]));
  env.ctx.seedConfig_(env.state.ss);
  env.ctx.seedConfig_(env.state.ss);
  const levels = env.rows('Config').filter(r => r.category === 'access_level').map(r => r.value);
  assert.deepEqual(levels, ['Staff', 'Lead', 'Admin', 'Finance']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
