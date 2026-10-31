/**
 * Email.gs — ส่งอีเมลสรุปออเดอร์ให้ลูกค้า (RCWD Jersey 2026)
 *
 * ส่งจากบัญชี Google ที่เป็นเจ้าของสคริปต์นี้ (rcwd.official@gmail.com) ผ่าน GmailApp จึงไม่ต้องใช้ App Password
 * และไปถึงกล่องขาเข้าได้ดีกว่าการส่งผ่าน SMTP ภายนอก (มี SPF/DKIM ของ Gmail ให้เอง)
 * ถ้าสคริปต์อยู่ในบัญชีอื่น: ตั้ง "ส่งอีเมลในชื่อ" (Gmail > การตั้งค่า > บัญชี) เป็น rcwd.official@gmail.com แล้วใส่ใน CONFIG.from
 *
 * อ่านข้อมูลจากฟอร์มกับแท็บตรวจสลิปอย่างเดียว ไม่แก้แถวไหน แค่จดผลการส่งไว้ในแท็บ "อีเมลที่ส่งแล้ว (log)"
 * (ส่งแล้วไม่ส่งซ้ำ ยกเว้นกดส่งซ้ำเอง)
 *
 * ติดตั้ง (ใน Apps Script ของชีต):
 *  1. ไฟล์ > เพิ่มสคริปต์ ชื่อ Email แล้ววางไฟล์นี้ทั้งไฟล์ ปรับ CONFIG ด้านล่าง
 *  2. ใน onOpen เพิ่มเมนู (ก่อน .addSeparator()):
 *       .addItem('ส่งอีเมลสรุปออเดอร์ (ที่ยังไม่ได้ส่ง)', 'sendOrderEmailsFromMenu')
 *       .addItem('ส่งอีเมลทดสอบมาหาฉัน', 'sendTestOrderEmail')
 *  3. (ถ้าอยากให้ส่งเองทันทีที่สลิปผ่าน) ใน onOrderSubmit หลัง syncOrder_(...) เพิ่ม
 *       if (slip.status === 'VERIFIED') try { emailOrderIfNeeded_(ctx, e.response); } catch (err) { Logger.log(err); }
 *  4. รัน sendTestOrderEmail ครั้งแรก Google จะขอสิทธิ์ Gmail กด Allow แล้วเปิดดูอีเมลที่ได้
 *
 * โควตา: บัญชี Gmail ธรรมดาส่งได้ประมาณ 100 ฉบับต่อวัน สคริปต์หยุดเองเมื่อโควตาหมด กดเมนูอีกครั้งวันถัดไปจะส่งต่อจากที่ค้าง
 * อีเมลลูกค้า: ใช้อีเมลที่ Google Form เก็บ (ตั้งค่าฟอร์ม > เก็บอีเมล) หรือคำถามในฟอร์มที่ชื่อมีคำว่า "อีเมล"/"email"
 */
const RCWD_EMAIL = {
  from: '',                                   // ว่าง = บัญชีเจ้าของสคริปต์; หรือใส่ alias ที่ตั้ง "ส่งอีเมลในชื่อ" ไว้ เช่น 'rcwd.official@gmail.com'
  fromName: 'RCWD Jersey 2026',
  replyTo: 'rcwd.official@gmail.com',
  subject: 'สรุปออเดอร์ #{no} RCWD Jersey 2026 ของ {name}',
  // ข้อความส่วนรับของ แก้ได้ตามจริง
  pickupText: 'รับของได้ที่คณะราชาวดี ตามวันเวลาที่จะประกาศทาง IG @rcwd.official',
  shipText: 'ทีมงานจะส่งพัสดุตามที่อยู่ด้านล่าง และแจ้งเลขพัสดุทางช่องทางติดต่อที่ให้ไว้',
  contactLine: 'สอบถาม: IG @rcwd.official หรือตอบกลับอีเมลนี้',
  footerWhy: 'คุณได้รับอีเมลนี้เพราะสั่งซื้อเสื้อ/หมวกผ่านฟอร์มของคณะราชาวดี อีเมลนี้ส่งครั้งเดียวต่อออเดอร์',
  logSheet: 'อีเมลที่ส่งแล้ว (log)',
  keepQuota: 5,                               // เหลือโควตาไว้เผื่อส่งทดสอบ/ตอบลูกค้า
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ================= เมนู =================

function sendOrderEmailsFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const out = withLock_(() => sendPendingOrderEmails_(context_(), 4 * 60 * 1000));
  let msg = 'ส่งแล้ว ' + out.sent + ' ฉบับ';
  if (out.noEmail) msg += ', ไม่มีอีเมล ' + out.noEmail + ' ออเดอร์ (ดูแท็บ log)';
  if (out.failed) msg += ', ส่งไม่ได้ ' + out.failed;
  if (out.left) msg += ', ยังค้าง ' + out.left + ' (' + (out.quotaOut ? 'โควตาวันนี้หมด กดใหม่พรุ่งนี้' : 'กดเมนูอีกครั้ง') + ')';
  ui.alert('อีเมลสรุปออเดอร์', msg, ui.ButtonSet.OK);
}

/** ส่งตัวอย่างอีเมลของออเดอร์แรกที่สลิปผ่าน มาที่อีเมลของคนรันสคริปต์ (ไม่จดลง log) */
function sendTestOrderEmail() {
  const me = Session.getEffectiveUser().getEmail();
  const ctx = context_();
  const info = readSlipInfo_(slipSheet_(ctx.ss));
  const responses = retry_(() => ctx.form.getResponses());
  let picked = null;
  for (let i = 0; i < responses.length && !picked; i++) {
    const meta = info[responses[i].getId()];
    if (meta && meta.no && String(meta.status).toUpperCase() === 'VERIFIED') picked = { response: responses[i], meta: meta };
  }
  if (!picked) throw new Error('ยังไม่มีออเดอร์ที่สลิปผ่าน ให้ส่งตัวอย่าง');
  const mail = buildOrderEmail_(toOrder_(picked.response, ctx), picked.meta);
  deliverEmail_(me, '[ทดสอบ] ' + mail.subject, mail);
  SpreadsheetApp.getActiveSpreadsheet().toast('ส่งตัวอย่างไปที่ ' + me + ' แล้ว (ออเดอร์ #' + picked.meta.no + ')', 'อีเมลทดสอบ', 8);
}

// ================= ส่ง =================

/** ส่งให้ทุกออเดอร์ที่สลิปผ่านและยังไม่เคยส่ง ภายในเวลาและโควตาที่มี */
function sendPendingOrderEmails_(ctx, budgetMs) {
  const start = Date.now();
  const info = readSlipInfo_(slipSheet_(ctx.ss));
  const sentBefore = readEmailLog_(ctx.ss);
  const out = { sent: 0, noEmail: 0, failed: 0, left: 0, quotaOut: false };
  retry_(() => ctx.form.getResponses()).forEach(response => {
    const meta = info[response.getId()];
    if (!meta || !meta.no || String(meta.status).toUpperCase() !== 'VERIFIED') return;
    if (sentBefore[meta.no]) return;
    if (out.quotaOut || Date.now() - start > budgetMs) { out.left++; return; }
    const r = emailOrder_(ctx, response, meta);
    if (r === 'sent') out.sent++;
    else if (r === 'no_email') out.noEmail++;
    else if (r === 'quota') { out.quotaOut = true; out.left++; }
    else out.failed++;
  });
  return out;
}

/** เรียกจาก onOrderSubmit: ส่งถ้ายังไม่เคยส่งออเดอร์นี้ */
function emailOrderIfNeeded_(ctx, response) {
  const info = readSlipInfo_(slipSheet_(ctx.ss));
  const meta = info[response.getId()];
  if (!meta || !meta.no || String(meta.status).toUpperCase() !== 'VERIFIED') return 'skipped';
  if (readEmailLog_(ctx.ss)[meta.no]) return 'already';
  return emailOrder_(ctx, response, meta);
}

/** ส่งอีเมลออเดอร์เดียว คืน 'sent' | 'no_email' | 'quota' | 'failed' และจดลง log */
function emailOrder_(ctx, response, meta) {
  const order = toOrder_(response, ctx);
  const to = customerEmail_(response, order);
  if (!to) {
    logEmail_(ctx.ss, meta.no, '', order.name || '', 'ไม่มีอีเมล', 'ฟอร์มไม่ได้เก็บอีเมล หรือกรอกไม่ถูกต้อง');
    return 'no_email';
  }
  if (MailApp.getRemainingDailyQuota() <= RCWD_EMAIL.keepQuota) return 'quota';
  const mail = buildOrderEmail_(order, meta);
  try {
    deliverEmail_(to, mail.subject, mail);
    logEmail_(ctx.ss, meta.no, to, order.name || '', 'ส่งแล้ว', '');
    return 'sent';
  } catch (err) {
    logEmail_(ctx.ss, meta.no, to, order.name || '', 'ส่งไม่ได้', String(err && err.message ? err.message : err));
    return 'failed';
  }
}

function deliverEmail_(to, subject, mail) {
  const opts = { htmlBody: mail.html, name: RCWD_EMAIL.fromName, replyTo: RCWD_EMAIL.replyTo, noReply: false };
  if (RCWD_EMAIL.from) opts.from = RCWD_EMAIL.from;
  GmailApp.sendEmail(to, subject, mail.text, opts);
}

// อีเมลลูกค้า: ที่ฟอร์มเก็บไว้ ไม่ก็คำตอบที่ดูเป็นอีเมล
function customerEmail_(response, order) {
  let email = '';
  try { email = String(response.getRespondentEmail() || '').trim(); } catch (e) { email = ''; }
  if (!EMAIL_RE.test(email)) {
    email = '';
    response.getItemResponses().forEach(ir => {
      if (email) return;
      const title = String(ir.getItem().getTitle() || '').toLowerCase();
      const v = String(ir.getResponse() || '').trim();
      if ((title.indexOf('อีเมล') !== -1 || title.indexOf('email') !== -1 || title.indexOf('e-mail') !== -1) && EMAIL_RE.test(v)) email = v;
    });
  }
  return email;
}

// ================= log =================

function emailLogSheet_(ss) {
  let sh = ss.getSheetByName(RCWD_EMAIL.logSheet);
  if (!sh) {
    sh = ss.insertSheet(RCWD_EMAIL.logSheet, ss.getSheets().length);
    sh.getRange(1, 1, 1, 6).setValues([['เวลา', 'ออเดอร์', 'อีเมล', 'ชื่อ', 'สถานะ', 'หมายเหตุ']]).setFontWeight('bold').setBackground(HEADER_BG);
    sh.setFrozenRows(1);
    sh.getRange('A1').setNote('สคริปต์จดการส่งอีเมลสรุปออเดอร์ไว้ที่นี่ ออเดอร์ที่มี "ส่งแล้ว" จะไม่ถูกส่งซ้ำ ลบแถวนั้นถ้าต้องการส่งใหม่');
  }
  return sh;
}
function logEmail_(ss, no, to, name, status, note) {
  emailLogSheet_(ss).appendRow([new Date(), '#' + no, to, name, status, note]);
}
// เลขออเดอร์ที่ส่งแล้ว -> true
function readEmailLog_(ss) {
  const sh = ss.getSheetByName(RCWD_EMAIL.logSheet);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 2, sh.getLastRow() - 1, 4).getValues().forEach(r => {
    const m = String(r[0]).match(/^#(\d+)/);
    if (m && String(r[3]).trim() === 'ส่งแล้ว') map[m[1]] = true;
  });
  return map;
}

// ================= เนื้อหาอีเมล =================

function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function bahtText_(n) {
  const v = Math.round(Number(n) || 0);
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' บาท';
}
function thaiDate_(d) {
  if (!d || typeof d.getTime !== 'function') return '';
  return Utilities.formatDate(d, 'Asia/Bangkok', 'd MMM yyyy HH:mm');
}

/** รายการ + ยอด + การรับของ ของออเดอร์หนึ่ง (ใช้ทั้งในอีเมลและข้อความล้วน) */
function orderSummary_(order, meta) {
  const items = (order.shirtList || []).map((s, i) => ({
    kind: 'shirt',
    title: 'RCWD Jersey สี' + (s.color || NO_COLOR),
    detail: 'ไซซ์ ' + (s.size || '-').toUpperCase() + ' · ชื่อหลังเสื้อ ' + (s.backName || '-').toUpperCase() + ' · เลข ' + (s.backNumber || '-'),
    qty: 1,
  }));
  if (order.hasCap) items.push({ kind: 'cap', title: RCWD.tabs.cap, detail: '', qty: order.capQty || 1 });
  const expected = expectedAmount_(order);
  const paid = meta && meta.paid !== '' && meta.paid !== null && isFinite(Number(meta.paid)) ? Number(meta.paid) : expected;
  const ship = isShip_(order.delivery);
  const address = ship
    ? [[order.shipName || order.name, order.shipPhone || order.phone].filter(Boolean).join(' · '),
       [order.shipAddress, order.shipZip].filter(Boolean).join(' ')].concat(order.shipNotes || []).filter(Boolean)
    : [];
  return {
    no: meta && meta.no ? String(meta.no) : '',
    name: order.name || '',
    cls: [order.grade, order.room ? 'ห้อง ' + order.room : ''].filter(Boolean).join(' '),
    items: items,
    packageLabel: packageLabel_(order),
    amount: expected,
    paid: paid,
    shipFee: ship ? (order.shipFee || 0) : 0,
    ship: ship,
    address: address,
    orderedAt: thaiDate_(order.time),
  };
}

function buildOrderEmail_(order, meta) {
  const s = orderSummary_(order, meta);
  const subject = RCWD_EMAIL.subject.replace('{no}', s.no).replace('{name}', s.name || 'คุณลูกค้า');

  // ---- ข้อความล้วน (สำหรับโปรแกรมอีเมลที่ไม่แสดง HTML และช่วยเรื่องสแปม) ----
  const lines = [];
  lines.push('สวัสดีคุณ' + (s.name || 'ลูกค้า'));
  lines.push('ทีมงานได้รับยอดชำระของออเดอร์ #' + s.no + ' เรียบร้อยแล้ว นี่คือสรุปรายการที่สั่ง');
  lines.push('');
  s.items.forEach(it => lines.push('- ' + it.title + (it.detail ? ' (' + it.detail + ')' : '') + (it.qty > 1 ? ' x ' + it.qty : '')));
  lines.push('');
  lines.push('รายการ: ' + s.packageLabel);
  lines.push('ยอดที่ชำระ: ' + bahtText_(s.paid));
  if (s.ship) {
    lines.push('ค่าจัดส่ง: ' + bahtText_(s.shipFee) + ' (โอนแยก)');
    lines.push('จัดส่งไปที่: ' + s.address.join(' / '));
    lines.push(RCWD_EMAIL.shipText);
  } else {
    lines.push('การรับของ: รับด้วยตัวเอง');
    lines.push(RCWD_EMAIL.pickupText);
  }
  lines.push('');
  lines.push('ถ้าข้อมูลไม่ถูกต้อง ตอบกลับอีเมลนี้ได้เลย');
  lines.push(RCWD_EMAIL.contactLine);
  lines.push('');
  lines.push(RCWD_EMAIL.footerWhy);
  const text = lines.join('\n');

  // ---- HTML: ตารางซ้อน + สไตล์ inline (โปรแกรมอีเมลส่วนใหญ่ไม่รองรับ CSS สมัยใหม่) ----
  const ink = '#12332b', muted = '#5a6f68', line = '#d9e6df', green = '#27805f', soft = '#eef5f1';
  const font = "font-family:'Prompt',-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Noto Sans Thai',sans-serif;";
  const td = 'padding:10px 12px;border-bottom:1px solid ' + line + ';' + font + 'font-size:15px;line-height:1.5;color:' + ink + ';';
  const itemRows = s.items.map(it =>
    '<tr>' +
      '<td style="' + td + 'vertical-align:top;">' +
        '<div style="font-weight:600;">' + esc_(it.title) + '</div>' +
        (it.detail ? '<div style="color:' + muted + ';font-size:14px;">' + esc_(it.detail) + '</div>' : '') +
      '</td>' +
      '<td style="' + td + 'text-align:right;white-space:nowrap;vertical-align:top;">' + (it.qty > 1 ? 'x ' + it.qty : '1') + '</td>' +
    '</tr>').join('');
  const kv = (k, v, strong) =>
    '<tr><td style="padding:6px 0;' + font + 'font-size:15px;color:' + muted + ';">' + esc_(k) + '</td>' +
    '<td style="padding:6px 0;' + font + 'font-size:15px;color:' + ink + ';text-align:right;' + (strong ? 'font-weight:700;' : '') + '">' + v + '</td></tr>';
  const delivery = s.ship
    ? '<div style="font-weight:600;margin-bottom:4px;">จัดส่งทางไปรษณีย์</div>' +
      '<div style="color:' + muted + ';">' + s.address.map(esc_).join('<br>') + '</div>' +
      '<div style="margin-top:8px;">' + esc_(RCWD_EMAIL.shipText) + '</div>'
    : '<div style="font-weight:600;margin-bottom:4px;">รับด้วยตัวเอง</div>' +
      '<div>' + esc_(RCWD_EMAIL.pickupText) + '</div>';
  const html =
    '<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>' + esc_(subject) + '</title></head>' +
    '<body style="margin:0;padding:0;background:' + soft + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;color:transparent;">สรุปออเดอร์ #' + esc_(s.no) + ' · ' + esc_(s.packageLabel) + ' · ' + esc_(bahtText_(s.paid)) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + soft + ';">' +
    '<tr><td align="center" style="padding:24px 12px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border:1px solid ' + line + ';border-radius:14px;overflow:hidden;">' +
      // header band
      '<tr><td style="background:' + green + ';padding:22px 24px;' + font + '">' +
        '<div style="font-size:26px;font-weight:700;letter-spacing:0.04em;color:#ffffff;line-height:1;">RCWD</div>' +
        '<div style="font-size:14px;color:#dcefe6;margin-top:6px;">Jersey 2026 · คณะราชาวดี</div>' +
      '</td></tr>' +
      // greeting
      '<tr><td style="padding:24px 24px 8px;' + font + 'color:' + ink + ';">' +
        '<div style="font-size:13px;color:' + muted + ';text-transform:uppercase;letter-spacing:0.08em;">ออเดอร์ #' + esc_(s.no) + (s.orderedAt ? ' · ' + esc_(s.orderedAt) : '') + '</div>' +
        '<div style="font-size:22px;font-weight:700;margin-top:6px;line-height:1.3;">สวัสดีคุณ' + esc_(s.name || 'ลูกค้า') + (s.cls ? ' <span style="font-weight:400;color:' + muted + ';font-size:16px;">(' + esc_(s.cls) + ')</span>' : '') + '</div>' +
        '<div style="font-size:15px;line-height:1.6;margin-top:8px;">ทีมงานได้รับยอดชำระของคุณเรียบร้อยแล้ว นี่คือสรุปรายการที่สั่ง เก็บอีเมลนี้ไว้ใช้ตอนรับของได้เลย</div>' +
      '</td></tr>' +
      // items
      '<tr><td style="padding:16px 24px 0;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ' + line + ';">' +
          '<tr><td style="padding:10px 12px 6px;' + font + 'font-size:13px;color:' + muted + ';">รายการ</td><td style="padding:10px 12px 6px;' + font + 'font-size:13px;color:' + muted + ';text-align:right;">จำนวน</td></tr>' +
          itemRows +
        '</table>' +
      '</td></tr>' +
      // totals
      '<tr><td style="padding:12px 24px 0;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
          kv('รายการ', esc_(s.packageLabel)) +
          kv('ยอดที่ชำระ (สลิปผ่านแล้ว)', esc_(bahtText_(s.paid)), true) +
          (s.ship ? kv('ค่าจัดส่ง (โอนแยก)', esc_(bahtText_(s.shipFee))) : '') +
        '</table>' +
      '</td></tr>' +
      // delivery
      '<tr><td style="padding:16px 24px 0;">' +
        '<div style="background:' + soft + ';border-radius:10px;padding:14px 16px;' + font + 'font-size:15px;line-height:1.55;color:' + ink + ';">' + delivery + '</div>' +
      '</td></tr>' +
      // footer
      '<tr><td style="padding:20px 24px 24px;' + font + 'font-size:14px;line-height:1.6;color:' + muted + ';">' +
        'ถ้าข้อมูลไม่ถูกต้อง ตอบกลับอีเมลนี้ได้เลย<br>' + esc_(RCWD_EMAIL.contactLine) +
        '<div style="border-top:1px solid ' + line + ';margin-top:16px;padding-top:12px;font-size:12px;">' + esc_(RCWD_EMAIL.footerWhy) + '</div>' +
      '</td></tr>' +
    '</table>' +
    '</td></tr></table></body></html>';

  return { subject: subject, text: text, html: html };
}
