// Runs apps-script/Update.gs in Node with a fake spreadsheet, to check that it only changes the
// two cells of the matching row, logs the old values, and refuses bad input.
//   node tests/update.test.cjs
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');

function fakeSheet(name, rows) {
  const data = rows.map((r) => r.slice());
  const formats = {};
  return {
    getName: () => name,
    getLastRow: () => data.length,
    getLastColumn: () => Math.max(...data.map((r) => r.length)),
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => data.slice(row - 1, row - 1 + numRows).map((r) => { const out = r.slice(col - 1, col - 1 + numCols); while (out.length < numCols) out.push(''); return out; }),
      setValue: (v) => { data[row - 1][col - 1] = v; },
      setNumberFormat: (f) => { formats[row + ':' + col] = f; },
    }),
    appendRow: (r) => { data.push(r.slice()); },
    data, formats,
  };
}
const sheets = {};
let locked = false;
const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = fakeSheet(n, []); return sheets[n]; },
  }),
};
const LockService = { getScriptLock: () => ({ tryLock: () => !locked, releaseLock: () => {} }) };
const ctx = vm.createContext({ SpreadsheetApp, LockService, JSON, Math, Object, Number, String, Error, Date, RegExp });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Update.gs'), 'utf8'), ctx);
const U = ctx.RCWD_UPDATE;

const reset = () => {
  for (const k of Object.keys(sheets)) delete sheets[k];
  sheets['Jersey เขียว'] = fakeSheet('Jersey เขียว', [
    ['ประทับเวลา', 'ออเดอร์', 'Size', 'ชื่อหลังเสื้อ', 'เลขหลังเสื้อ', 'สลิป'],
    ['2026-10-03', '#2-1', 'L', 'DEMO', 7, 'https://drive.google.com/x'],
    ['2026-10-05', '#9-2', '3XL', 'STAND', '70', ''],
  ]);
  sheets['หมวก RCWD'] = fakeSheet('หมวก RCWD', [
    ['ลำดับ', 'ชื่อ', 'ชั้น', 'ห้อง', 'สินค้าที่สั่ง', 'จำนวน (ใบ)', 'ออเดอร์', 'แจกแล้ว'],
    [1, 'ตัวอย่าง สอง', 'ม.2', '3', 'หมวก RCWD', 3, '#21', false],
  ]);
  sheets['Jersey ขาว'] = fakeSheet('Jersey ขาว', [
    ['ประทับเวลา', 'ออเดอร์', 'Size', 'ชื่อหลังเสื้อ', 'เลขหลังเสื้อ', 'สลิป'],
    ['2026-10-05', '#9-1', 'M', 'FLAG', '63', ''],
  ]);
};

let passed = 0;
const test = (name, fn) => { reset(); fn(); passed++; console.log('ok -', name); };

test('changes only the name and number cells of the matching row, in whichever colour tab it lives', () => {
  const r = U.handle({ kind: 'shirt', order: '#9-1', name: ' flag  two ', number: '07' }, 'staff');
  assert.equal(JSON.stringify(r), JSON.stringify({ ok: true, updated: true, changed: 2 })); // vm objects: compare by JSON
  const row = sheets['Jersey ขาว'].data[1];
  assert.deepEqual(row, ['2026-10-05', '#9-1', 'M', 'flag two', '07', '']);
  assert.equal(sheets['Jersey ขาว'].formats['2:5'], '@', 'number cell is text so 07 stays 07');
  assert.deepEqual(sheets['Jersey เขียว'].data[1], ['2026-10-03', '#2-1', 'L', 'DEMO', 7, 'https://drive.google.com/x'], 'other rows untouched');
});

test('every change is logged with the old value, and nothing is ever deleted', () => {
  const before = sheets['Jersey เขียว'].data.length;
  U.handle({ kind: 'shirt', order: '#2-1', name: 'NEW', number: '7' }, 'staff');
  assert.equal(sheets['Jersey เขียว'].data.length, before);
  const log = sheets['แก้ไขจากเว็บ (log)'].data;
  assert.equal(log.length, 2, 'header + one change (the number was already 7)');
  assert.equal(JSON.stringify(log[1].slice(1)), JSON.stringify(['staff', 'Jersey เขียว', 2, '#2-1', 'ชื่อหลังเสื้อ', 'DEMO', 'NEW']));
});

test('a no-op save answers updated with nothing changed and writes no log', () => {
  const r = U.handle({ kind: 'shirt', order: '#9-2', name: 'STAND', number: '70' }, 'staff');
  assert.equal(JSON.stringify(r), JSON.stringify({ ok: true, updated: true, changed: 0 }));
  assert.equal(sheets['แก้ไขจากเว็บ (log)'], undefined);
});

test('bad input is refused before touching the sheet', () => {
  assert.equal(U.handle({ kind: 'cap', order: '#9-1', name: 'X' }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '9-1', name: 'X' }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '#9-1', number: '1234' }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '#9-1', number: 'ab' }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '#9-1', name: 'x'.repeat(21) }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '#9-1', name: '   ' }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '#9-1' }).ok, false);
  assert.equal(U.handle({ kind: 'shirt', order: '#77-1', name: 'X', number: '1' }).ok, false, 'unknown order');
  assert.deepEqual(sheets['Jersey ขาว'].data[1], ['2026-10-05', '#9-1', 'M', 'FLAG', '63', '']);
});

test('an order that appears twice is left alone', () => {
  sheets['Jersey เขียว'].data.push(['2026-10-06', '#9-1', 'S', 'DUP', '1', '']);
  const r = U.handle({ kind: 'shirt', order: '#9-1', name: 'X', number: '1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /มากกว่า 1/);
});

test('a missing column is reported, not guessed', () => {
  sheets['Jersey ขาว'].data[0][4] = 'something else';
  const r = U.handle({ kind: 'shirt', order: '#9-1', number: '1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /เลขหลังเสื้อ/);
});

test('ticking แจกแล้ว writes TRUE into that column of the cap row and logs it', () => {
  const r = U.handle({ kind: 'cap', order: '#21', given: true }, 'staff');
  assert.equal(JSON.stringify(r), JSON.stringify({ ok: true, updated: true, changed: 1 }));
  assert.equal(sheets['หมวก RCWD'].data[1][7], true);
  assert.equal(JSON.stringify(sheets['แก้ไขจากเว็บ (log)'].data[1].slice(4)), JSON.stringify(['#21', 'แจกแล้ว', 'false', 'true']));
  assert.equal(U.handle({ kind: 'cap', order: '#21', given: true }).changed, 0, 'already ticked: nothing to change');
  assert.equal(U.handle({ kind: 'cap', order: '#21', name: 'X' }).ok, false, 'caps: only the given flag');
  assert.equal(U.handle({ kind: 'shirt', order: '#9-1', given: true }).ok, false, 'shirt tab without a แจกแล้ว column is reported');
});

test('a busy sheet asks to retry', () => {
  locked = true;
  const r = U.handle({ kind: 'shirt', order: '#9-1', name: 'X', number: '1' });
  locked = false;
  assert.equal(r.ok, false);
});

console.log(`\n${passed} checks passed`);
