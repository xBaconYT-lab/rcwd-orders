// Renders apps-script/Email.gs in Node with stand-ins for the Code.gs helpers and Gmail, to check
// the recap's content, the sent-once log, quota handling and the missing-email path.
//   node tests/email.test.cjs   (also writes tests/out/email-sample.html for a visual check)
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');

const sent = [];
let quota = 100;
const logRows = [];
const props = {};
const logSheet = {
  getLastRow: () => logRows.length + 1,
  getRange: (r, c, n, w) => ({
    getValues: () => logRows.slice(r - 2, r - 2 + n).map((row) => row.slice(c - 1, c - 1 + w)),
    setValues() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setNote() { return this; },
  }),
  appendRow: (row) => { logRows.push(row.slice()); },
  setFrozenRows: () => {},
};
const ss = { getSheetByName: (n) => (n === 'อีเมลที่ส่งแล้ว (log)' ? logSheet : null), insertSheet: () => logSheet, getSheets: () => [] };

const order = (over) => Object.assign({
  id: 'resp1', name: 'สมชาย ใจดี', grade: 'ม.4', room: '3', phone: '0812345678', social: '@somchai',
  shirtList: [{ color: 'เขียว', size: 'l', backName: 'somchai', backNumber: '7' }, { color: 'ขาว', size: 'L', backName: 'SOMCHAI', backNumber: '7' }],
  hasCap: true, capQty: 2, delivery: 'จัดส่ง', shipName: 'สมชาย ใจดี', shipPhone: '0812345678', shipAddress: '99/1 ถ.ตัวอย่าง เขตพญาไท กรุงเทพฯ', shipZip: '10400',
  shipFee: 50, time: new Date('2026-10-05T04:10:00Z'),
}, over || {});
const response = (email, answers) => ({
  getId: () => 'resp1',
  getRespondentEmail: () => email,
  getItemResponses: () => (answers || []).map(([t, v]) => ({ getItem: () => ({ getTitle: () => t }), getResponse: () => v })),
});

const ctx = vm.createContext({
  // Gmail / Apps Script services
  GmailApp: { sendEmail: (to, subject, text, opts) => { sent.push({ to, subject, text, opts }); } },
  MailApp: { getRemainingDailyQuota: () => quota },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 16).replace('T', ' ') },
  SpreadsheetApp: { getUi: () => ({ alert: () => {}, ButtonSet: { OK: 1 } }), getActiveSpreadsheet: () => ({ toast: () => {} }) },
  // Code.gs helpers the module relies on
  RCWD: { tabs: { cap: 'หมวก RCWD' } }, NO_COLOR: 'ไม่ระบุสี', HEADER_BG: '#efefef',
  withLock_: (fn) => fn(),
  context_: () => ({ ss, form: { getResponses: () => [response('somchai@example.com')] } }),
  readSlipInfo_: () => ({ resp1: { no: 12, status: 'VERIFIED', paid: 1398 } }),
  slipSheet_: () => ({}),
  retry_: (fn) => fn(),
  toOrder_: () => order(),
  expectedAmount_: (o) => (o.shirtList.length === 2 ? 590 : 299) + (o.hasCap ? 279 + (o.capQty - 1) * 279 : 0),
  packageLabel_: (o) => ['เสื้อ ' + o.shirtList.length + ' ตัว', o.hasCap ? (o.capQty > 1 ? 'หมวก ' + o.capQty + ' ใบ' : 'หมวก') : ''].filter(Boolean).join(' + '),
  isShip_: (d) => /จัดส่ง/.test(String(d || '')),
  Logger: { log: () => {} }, JSON, Math, Object, Number, String, Error, Date, RegExp, isFinite,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Email.gs'), 'utf8'), ctx);

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

test('the recap lists every item, the paid amount, the shipping address and a plain-text twin', () => {
  const mail = ctx.buildOrderEmail_(order(), { no: 12, paid: 1398 });
  assert.equal(mail.subject, 'สรุปออเดอร์ #12 RCWD Jersey 2026 ของ สมชาย ใจดี');
  for (const s of ['RCWD Jersey สีเขียว', 'ไซซ์ L · ชื่อหลังเสื้อ SOMCHAI · เลข 7', 'RCWD Jersey สีขาว', 'หมวก RCWD', 'x 2', '1,398 บาท', '50 บาท', '99/1 ถ.ตัวอย่าง', '10400', 'เสื้อ 2 ตัว + หมวก 2 ใบ', 'ตอบกลับอีเมลนี้']) {
    assert.ok(mail.html.includes(s), 'html has ' + s);
  }
  for (const s of ['สวัสดีคุณสมชาย ใจดี', '- RCWD Jersey สีเขียว', 'ยอดที่ชำระ: 1,398 บาท', 'จัดส่งไปที่: สมชาย ใจดี · 0812345678 / 99/1', 'คุณได้รับอีเมลนี้เพราะ']) {
    assert.ok(mail.text.includes(s), 'text has ' + s);
  }
  assert.ok(!mail.html.includes('<script'), 'no scripts');
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'email-sample.html'), mail.html);
});

test('pickup orders say where to collect instead of an address, and escape HTML in names', () => {
  const mail = ctx.buildOrderEmail_(order({ delivery: 'รับที่โรงเรียน', name: 'A <b>bold</b>', hasCap: false, capQty: 0 }), { no: 3, paid: 590 });
  assert.ok(mail.html.includes('รับด้วยตัวเอง') && mail.html.includes('คณะราชาวดี') && !mail.html.includes('จัดส่งทางไปรษณีย์'));
  assert.ok(mail.html.includes('A &lt;b&gt;bold&lt;/b&gt;') && !mail.html.includes('<b>bold</b>'));
  assert.ok(!mail.html.includes('หมวก RCWD'), 'no cap row when none ordered');
});

test('a verified order is emailed once, with reply-to and a sender name, and logged', () => {
  const out = ctx.sendPendingOrderEmails_(ctx.context_(), 60000);
  assert.equal(out.sent, 1);
  assert.equal(sent[0].to, 'somchai@example.com');
  assert.equal(sent[0].opts.replyTo, 'rcwd.official@gmail.com');
  assert.equal(sent[0].opts.name, 'RCWD Jersey 2026');
  assert.ok(sent[0].opts.htmlBody.includes('#12') && sent[0].text.includes('#12'));
  assert.equal(logRows.length, 1);
  assert.equal(logRows[0][1], '#12');
  assert.equal(logRows[0][4], 'ส่งแล้ว');
  const again = ctx.sendPendingOrderEmails_(ctx.context_(), 60000);
  assert.equal(again.sent, 0, 'already sent: not sent twice');
  assert.equal(sent.length, 1);
});

test('no email on the form: logged as such, nothing sent; an email question in the form is picked up', () => {
  const r = ctx.emailOrder_({ ss }, response('', []), { no: 13, status: 'VERIFIED', paid: 299 });
  assert.equal(r, 'no_email');
  assert.equal(logRows[logRows.length - 1][4], 'ไม่มีอีเมล');
  const r2 = ctx.emailOrder_({ ss }, response('', [['อีเมลสำหรับติดต่อ', 'kid@example.com']]), { no: 14, status: 'VERIFIED', paid: 299 });
  assert.equal(r2, 'sent');
  assert.equal(sent[sent.length - 1].to, 'kid@example.com');
});

test('when the daily quota is nearly gone it stops instead of failing', () => {
  quota = 3;
  const r = ctx.emailOrder_({ ss }, response('x@example.com'), { no: 15, status: 'VERIFIED', paid: 299 });
  assert.equal(r, 'quota');
  quota = 100;
});

test('the web buttons: one order (refuses a repeat unless resend), all pending, and the emailed list', () => {
  const before = sent.length;
  const again = ctx.emailFromWeb_({ order: '#12' });
  assert.equal(again.ok, false, 'already sent: needs resend');
  assert.equal(sent.length, before);
  const re = ctx.emailFromWeb_({ order: '#12', resend: true });
  assert.equal(re.ok, true);
  assert.equal(sent.length, before + 1);
  assert.ok(re.emailed.includes('#12'));
  assert.equal(ctx.emailFromWeb_({ order: '#99' }).ok, false, 'unknown order');
  assert.equal(ctx.emailFromWeb_({ order: '12; drop' }).ok, false, 'bad order key');
  const all = ctx.emailFromWeb_({ all: true });
  assert.equal(all.ok, true);
  assert.equal(all.sent, 0, 'nothing left to send');
  assert.ok(all.emailed.includes('#12'));
});

test('settings from the web: saved in Script Properties, validated, and used by the next email', () => {
  assert.equal(ctx.emailFromWeb_({ settings: { replyTo: 'not-an-email' } }).ok, false);
  const r = ctx.emailFromWeb_({ settings: { fromName: 'ทีม RCWD', replyTo: 'team@example.com', pickupText: 'รับที่ห้อง 101' } });
  assert.equal(r.ok, true);
  assert.equal(r.settings.fromName, 'ทีม RCWD');
  assert.ok(JSON.parse(props.RCWD_EMAIL_SETTINGS).replyTo === 'team@example.com');
  assert.equal(ctx.emailFromWeb_({ settings: 'get' }).settings.pickupText, 'รับที่ห้อง 101');
  const mail = ctx.buildOrderEmail_(order({ delivery: 'รับเอง' }), { no: 5, paid: 299 });
  assert.ok(mail.html.includes('รับที่ห้อง 101'));
});

test('tester: sends a sample built from the chosen items to the given address, nothing logged', () => {
  const before = sent.length;
  const logged = logRows.length;
  assert.equal(ctx.emailFromWeb_({ test: { to: 'bad' } }).ok, false, 'needs an address');
  assert.equal(ctx.emailFromWeb_({ test: { to: 'me@example.com' } }).ok, false, 'needs at least one item');
  const r = ctx.emailFromWeb_({ test: { to: 'me@example.com', name: 'ทดสอบ', shirts: [{ color: 'ขาว', size: 'XL', name: 'tester', number: '9' }], caps: 2, ship: true, address: '1 ถนนทดสอบ' } });
  assert.equal(r.ok, true);
  const m = sent[sent.length - 1];
  assert.equal(sent.length, before + 1);
  assert.equal(m.to, 'me@example.com');
  assert.ok(m.subject.startsWith('[ทดสอบ] '));
  assert.ok(m.opts.htmlBody.includes('RCWD Jersey สีขาว') && m.opts.htmlBody.includes('x 2') && m.opts.htmlBody.includes('1 ถนนทดสอบ'));
  assert.equal(m.opts.replyTo, 'team@example.com', 'uses saved settings');
  assert.equal(logRows.length, logged, 'tests are not logged');
});

console.log(`\n${passed} checks passed`);
