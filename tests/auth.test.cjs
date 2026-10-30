// Runs apps-script/Auth.gs in Node with stand-ins for the Apps Script services
// (PropertiesService, CacheService, LockService, Utilities, ContentService), to
// check the kit's logic: hashing, lockouts, tokens, expiry, logout.
//   node tests/auth.test.cjs
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuf = (arr) => Buffer.from(arr.map((b) => (b < 0 ? b + 256 : b)));
const bytesOf = (x) => (Array.isArray(x) ? toBuf(x) : Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'utf8'));

let now = Date.parse('2026-10-28T09:00:00Z');
const props = new Map();
const cache = new Map();
let lockCalls = 0;

const Utilities = {
  newBlob: (x) => ({ getBytes: () => toSigned(bytesOf(x)), getDataAsString: () => bytesOf(x).toString('utf8') }),
  base64EncodeWebSafe: (bytes) => toBuf(bytes).toString('base64url'),
  base64DecodeWebSafe: (s) => toSigned(Buffer.from(String(s), 'base64url')),
  computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
  getUuid: () => crypto.randomUUID(),
};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (props.has(k) ? props.get(k) : null),
    setProperty: (k, v) => props.set(k, String(v)),
  }),
};
const CacheService = {
  getScriptCache: () => ({
    get: (k) => { const e = cache.get(k); if (!e || e.exp < now) { cache.delete(k); return null; } return e.v; },
    put: (k, v, s) => { cache.set(k, { v: String(v), exp: now + s * 1000 }); },
    remove: (k) => { cache.delete(k); },
  }),
};
const LockService = { getScriptLock: () => ({ tryLock: () => { lockCalls++; return true; }, releaseLock: () => {} }) };
const ContentService = { MimeType: { JSON: 'application/json' }, createTextOutput: (t) => ({ text: t, mime: '', setMimeType(m) { this.mime = m; return this; } }) };
const Logger = { log: () => {} };
class FakeDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}

const ctx = vm.createContext({ Utilities, PropertiesService, CacheService, LockService, ContentService, Logger, Date: FakeDate, JSON, Math, Object, Number, String, Error, parseInt });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Auth.gs'), 'utf8'), ctx);
const Auth = ctx.Auth;
const post = (body) => Auth.handle({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

test('without users the kit says so instead of accepting anything', () => {
  assert.equal(post({ action: 'login', username: 'staff', password: 'whatever' }).code, 'no_users');
});

test('setPassword stores a salted hash, never the password; names are case-insensitive', () => {
  Auth.setPassword(' Staff ', 'correct horse battery');
  const users = JSON.parse(props.get('AUTH_USERS'));
  assert.deepEqual(Object.keys(users), ['staff']);
  assert.ok(users.staff.salt && users.staff.hash && users.staff.rounds === 1000);
  assert.ok(!JSON.stringify([...props.values()]).includes('correct horse battery'));
  assert.throws(() => Auth.setPassword('x', 'short'), /8/);
});

test('bad bodies are refused', () => {
  assert.equal(post('not json').code, 'bad_request');
  assert.equal(post('[1,2').code, 'bad_request');
  assert.equal(post('x'.repeat(5000)).code, 'bad_request');
  assert.equal(Auth.handle({}).code, 'bad_request');
  assert.equal(post({ action: 'fly', token: 'abc' }).code, 'session');
});

test('a wrong password is refused and five tries lock the name for 15 minutes', () => {
  for (let i = 0; i < 5; i++) assert.equal(post({ action: 'login', username: 'STAFF', password: 'nope' + i }).code, 'invalid');
  assert.equal(post({ action: 'login', username: 'staff', password: 'correct horse battery' }).code, 'locked');
  now += 16 * 60 * 1000;
});

let token;
test('the right password signs in (any case of the name) and issues a 12-hour token', () => {
  const r = post({ username: 'StAfF', password: 'correct horse battery' }); // old page shape: no action
  assert.equal(r.ok, true);
  assert.equal(r.action, 'login');
  assert.equal(r.username, 'staff');
  assert.match(r.token, /^v1\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(Date.parse(r.expiresAt), now + 12 * 3600 * 1000);
  token = r.token;
  assert.ok(lockCalls > 0, 'counters are updated under the script lock');
});

test('refresh accepts the token and rejects tampered or foreign ones', () => {
  const r = post({ action: 'refresh', token });
  assert.equal(r.ok, true);
  assert.equal(r.username, 'staff');
  const parts = token.split('.');
  const tampered = [parts[0], parts[1], String(Number(parts[2]) + 3600000), parts[3], parts[4]].join('.');
  assert.equal(post({ action: 'refresh', token: tampered }).code, 'session');
  assert.equal(post({ action: 'refresh', token: token.slice(0, -2) + 'AA' }).code, 'session');
  assert.equal(post({ action: 'refresh', token: 'v1.a.b.c' }).code, 'session');
  assert.equal(post({ token: 'x'.repeat(600) }).code, 'session');
});

test('update passes the body through with the signed-in user, only for a live token', () => {
  const r = post({ action: 'update', token, kind: 'shirt', order: '#9-1', name: 'FLAG', number: '63' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'update');
  assert.equal(r.username, 'staff');
  assert.equal(r.body.order, '#9-1');
  assert.equal(post({ action: 'update', token: 'v1.a.b.c', kind: 'shirt' }).code, 'session');
});

test('logout revokes the token for good', () => {
  assert.equal(post({ action: 'logout', token }).ok, true);
  assert.equal(post({ action: 'refresh', token }).code, 'session');
  assert.ok(Object.keys(JSON.parse(props.get('AUTH_REVOKED'))).length === 1);
});

test('an expired token is a dead session, and the revocation list prunes itself', () => {
  const r = post({ action: 'login', username: 'staff', password: 'correct horse battery' });
  const fresh = r.token;
  now += 12 * 3600 * 1000 + 1000;
  assert.equal(post({ action: 'refresh', token: fresh }).code, 'session');
  const r2 = post({ action: 'login', username: 'staff', password: 'correct horse battery' });
  post({ action: 'logout', token: r2.token });
  assert.equal(Object.keys(JSON.parse(props.get('AUTH_REVOKED'))).length, 1, 'only the live revocation is kept');
});

test('a removed user cannot keep using an old token', () => {
  const r = post({ action: 'login', username: 'staff', password: 'correct horse battery' });
  Auth.removeUser('staff');
  assert.equal(post({ action: 'refresh', token: r.token }).code, 'session');
  Auth.setPassword('staff', 'correct horse battery');
});

test('fifty failures from anyone pause sign-in for everyone (no client IP exists in Apps Script)', () => {
  now += 20 * 60 * 1000;
  for (let i = 0; i < 50; i++) post({ action: 'login', username: 'ghost' + i, password: 'x'.repeat(8) });
  assert.equal(post({ action: 'login', username: 'staff', password: 'correct horse battery' }).code, 'busy');
  now += 11 * 60 * 1000;
  assert.equal(post({ action: 'login', username: 'staff', password: 'correct horse battery' }).ok, true);
});

test('json() wraps the answer for ContentService', () => {
  const out = Auth.json({ ok: true });
  assert.equal(out.text, '{"ok":true}');
  assert.equal(out.mime, 'application/json');
});

console.log(`\n${passed} checks passed`);
