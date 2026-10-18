/**
 * tests/mock.js
 * A small in-memory stand-in for the Google services the .gs files use, so
 * the server code can be tested with plain Node (no Google account, no deps).
 *
 * It copies two Sheets behaviours that have caused real bugs here:
 *   - a string starting with "=" is stored as a formula, even in a cell
 *     formatted as plain text (setValue / setValues). Rich text is not.
 *   - in a cell that is not plain text, "2026-01-28" becomes a Date and
 *     "2026" becomes a number.
 * A formula that gets stored reads back as "#FORMULA#<text>", so a test that
 * lets one through fails loudly.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const NUM = /^-?\d+(\.\d+)?$/;

class FakeSheet {
  constructor(name) { this.name = name; this.cells = new Map(); }
  key(r, c) { return r + ',' + c; }
  cell(r, c) {
    const k = this.key(r, c);
    if (!this.cells.has(k)) this.cells.set(k, { v: '', fmt: '' });
    return this.cells.get(k);
  }
  getLastRow() {
    let max = 0;
    this.cells.forEach((cell, k) => { if (cell.v !== '' && cell.v !== undefined) max = Math.max(max, +k.split(',')[0]); });
    return max;
  }
  usedCols() {
    let max = 0;
    this.cells.forEach((cell, k) => { if (cell.v !== '') max = Math.max(max, +k.split(',')[1]); });
    return max;
  }
  getMaxColumns() { return 60; }
  insertColumnsAfter() {}
  setFrozenRows() {}
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.usedCols(), 1)); }
  appendRow(values) { this.getRange(this.getLastRow() + 1, 1, 1, values.length).setValues([values]); }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr || 1, nc || 1); }
}

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.sheet.cell(this.r + i, this.c + j), i, j); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const cell = this.sheet.cell(this.r + i, this.c + j);
        row.push(cell.formula ? '#FORMULA#' + cell.v : cell.v);
      }
      out.push(row);
    }
    return out;
  }
  getFormula() { const cell = this.sheet.cell(this.r, this.c); return cell.formula ? cell.v : ''; }
  setNumberFormat(f) { this.each(cell => { cell.fmt = f; }); return this; }
  setValues(rows) {
    this.each((cell, i, j) => this.put(cell, rows[i][j]));
    return this;
  }
  setValue(v) { this.each(cell => this.put(cell, v)); return this; }
  put(cell, v) {
    if (v === undefined || v === null) v = '';
    cell.formula = false;
    if (typeof v === 'string' && v[0] === '=') { cell.v = v; cell.formula = true; return; }
    if (typeof v === 'string' && cell.fmt !== '@') {
      if (ISO.test(v)) { cell.v = new Date(v + 'T00:00:00Z'); return; }
      if (NUM.test(v)) { cell.v = Number(v); return; }
    }
    cell.v = v;
  }
  setRichTextValue(rt) { this.each(cell => { cell.v = rt.text; cell.formula = false; }); return this; }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(n) { return this.sheets.filter(s => s.name === n)[0] || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  getUrl() { return 'https://sheets.example.org/test'; }
  getSpreadsheetTimeZone() { return 'UTC'; }
}

function pad(n, w) { return String(n).padStart(w || 2, '0'); }

function createEnv(opts) {
  opts = opts || {};
  const state = {
    now: new Date(opts.now || '2026-10-18T12:00:00Z'),
    props: { SHEET_ID: 'sheet1', ENV: 'dev', RECEIPTS_FOLDER_ID: 'folder1', EXPORTS_FOLDER_ID: 'folder2' },
    mails: [], files: [], logs: [], failMail: false, failFile: false,
    ss: new FakeSpreadsheet()
  };

  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(state.now.getTime()); }
    static now() { return state.now.getTime(); }
    // Any real Date counts, as in Apps Script (cells hand back plain Dates).
    static [Symbol.hasInstance](o) { return Date.prototype.isPrototypeOf(o); }
  }

  const sandbox = {
    Date: FakeDate, JSON, Math, Number, String, Object, Array, Error, RegExp, isFinite, parseInt, Boolean,
    Logger: { log: m => state.logs.push(String(m)) },
    SpreadsheetApp: {
      openById: () => state.ss,
      newRichTextValue: () => { let t = ''; return { setText(x) { t = x; return this; }, build() { return { text: t }; } }; }
    },
    Session: {
      getScriptTimeZone: () => 'UTC',
      getActiveUser: () => ({ getEmail: () => '' }),
      getEffectiveUser: () => ({ getEmail: () => 'dev@example.org' })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in state.props ? state.props[k] : null) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: m => { if (state.failMail) throw new Error('mail down'); state.mails.push(m); } },
    Utilities: {
      formatDate(d, tz, fmt) {
        return fmt.replace('yyyy', d.getUTCFullYear()).replace('MM', pad(d.getUTCMonth() + 1))
          .replace('dd', pad(d.getUTCDate())).replace('HH', pad(d.getUTCHours()))
          .replace('mm', pad(d.getUTCMinutes())).replace('ss', pad(d.getUTCSeconds()));
      },
      base64Decode: s => Array.from(Buffer.from(s, 'base64')).map(b => (b > 127 ? b - 256 : b)),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    DriveApp: {
      getFolderById: () => ({
        createFile(blob) {
          if (state.failFile) throw new Error('drive down');
          const f = { blob, trashed: false, getUrl: () => 'https://drive.example.org/file/' + (state.files.length + 1), setTrashed(b) { f.trashed = b; } };
          state.files.push(f);
          return f;
        }
      })
    }
  };
  const ctx = vm.createContext(sandbox);
  const srcDir = path.join(__dirname, '..', 'src');
  fs.readdirSync(srcDir).filter(f => f.endsWith('.gs')).forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(srcDir, f), 'utf8'), ctx, { filename: f });
  });

  const env = {
    ctx, state,
    get: name => vm.runInContext(name, ctx),                 // a top-level const, e.g. env.get('Finance')
    as(email) { state.props.EMAIL_OVERRIDE = email; return env; },
    setNow(iso) { state.now = new Date(iso); },
    sheet: name => state.ss.getSheetByName(name),
    rows(name) {                                              // a tab as an array of objects
      const sh = state.ss.getSheetByName(name);
      const head = env.get('SCHEMA')[name];
      const out = [];
      for (let r = 2; r <= sh.getLastRow(); r++) {
        const rec = { _row: r };
        head.forEach((h, i) => { rec[h] = sh.cell(r, i + 1).v; });
        out.push(rec);
      }
      return out;
    },
    formulas(name) {                                          // any cell that became a formula
      const hits = [];
      state.ss.getSheetByName(name).cells.forEach((cell, k) => { if (cell.formula) hits.push(k + ' ' + cell.v); });
      return hits;
    },
    plain: x => JSON.parse(JSON.stringify(x === undefined ? null : x))
  };
  return env;
}

/** A fresh environment with the tabs built and the sample data seeded. */
function freshSeeded(opts) {
  const env = createEnv(opts);
  env.ctx.setupSheets();
  env.ctx.seedDummyData();
  return env;
}

const FILES = {
  pdf: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 1)]).toString('base64'),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 2)]).toString('base64'),
  jpg: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 3)]).toString('base64'),
  html: Buffer.from('<script>alert(1)</script>').toString('base64')
};

module.exports = { createEnv, freshSeeded, FILES };
