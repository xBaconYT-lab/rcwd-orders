// rcwd-mailer: ส่งอีเมลสรุปออเดอร์ให้ลูกค้าผ่าน Gmail SMTP (app password) แทนการส่งจาก Apps Script
//
// หน้าเช็กลิสต์ POST JSON มาที่นี่พร้อมการเข้าสู่ระบบเดิม (token หรือ username/password) ซึ่งส่งต่อให้ Apps Script ตรวจ
//   { action: 'settings' }                              อ่าน Gmail ที่ตั้งไว้ (ไม่คืนรหัส)
//   { action: 'settings', gmail, appPassword }          บันทึก (appPassword ว่าง = ใช้รหัสเดิม)
//   { action: 'send', order: '#12', resend }            ส่งออเดอร์เดียว
//   { action: 'send', all: true }                       ส่งออเดอร์ที่ยังไม่ได้ส่ง ทีละ BATCH ฉบับ (หน้าเว็บเรียกซ้ำจน left = 0)
//   { action: 'test', test: {...} }                     ส่งอีเมลทดสอบจากของที่เลือกเอง
// Apps Script เตรียมเนื้อหาและอีเมลลูกค้า (อีเมลลูกค้าไม่ผ่านเบราว์เซอร์) แล้วจดผลการส่งลง log ไม่แก้ข้อมูลออเดอร์
const BATCH = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SMTP = { host: 'smtp.gmail.com', port: 465, secure: true, authType: 'plain' };

export async function handle(req, env, deps) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).includes(origin);
  const reply = (o, status) => new Response(JSON.stringify(o), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
  });
  if (!allowed) return reply({ ok: false, error: 'forbidden' }, 403);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST', 'access-control-max-age': '86400', vary: 'Origin' } });
  }
  if (req.method !== 'POST') return reply({ ok: false, error: 'POST only' }, 405);

  let body;
  try { body = JSON.parse(await req.text()); } catch (e) { return reply({ ok: false, error: 'อ่านคำขอไม่ได้' }, 400); }
  if (!body || typeof body !== 'object') return reply({ ok: false, error: 'อ่านคำขอไม่ได้' }, 400);
  const auth = {};
  for (const k of ['token', 'username', 'password']) if (typeof body[k] === 'string') auth[k] = body[k];

  // ทุกคำขอถาม Apps Script ก่อน: ผ่านการตรวจสิทธิ์ที่นั่นเท่านั้นถึงทำต่อ
  const script = async (extra) => {
    const res = await deps.fetch(env.APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify(Object.assign({}, auth, { action: 'email' }, extra)), redirect: 'follow' });
    let json;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!json || typeof json !== 'object') throw new Error('Google Sheet ตอบกลับอ่านไม่ได้ (HTTP ' + res.status + ')');
    return json;
  };

  try {
    if (body.action === 'settings') {
      const check = await script({ settings: 'get' });
      if (!check.ok) return reply(check);
      if (body.gmail !== undefined || body.appPassword) {
        const cur = (await env.KV.get('smtp', 'json')) || {};
        const gmail = String(body.gmail === undefined ? cur.gmail || '' : body.gmail).trim().toLowerCase();
        const pass = String(body.appPassword || '').replace(/\s+/g, '');
        if (gmail && !EMAIL_RE.test(gmail)) return reply({ ok: false, error: 'อีเมล Gmail ไม่ถูกต้อง' });
        if (pass && !/^[a-z]{16}$/i.test(pass)) return reply({ ok: false, error: 'App password ต้องเป็นตัวอักษร 16 ตัว (ที่ Google ให้มา เว้นวรรคได้)' });
        const next = { gmail, appPassword: pass || (gmail === cur.gmail ? cur.appPassword || '' : '') };
        if (next.gmail && next.appPassword) {
          // ลองเข้า Gmail ก่อนบันทึก รหัสผิดจะรู้ทันที
          try { const m = await connect(deps, next); await m.close(); } catch (e) { return reply({ ok: false, error: 'Gmail ไม่รับ app password นี้: ' + errText(e) }); }
        }
        await env.KV.put('smtp', JSON.stringify(next));
      }
      const saved = (await env.KV.get('smtp', 'json')) || {};
      return reply({ ok: true, gmail: saved.gmail || '', hasPassword: !!saved.appPassword });
    }

    if (body.action === 'send' || body.action === 'test') {
      const creds = (await env.KV.get('smtp', 'json')) || {};
      if (!creds.gmail || !creds.appPassword) return reply({ ok: false, error: 'ยังไม่ได้ตั้ง Gmail กับ app password (ตั้งค่าและทดสอบอีเมล)' });
      const prep = body.action === 'test'
        ? await script({ test: body.test || {}, prepareOnly: true })
        : await script({ prepare: body.all === true ? { all: true, limit: BATCH } : { order: body.order, resend: body.resend === true } });
      if (!prep.ok) return reply(prep);
      const jobs = Array.isArray(prep.jobs) ? prep.jobs.slice(0, BATCH) : [];
      const results = await sendAll(deps, creds, prep, jobs);
      const sent = results.filter((r) => r.status === 'sent').length;
      const out = { ok: true, sent, failed: results.length - sent, noEmail: (prep.noEmail || []).length, left: prep.left || 0, errors: results.filter((r) => r.status !== 'sent').map((r) => r.no + ': ' + r.note) };
      if (body.action === 'test') {
        if (!sent) return reply({ ok: false, error: 'ส่งอีเมลทดสอบไม่ได้: ' + (out.errors[0] || '') });
        return reply(Object.assign(out, { to: jobs[0].to }));
      }
      const logged = await script({ logged: results });
      if (Array.isArray(logged.emailed)) out.emailed = logged.emailed;
      if (!all(body) && !sent) return reply({ ok: false, error: out.errors[0] || ('ออเดอร์ ' + body.order + ' ไม่มีอีเมลลูกค้า') });
      return reply(out);
    }
    return reply({ ok: false, error: 'ไม่รู้จักคำสั่งนี้' }, 400);
  } catch (e) {
    return reply({ ok: false, error: errText(e) }, 502);
  }
}

const all = (body) => body.all === true;
const errText = (e) => String((e && e.message) || e).slice(0, 300);

function connect(deps, creds) {
  return deps.connect(Object.assign({ credentials: { username: creds.gmail, password: creds.appPassword }, socketTimeoutMs: 20000, responseTimeoutMs: 20000 }, SMTP));
}

// หนึ่งการเชื่อมต่อต่อชุด ส่งทีละฉบับ ฉบับที่พังไม่ทำให้ฉบับอื่นพัง
async function sendAll(deps, creds, prep, jobs) {
  if (!jobs.length) return [];
  let mailer;
  try { mailer = await connect(deps, creds); } catch (e) {
    return jobs.map((j) => ({ no: j.no, to: j.to, name: j.name, status: 'failed', note: 'เข้า Gmail ไม่ได้: ' + errText(e) }));
  }
  const results = [];
  for (const j of jobs) {
    try {
      if (!EMAIL_RE.test(String(j.to || ''))) throw new Error('อีเมลลูกค้าไม่ถูกต้อง');
      await mailer.send({
        from: { name: prep.fromName || 'RCWD Jersey 2026', email: creds.gmail },
        to: j.to,
        reply: prep.replyTo && EMAIL_RE.test(prep.replyTo) ? prep.replyTo : undefined,
        subject: String(j.subject || ''),
        text: String(j.text || ''),
        html: String(j.html || ''),
      });
      results.push({ no: j.no, to: j.to, name: j.name, status: 'sent', note: 'ส่งผ่าน Gmail SMTP' });
    } catch (e) {
      results.push({ no: j.no, to: j.to, name: j.name, status: 'failed', note: errText(e) });
    }
  }
  try { await mailer.close(); } catch (e) { /* already closed */ }
  return results;
}
