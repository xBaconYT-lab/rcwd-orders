// node --test test/   (stand-ins for KV, Apps Script and the SMTP connection)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.js';

const ORIGIN = 'https://rcwd.leamm.com';
function setup(scriptReply) {
  const kv = new Map();
  const sent = [];
  const calls = [];
  const env = { ALLOWED_ORIGINS: ORIGIN, APPS_SCRIPT_URL: 'https://script.example/exec', KV: {
    get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); },
  } };
  const deps = {
    fetch: async (url, opts) => { const b = JSON.parse(opts.body); calls.push(b); return { status: 200, json: async () => scriptReply(b) }; },
    connect: async (o) => {
      if (o.credentials.password !== 'abcdabcdabcdabcd') throw new Error('535 bad credentials');
      return { send: async (m) => { if (m.to === 'boom@example.com') throw new Error('550 rejected'); sent.push(m); }, close: async () => {} };
    },
  };
  const call = (body, origin) => handle(new Request('https://mailer.example/', { method: 'POST', headers: { Origin: origin || ORIGIN }, body: JSON.stringify(body) }), env, deps).then((r) => r.json().then((j) => ({ status: r.status, j, r })));
  return { kv, sent, calls, call };
}
const ok = (b) => {
  if (b.token !== 'T') return { ok: false, error: 'เซสชันหมดอายุ', code: 'session' };
  if (b.settings) return { ok: true, settings: {} };
  if (b.prepare) return { ok: true, jobs: [{ no: '#1', to: 'a@example.com', name: 'A', subject: 's1', html: '<b>1</b>', text: '1' }, { no: '#2', to: 'boom@example.com', name: 'B', subject: 's2', html: '2', text: '2' }], noEmail: ['#3'], left: 4, fromName: 'RCWD', replyTo: 'r@example.com' };
  if (b.test) return { ok: true, jobs: [{ no: 'ทดสอบ', to: b.test.to, subject: '[ทดสอบ] x', html: 'h', text: 't' }] };
  if (b.logged) return { ok: true, emailed: b.logged.filter((x) => x.status === 'sent').map((x) => x.no) };
  return { ok: false };
};

test('other sites are refused', async () => {
  const { call } = setup(ok);
  assert.equal((await call({ action: 'settings', token: 'T' }, 'https://evil.example')).status, 403);
});

test('settings need a valid login, check the app password against Gmail, and never return it', async () => {
  const { call, kv } = setup(ok);
  assert.equal((await call({ action: 'settings', token: 'bad', gmail: 'x@gmail.com', appPassword: 'abcd abcd abcd abcd' })).j.code, 'session');
  assert.equal(kv.size, 0);
  assert.equal((await call({ action: 'settings', token: 'T', gmail: 'x@gmail.com', appPassword: 'short' })).j.ok, false);
  assert.match((await call({ action: 'settings', token: 'T', gmail: 'x@gmail.com', appPassword: 'zzzzzzzzzzzzzzzz' })).j.error, /ไม่รับ/);
  const r = await call({ action: 'settings', token: 'T', gmail: 'X@gmail.com', appPassword: 'abcd abcd abcd abcd' });
  assert.deepEqual(r.j, { ok: true, gmail: 'x@gmail.com', hasPassword: true });
  assert.equal(r.r.headers.get('access-control-allow-origin'), ORIGIN);
  const g = await call({ action: 'settings', token: 'T' });
  assert.ok(!JSON.stringify(g.j).includes('abcd'));
});

test('send all: one batch through Gmail, a failure does not stop the rest, results are logged in the sheet', async () => {
  const { call, sent, calls } = setup(ok);
  assert.match((await call({ action: 'send', all: true, token: 'T' })).j.error, /ยังไม่ได้ตั้ง/);
  await call({ action: 'settings', token: 'T', gmail: 'x@gmail.com', appPassword: 'abcdabcdabcdabcd' });
  const r = (await call({ action: 'send', all: true, token: 'T' })).j;
  assert.equal(r.sent, 1); assert.equal(r.failed, 1); assert.equal(r.left, 4); assert.equal(r.noEmail, 1);
  assert.deepEqual(r.emailed, ['#1']);
  assert.equal(sent[0].from.email, 'x@gmail.com'); assert.equal(sent[0].reply, 'r@example.com'); assert.equal(sent[0].html, '<b>1</b>');
  const log = calls.find((c) => c.logged).logged;
  assert.deepEqual(log.map((x) => x.status), ['sent', 'failed']);
  assert.match(log[1].note, /550/);
});

test('test email goes to the given address and is not logged', async () => {
  const { call, sent, calls } = setup(ok);
  await call({ action: 'settings', token: 'T', gmail: 'x@gmail.com', appPassword: 'abcdabcdabcdabcd' });
  const r = (await call({ action: 'test', token: 'T', test: { to: 'me@example.com', caps: 1 } })).j;
  assert.equal(r.ok, true); assert.equal(r.to, 'me@example.com');
  assert.equal(sent.at(-1).subject, '[ทดสอบ] x');
  assert.ok(!calls.some((c) => c.logged));
});
