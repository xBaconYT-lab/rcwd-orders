/**
 * Auth.gs — ชุดยืนยันตัวตนสำหรับ Web app ของ RCWD Jersey 2026
 * วางไฟล์นี้ในโปรเจกต์ Apps Script ของชีตคำตอบ (ไฟล์ > ใหม่ > สคริปต์ ตั้งชื่อ Auth)
 * แล้วแก้ doPost ตามตัวอย่างใน Code.gs.sample
 *
 * สิ่งที่ได้:
 *  - รหัสผ่านไม่อยู่ในโค้ดอีกต่อไป: เก็บเป็น salted hash (HMAC-SHA256 วนซ้ำ) ใน Script Properties
 *    ตั้งด้วย SETUP_setPassword() ครั้งเดียว แล้วลบรหัสออกจากโค้ด
 *  - หน้าเว็บส่งรหัสผ่านครั้งเดียวตอนเข้าสู่ระบบ จากนั้นใช้ "โทเค็น" ที่หมดอายุใน 12 ชั่วโมง
 *    (ลงนามด้วย HMAC-SHA256 ด้วยกุญแจลับที่สร้างอัตโนมัติ) ไม่ต้องเก็บรหัสผ่านไว้ในเบราว์เซอร์
 *  - ใส่รหัสผิด 5 ครั้ง/15 นาที ต่อชื่อผู้ใช้ จะถูกพักชั่วคราว และถ้าผิดรวมทุกคน 50 ครั้ง/10 นาที
 *    ระบบพักรับคำขอเข้าสู่ระบบชั่วคราว (Apps Script ไม่เห็น IP ของผู้เรียก จึงนับแบบนี้แทน)
 *  - เปรียบเทียบรหัสและลายเซ็นแบบเวลาคงที่, ออกจากระบบแล้วโทเค็นนั้นใช้ซ้ำไม่ได้
 *
 * โปรโตคอล (body เป็น JSON string ไม่มี header พิเศษ จึงไม่ติด CORS preflight):
 *   { action: "login",   username, password } -> { ok, token, expiresAt, ...ข้อมูล }
 *   { action: "refresh", token }              -> { ok, token, expiresAt, ...ข้อมูล }
 *   { action: "logout",  token }              -> { ok: true }
 *   { action: "update",  token, ... }         -> ผ่านต่อให้ Update.gs (คืน { ok, updated })
 *   { username, password } (หน้าเว็บเวอร์ชันเก่า) ทำงานเหมือน login
 * ตอบ { ok: false, error: ข้อความภาษาไทย, code } เมื่อไม่ผ่าน
 *
 * ข้อจำกัดที่ยังเหลือ (ตั้งใจเขียนไว้ตรง ๆ): ลิงก์ Web app เป็นสาธารณะและต้อง deploy แบบ "Anyone"
 * ใครก็ส่งคำขอได้ จึงต้องพึ่งรหัสผ่านที่ยาวและไม่ซ้ำกับที่อื่น; การพักรับคำขอทั้งระบบทำให้คนร้าย
 * ที่ยิงคำขอผิด ๆ รัว ๆ ทำให้ทีมงานเข้าไม่ได้ชั่วคราวได้ (แลกกับการไม่ให้เดารหัสได้ไม่จำกัด)
 */

var Auth = (function () {
  var SESSION_HOURS = 12;          // อายุโทเค็นหลังเข้าสู่ระบบ
  var USER_LOCK_AFTER = 5;         // ผิดกี่ครั้งต่อชื่อผู้ใช้ก่อนพัก
  var USER_LOCK_SECONDS = 15 * 60;
  var GLOBAL_LOCK_AFTER = 50;      // ผิดรวมทุกคนกี่ครั้งก่อนพักทั้งระบบ
  var GLOBAL_LOCK_SECONDS = 10 * 60;
  var HASH_ROUNDS = 1000;          // จำนวนรอบ HMAC ตอนแฮชรหัสผ่าน (ช้าลงเล็กน้อยเฉพาะตอนเข้าสู่ระบบ)
  var MAX_USERNAME = 64;
  var MAX_PASSWORD = 200;
  var MAX_BODY = 4096;             // คำขอใหญ่กว่านี้ไม่ใช่ของหน้าเว็บเรา

  var MESSAGES = {
    bad_request: 'คำขอไม่ถูกต้อง ลองรีเฟรชหน้าเว็บแล้วเข้าสู่ระบบใหม่',
    no_users: 'ยังไม่ได้ตั้งผู้ใช้ ให้แอดมินรัน SETUP_setPassword ใน Apps Script ก่อน',
    invalid: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง',
    locked: 'ใส่รหัสผิดหลายครั้ง พัก 15 นาทีแล้วลองใหม่',
    busy: 'มีการพยายามเข้าสู่ระบบผิดจำนวนมาก ระบบพักรับคำขอชั่วคราว ลองใหม่ภายหลัง',
    session: 'เซสชันหมดอายุ เข้าสู่ระบบอีกครั้ง',
  };

  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();

  // ---------- bytes / encoding ----------
  function utf8(text) { return Utilities.newBlob(String(text)).getBytes(); }
  function b64(bytes) { return Utilities.base64EncodeWebSafe(bytes); }
  function unb64(text) { return Utilities.base64DecodeWebSafe(String(text)); }
  function hmac(keyBytes, valueBytes) { return Utilities.computeHmacSha256Signature(valueBytes, keyBytes); }
  function randomBytes(n) {
    var out = [];
    while (out.length < n) {
      var hex = Utilities.getUuid().replace(/-/g, '');
      for (var i = 0; i < hex.length && out.length < n; i += 2) {
        var v = parseInt(hex.substr(i, 2), 16);
        out.push(v > 127 ? v - 256 : v); // Apps Script bytes are signed
      }
    }
    return out;
  }
  // เวลาคงที่: วนให้ครบความยาวเสมอ ไม่หยุดที่ตัวแรกที่ต่างกัน
  function constantTimeEqual(a, b) {
    var diff = a.length ^ b.length;
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= (a[i % a.length] ^ b[i % b.length]) & 0xff;
    return diff === 0;
  }

  // ---------- users (Script Properties: AUTH_USERS) ----------
  function normalizeUsername(name) { return String(name || '').trim().toLowerCase(); }
  function loadUsers() {
    try { return JSON.parse(props.getProperty('AUTH_USERS') || '{}') || {}; } catch (e) { return {}; }
  }
  function hashPassword(password, saltBytes) {
    var pw = utf8(password);
    var h = hmac(saltBytes, pw);
    for (var i = 1; i < HASH_ROUNDS; i++) h = hmac(h, pw);
    return h;
  }
  /** ตั้งหรือเปลี่ยนรหัสผ่านของผู้ใช้ (เรียกจาก SETUP_setPassword ในเครื่องมือแก้ไขเท่านั้น) */
  function setPassword(username, password) {
    var name = normalizeUsername(username);
    if (!name || name.length > MAX_USERNAME) throw new Error('ชื่อผู้ใช้ว่างหรือยาวเกินไป');
    if (!password || String(password).length < 8 || String(password).length > MAX_PASSWORD) throw new Error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');
    var users = loadUsers();
    var salt = randomBytes(16);
    users[name] = { salt: b64(salt), hash: b64(hashPassword(password, salt)), rounds: HASH_ROUNDS, updatedAt: new Date().toISOString() };
    props.setProperty('AUTH_USERS', JSON.stringify(users));
    return name;
  }
  function removeUser(username) {
    var users = loadUsers();
    delete users[normalizeUsername(username)];
    props.setProperty('AUTH_USERS', JSON.stringify(users));
  }
  function listUsers() { return Object.keys(loadUsers()); }

  // ---------- brute-force counters (CacheService, best effort) ----------
  function withLock(fn) {
    var lock = LockService.getScriptLock();
    var locked = lock.tryLock(5000);
    try { return fn(); } finally { if (locked) lock.releaseLock(); }
  }
  function count(key) { return Number(cache.get(key)) || 0; }
  function bump(key, seconds) {
    return withLock(function () {
      var n = count(key) + 1;
      cache.put(key, String(n), seconds);
      return n;
    });
  }
  function userKey(name) { return 'auth:fail:user:' + name; }
  var GLOBAL_KEY = 'auth:fail:all';

  // ---------- tokens ----------
  function secret() {
    var s = props.getProperty('AUTH_SECRET');
    if (!s) {
      s = b64(randomBytes(32));
      props.setProperty('AUTH_SECRET', s);
    }
    return unb64(s);
  }
  function sign(payload) { return b64(hmac(secret(), utf8(payload))); }
  function issueToken(name) {
    var exp = Date.now() + SESSION_HOURS * 3600 * 1000;
    var nonce = b64(randomBytes(16));
    var payload = ['v1', b64(utf8(name)), String(exp), nonce].join('.');
    return { token: payload + '.' + sign(payload), expiresAt: new Date(exp).toISOString(), nonce: nonce, exp: exp };
  }
  function loadRevoked() {
    try { return JSON.parse(props.getProperty('AUTH_REVOKED') || '{}') || {}; } catch (e) { return {}; }
  }
  function revoke(nonce, exp) {
    withLock(function () {
      var revoked = loadRevoked();
      var now = Date.now();
      Object.keys(revoked).forEach(function (k) { if (revoked[k] < now) delete revoked[k]; });
      revoked[nonce] = exp;
      props.setProperty('AUTH_REVOKED', JSON.stringify(revoked));
    });
  }
  /** คืน { username, nonce, exp } เมื่อโทเค็นถูกต้องและยังไม่หมดอายุ ไม่เช่นนั้นคืน null */
  function verifyToken(token) {
    var parts = String(token || '').split('.');
    if (parts.length !== 5 || parts[0] !== 'v1' || String(token).length > 512) return null;
    var payload = parts.slice(0, 4).join('.');
    if (!constantTimeEqual(utf8(sign(payload)), utf8(parts[4]))) return null;
    var exp = Number(parts[2]);
    if (!exp || exp < Date.now()) return null;
    var name;
    try { name = Utilities.newBlob(unb64(parts[1])).getDataAsString(); } catch (e) { return null; }
    if (!loadUsers()[name]) return null;             // ผู้ใช้ถูกลบไปแล้ว
    if (loadRevoked()[parts[3]]) return null;        // ออกจากระบบไปแล้ว
    return { username: name, nonce: parts[3], exp: exp };
  }

  // ---------- the request ----------
  function fail(code) { return { ok: false, error: MESSAGES[code] || MESSAGES.bad_request, code: code }; }

  function login(username, password) {
    var name = normalizeUsername(username);
    var pw = String(password || '');
    if (!name || name.length > MAX_USERNAME || !pw || pw.length > MAX_PASSWORD) return fail('invalid');
    if (count(GLOBAL_KEY) >= GLOBAL_LOCK_AFTER) return fail('busy');
    if (count(userKey(name)) >= USER_LOCK_AFTER) return fail('locked');
    var users = loadUsers();
    if (Object.keys(users).length === 0) return fail('no_users');
    var user = users[name];
    // ชื่อที่ไม่มีอยู่ก็แฮชหนึ่งรอบเท่ากับชื่อที่มีอยู่ (เทียบกับค่าหลอก) จะได้เดาชื่อผู้ใช้จากเวลาตอบไม่ได้
    var salt = user ? unb64(user.salt) : utf8('no-such-user-salt-');
    var expected = user ? unb64(user.hash) : utf8('no-such-user-hash-no-such-user-h');
    var ok = constantTimeEqual(hashPassword(pw, salt), expected) && !!user;
    if (!ok) {
      bump(userKey(name), USER_LOCK_SECONDS);
      bump(GLOBAL_KEY, GLOBAL_LOCK_SECONDS);
      return fail('invalid');
    }
    cache.remove(userKey(name));
    var t = issueToken(name);
    return { ok: true, action: 'login', username: name, token: t.token, expiresAt: t.expiresAt };
  }

  /**
   * ใช้ใน doPost: คืน { ok: true, action, username, token, expiresAt } เมื่อผ่าน
   * (action เป็น "login" / "refresh" / "logout") หรือ { ok: false, error, code } เมื่อไม่ผ่าน
   */
  function handle(e) {
    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > MAX_BODY) return fail('bad_request');
    var body;
    try { body = JSON.parse(raw); } catch (err) { return fail('bad_request'); }
    if (!body || typeof body !== 'object') return fail('bad_request');
    var action = body.action || (body.token ? 'refresh' : 'login');
    if (action === 'login') return login(body.username, body.password);
    var session = verifyToken(body.token);
    if (!session) return fail('session');
    if (action === 'logout') {
      revoke(session.nonce, session.exp);
      return { ok: true, action: 'logout', username: session.username };
    }
    if (action === 'refresh') {
      return { ok: true, action: 'refresh', username: session.username, token: body.token, expiresAt: new Date(session.exp).toISOString() };
    }
    if (action === 'update') {
      // แก้ไขข้อมูล: doPost ส่ง body ต่อให้ RCWD_UPDATE.handle (Update.gs) หลังผ่านการยืนยันตัวตนแล้ว
      return { ok: true, action: 'update', username: session.username, token: body.token, expiresAt: new Date(session.exp).toISOString(), body: body };
    }
    return fail('bad_request');
  }

  function json(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  }

  return { handle: handle, json: json, setPassword: setPassword, removeUser: removeUser, listUsers: listUsers, verifyToken: verifyToken };
})();

/**
 * ตั้งรหัสผ่านครั้งแรก: แก้ชื่อผู้ใช้และรหัสผ่านด้านล่าง เลือกฟังก์ชันนี้ในแถบเครื่องมือแล้วกด "เรียกใช้"
 * (ครั้งแรกจะถามสิทธิ์) เสร็จแล้วลบรหัสผ่านออกจากโค้ดนี้ ทำซ้ำได้ทุกครั้งที่อยากเปลี่ยนรหัสหรือเพิ่มคน
 */
function SETUP_setPassword() {
  var name = Auth.setPassword('staff', 'เปลี่ยนรหัสนี้ก่อนรัน');
  Logger.log('ตั้งรหัสผ่านของ "%s" แล้ว ผู้ใช้ทั้งหมด: %s', name, Auth.listUsers().join(', '));
}
