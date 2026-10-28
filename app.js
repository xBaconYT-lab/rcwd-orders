/* RCWD Jersey 2026 — app.js (served from this site: the page's CSP is script-src 'self'). */
(() => {
  'use strict';

  // ---------- guards ----------
  // GitHub Pages cannot send X-Frame-Options, so the page refuses to work inside another site's frame.
  if (window.top !== window.self) {
    const p = document.createElement('p');
    p.className = 'framed';
    p.textContent = 'เปิดหน้านี้โดยตรง ไม่รองรับการฝังในเว็บอื่น';
    document.body.replaceChildren(p);
    return;
  }
  // GitHub Pages has "Enforce HTTPS"; this also catches an old http:// bookmark before anything is typed.
  if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    location.replace('https://' + location.host + location.pathname + location.search);
    return;
  }

  const API_URL = String(window.RCWD_API_URL || '').trim();
  const DEMO = new URLSearchParams(location.search).has('demo');
  const SESSION_KEY = 'rcwd-session';
  const UI_KEY = 'rcwd-ui';            // the last category opened (no personal data), so the app reopens where it was
  const LEGACY_KEYS = ['rcwd-auth']; // older versions kept the password here
  const STALE_MS = 5 * 60 * 1000;    // auto-refresh when the tab comes back after this long
  const FETCH_TIMEOUT_MS = 25000;
  const STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

  const state = { data: null, auth: null, view: '', from: '', to: '', q: '', loadedAt: 0, busy: false, withOrder: false, withQty: false };
  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------
  const tz = 'Asia/Bangkok';
  const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const shortFmt = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { day: 'numeric', month: 'short' });
  const fullFmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const toDate = (iso) => { const t = new Date(iso); return iso && !isNaN(t) ? t : null; };
  const dayKey = (iso) => { const t = toDate(iso); return t ? dayKeyFmt.format(t) : ''; };
  const shortDate = (iso) => { const t = toDate(iso); return t ? shortFmt.format(t) : '-'; };
  const dayLabel = (ymd) => { const t = toDate(ymd + 'T00:00:00'); return t ? dayFmt.format(t) : ymd; };
  const text = (v) => (v === null || v === undefined ? '' : String(v));

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v);
      }
    }
    (children || []).forEach((c) => { if (c !== null && c !== undefined) node.append(c); });
    return node;
  }

  const safeLink = (url) => (/^https:\/\/(drive|docs)\.google\.com\//.test(text(url)) ? text(url) : '');
  const badName = (n) => text(n).length > 8;
  const badNumber = (n) => !/^\d{1,3}$/.test(text(n));

  let toastTimer = 0;
  /** A short message above the home indicator; errors stay longer, and a tap dismisses any of them. */
  function toast(message, ms) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 6000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    $('toast').hidden = true;
  }

  // ---------- session storage ----------
  // What is kept is a token from the Apps Script (never the password). In a browser tab it lives in
  // sessionStorage and goes with the tab; the app added to an iPhone home screen has no tab to close,
  // so there it stays in localStorage until the token expires (12 h) or "ออกจากระบบ".
  const store = () => (STANDALONE ? localStorage : sessionStorage);
  function readSession() {
    for (const s of [sessionStorage, localStorage]) {
      try {
        const v = JSON.parse(s.getItem(SESSION_KEY) || 'null');
        if (v && typeof v.token === 'string' && v.token && typeof v.username === 'string') return v;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  function writeSession(v) {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
      if (v) store().setItem(SESSION_KEY, JSON.stringify(v));
    } catch (e) { /* private mode: nothing is kept */ }
  }
  function readUi() {
    try { const v = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); return v && typeof v.view === 'string' ? v : null; } catch (e) { return null; }
  }
  function writeUi(v) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }
  function forgetLegacy() {
    try { for (const k of LEGACY_KEYS) { sessionStorage.removeItem(k); localStorage.removeItem(k); } } catch (e) { /* ignore */ }
  }

  // ---------- data ----------
  async function callApi(body, opts) {
    if (!API_URL) throw Object.assign(new Error('หน้านี้ยังไม่ได้เชื่อมกับ Google Sheet'), { setup: true });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      // A plain string body with no custom header is a "simple" request: Apps Script answers through a
      // redirect to script.googleusercontent.com and never has to handle a CORS preflight.
      res = await fetch(API_URL, {
        method: 'POST', body: JSON.stringify(body), signal: ctl.signal,
        credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', keepalive: !!(opts && opts.keepalive),
      });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'Google Sheet ตอบช้าเกินไป ลองใหม่อีกครั้ง' : 'เชื่อมต่อไม่ได้ เช็กอินเทอร์เน็ตแล้วลองใหม่');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error('Google Sheet ตอบกลับผิดพลาด (HTTP ' + res.status + ')');
    let json;
    try { json = await res.json(); } catch (e) { throw new Error('ข้อมูลที่ได้กลับมาอ่านไม่ได้ ลองใหม่อีกครั้ง'); }
    if (!json || typeof json !== 'object') throw new Error('ข้อมูลที่ได้กลับมาอ่านไม่ได้ ลองใหม่อีกครั้ง');
    if (!json.ok) throw Object.assign(new Error(text(json.error) || 'ดึงข้อมูลไม่สำเร็จ'), { auth: true, code: text(json.code) });
    return json;
  }

  const list = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === 'object') : []);
  function normalize(json) {
    return {
      demo: !!json.demo,
      updatedAt: json.updatedAt,
      sheetUrl: json.sheetUrl,
      onlyVerified: json.onlyVerified !== false,
      sizes: Array.isArray(json.sizes) ? json.sizes.map(text) : [],
      colors: Array.isArray(json.colors) ? json.colors.map(text) : [],
      capLabel: text(json.capLabel),
      shipLabel: text(json.shipLabel),
      shirts: list(json.shirts),
      caps: list(json.caps),
      shipping: Array.isArray(json.shipping) ? list(json.shipping) : null,
    };
  }

  function demoData() {
    const names = ['TEST', 'DEMO', 'SAMPLE', 'RCWD', 'GREEN', 'HOUSE', 'TEAM', 'CHEER', 'DRUM', 'FLAG', 'STAND', 'PARADE', 'VERYLONGNAME', 'BLUE'];
    const sizes = ['M', 'L', 'S', 'XL', 'M', '2XL', 'L', 'M', 'S', 'M', '3XL', 'L', 'M', 'XL'];
    const day = (d) => new Date(Date.UTC(2026, 9, d, 4 + (d % 5), 10 + d)).toISOString();
    const shirts = names.map((n, i) => ({
      order: '#' + (i + 1) + '-1', time: day(3 + (i % 5)), color: i % 3 === 0 ? 'ขาว' : 'เขียว', size: sizes[i], name: n,
      number: i === 5 ? '1234' : String((i * 7) % 99).padStart(i % 4 === 0 ? 2 : 1, '0'), piece: 1, slip: '',
    }));
    shirts.push({ order: '', time: '', color: 'เขียว', size: 'M', name: 'STAFF', number: '0', slip: '' });
    const caps = ['ตัวอย่าง หนึ่ง', 'ตัวอย่าง สอง', 'ตัวอย่าง สาม', 'ตัวอย่าง สี่', 'ตัวอย่าง ห้า'].map((n, i) => ({
      order: '#' + (20 + i), time: day(4 + (i % 4)), name: n, grade: 'ม.' + (i + 1), room: String(i + 2), phone: '0800000' + String(100 + i),
      social: '@demo' + (i + 1), product: i % 2 ? 'หมวก RCWD' : 'RCWD Jersey + หมวก RCWD', qty: i === 1 ? 3 : i === 3 ? 2 : 1, slip: '',
    }));
    const shipping = [
      { order: '#2', time: day(3), name: 'ผู้รับ ตัวอย่าง', phone: '0811111111', address: '99/1 ถ.ตัวอย่าง แขวงสามเสนใน เขตพญาไท กรุงเทพฯ 10400',
        items: 'Jersey เขียว · L · DEMO · 7', buyer: 'ตัวอย่าง สอง\nม.5 ห้อง 2', contact: '0800000101\n@demo2', shipped: true, tracking: 'TH0000000001', slip: '' },
      { order: '#21', time: day(5), name: 'ผู้ปกครอง ตัวอย่าง', phone: '0822222222', address: '12 หมู่ 3 ต.ตัวอย่าง อ.ตัวอย่าง นนทบุรี 11120',
        items: 'หมวก RCWD 3 ใบ', buyer: 'ตัวอย่าง สอง\nม.2 ห้อง 3', contact: '0800000101\n@demo2', shipped: false, tracking: '', slip: '' },
      { order: '#9', time: day(6), name: 'ป้า ตัวอย่าง', phone: '0833333333', address: 'คอนโดตัวอย่าง ห้อง 1201\nซอยตัวอย่าง 3',
        items: 'Jersey ขาว · M · FLAG · 63\nJersey เขียว · M · STAND · 70\nหมวก RCWD 1 ใบ', buyer: 'ตัวอย่าง สาม\nม.3 ห้อง 4', contact: '0800000102\n@demo3', shipped: false, tracking: '', slip: '' },
    ];
    return Promise.resolve({ ok: true, demo: true, updatedAt: new Date().toISOString(), sheetUrl: '', onlyVerified: true,
      sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL'], colors: ['เขียว', 'ขาว'], capLabel: 'หมวก RCWD', shipLabel: 'จัดส่ง', shirts, caps, shipping });
  }

  // ---------- views ----------
  function show(view) {
    $('loading').hidden = view !== 'loading';
    $('login').hidden = view !== 'login';
    $('app').hidden = view !== 'app';
  }

  // หมวด: เสื้อแยกตามสี (Jersey เขียว, Jersey ขาว, ...) + หมวก + จัดส่ง (ถ้าสคริปต์ส่งมา)
  const SWATCH = { 'เขียว': 'green', 'ขาว': 'white' };
  function viewList(d) {
    const colors = d.colors.length ? d.colors : [null];
    const views = colors.map((c) => ({
      key: 'shirt:' + (c || ''), kind: 'shirt', color: c,
      label: c ? 'Jersey ' + c : 'เสื้อ', swatch: SWATCH[c] || '',
    }));
    views.push({ key: 'caps', kind: 'cap', label: d.capLabel || 'หมวก' });
    if (d.shipping) views.push({ key: 'ship', kind: 'ship', label: d.shipLabel || 'จัดส่ง' });
    return views;
  }
  function currentView() {
    const views = viewList(state.data);
    return views.find((v) => v.key === state.view) || views[0];
  }
  function rowsOf(view, onlyInRange) {
    const base = view.kind === 'cap' ? state.data.caps
      : view.kind === 'ship' ? (state.data.shipping || [])
      : state.data.shirts.filter((r) => view.color === null || text(r.color) === view.color);
    return onlyInRange ? base.filter(inRange) : base;
  }
  // หมวกนับเป็นใบ (ออเดอร์หนึ่งสั่งได้หลายใบ) ที่เหลือนับแถว
  const qtyOf = (r) => Math.max(1, Number(r.qty) || 1);
  const countOf = (view, rows) => (view.kind === 'cap' ? rows.reduce((t, r) => t + qtyOf(r), 0) : rows.length);
  const UNIT = { shirt: 'ตัว', cap: 'ใบ', ship: 'ออเดอร์' };

  function inRange(row) {
    if (!state.from && !state.to) return true;
    const d = dayKey(row.time);
    if (!d) return false;
    return (!state.from || d >= state.from) && (!state.to || d <= state.to);
  }

  function matches(row) {
    if (!state.q) return true;
    const q = state.q.toLowerCase();
    if (/^#\d+$/.test(q)) {
      const o = text(row.order);
      return o === q || o.indexOf(q + '-') === 0;
    }
    const kind = currentView().kind;
    const hay = kind === 'shirt' ? [row.name, row.number, row.size, row.order]
      : kind === 'ship' ? [row.name, row.phone, row.address, row.items, row.buyer, row.contact, row.tracking, row.order]
      : [row.name, row.phone, row.social, row.grade, row.room, row.product, row.order];
    return hay.some((v) => text(v).toLowerCase().includes(q));
  }

  function columnsFor(kind) {
    const order = state.withOrder ? ['ออเดอร์'] : [];
    if (kind === 'ship') return ['ลำดับ', 'ผู้รับ', 'ที่อยู่', 'รายการ', 'ผู้สั่ง'].concat(order, ['สถานะ', 'วันที่สั่ง', 'สลิป']);
    const main = kind === 'shirt'
      ? ['ลำดับ', 'Size', 'ชื่อหลังเสื้อ', 'เลขหลังเสื้อ']
      : ['ลำดับ', 'ชื่อ', 'ชั้น', 'ห้อง', 'เบอร์ติดต่อ', 'IG / Line', 'สินค้าที่สั่ง'].concat(state.withQty ? ['จำนวน'] : []);
    return main.concat(order, ['วันที่สั่ง', 'สลิป']);
  }

  // แถวที่ไม่มีเลขออเดอร์ = พิมพ์เพิ่มเองในชีต
  function orderCell(row) {
    if (!state.withOrder) return null;
    return row.order
      ? el('td', { class: 'order', text: text(row.order) })
      : el('td', { class: 'order' }, [el('span', { class: 'manual', text: 'เพิ่มเอง', title: 'แถวที่พิมพ์เพิ่มเองในชีต' })]);
  }

  function slipCell(row) {
    const url = safeLink(row.slip);
    return el('td', { class: 'slip' }, [
      url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: 'ดูสลิป', title: 'เปิดใน Google Drive (ต้องใช้บัญชีเจ้าของฟอร์ม)' })
          : el('span', { class: 'muted', text: 'ไม่มีสลิป' }),
    ]);
  }

  function shirtRow(row, i) {
    const nameBad = badName(row.name);
    const numberBad = badNumber(row.number);
    return el('tr', null, [
      el('td', { class: 'idx', text: String(i + 1) }),
      el('td', { class: 'size' }, [el('span', { text: text(row.size) || '-' })]),
      el('td', { class: 'back-name' + (nameBad ? ' flag' : '') }, [
        text(row.name) || '-',
        nameBad ? el('span', { class: 'hint', text: 'เกิน 8 ตัวอักษร' }) : null,
      ]),
      el('td', { class: 'back-number' + (numberBad ? ' flag' : '') }, [
        el('span', { class: 'num', text: text(row.number) || '-' }),
        numberBad ? el('span', { class: 'hint', text: 'ต้องเป็นตัวเลข 1-3 หลัก' }) : null,
      ]),
      orderCell(row),
      el('td', { class: 'when', text: shortDate(row.time) }),
      slipCell(row),
    ]);
  }

  // เบอร์โทรกดโทรได้บนมือถือ
  function telLink(phone, plain) {
    const digits = text(phone).replace(/[^\d+]/g, '');
    if (!text(phone)) return null;
    if (digits.length < 9) return el('span', { class: plain ? '' : 'sub', text: text(phone) });
    return el('a', { href: 'tel:' + digits, class: plain ? '' : 'tel', text: text(phone) });
  }

  function capRow(row, i) {
    return el('tr', null, [
      el('td', { class: 'idx', text: String(i + 1) }),
      el('td', { class: 'name', text: text(row.name) }),
      el('td', { class: 'grade', text: text(row.grade) }),
      el('td', { class: 'room', text: text(row.room) }),
      el('td', { class: 'phone' }, [telLink(row.phone, true)]),
      el('td', { class: 'social', text: text(row.social) }),
      el('td', { class: 'product', text: text(row.product) }),
      state.withQty ? el('td', { class: 'qty' }, [el('span', { class: 'num', text: String(qtyOf(row)) })]) : null,
      orderCell(row),
      el('td', { class: 'when', text: shortDate(row.time) }),
      slipCell(row),
    ]);
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (e) {
      // older iOS / no secure context: select-and-copy
      const ta = el('textarea', { readonly: 'readonly', 'aria-hidden': 'true' });
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  async function copyLabel(row, btn) {
    const value = [row.name, row.phone, row.address].map(text).filter(Boolean).join('\n');
    const ok = await copyText(value);
    btn.textContent = ok ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้';
    toast(ok ? 'คัดลอกชื่อ เบอร์ และที่อยู่แล้ว' : 'คัดลอกไม่ได้ ลองกดค้างที่ที่อยู่แล้วคัดลอกเอง');
    setTimeout(() => { btn.textContent = 'คัดลอกชื่อ+ที่อยู่'; }, 1500);
  }

  function shipRow(row, i) {
    const copy = el('button', { type: 'button', class: 'copy', text: 'คัดลอกชื่อ+ที่อยู่', title: 'คัดลอกชื่อ เบอร์ และที่อยู่ ไปวางในใบจ่าหน้า' });
    copy.addEventListener('click', () => copyLabel(row, copy));
    const order = orderCell(row);
    if (order) order.setAttribute('data-label', 'ออเดอร์');
    const slip = slipCell(row);
    slip.setAttribute('data-label', 'สลิป');
    return el('tr', null, [
      el('td', { class: 'idx', text: String(i + 1) }),
      el('td', { class: 'who' }, [el('strong', { text: text(row.name) || '-' }), telLink(row.phone)]),
      el('td', { class: 'addr', 'data-label': 'ที่อยู่' }, [text(row.address) || '-', el('br'), copy]),
      el('td', { class: 'items', 'data-label': 'รายการ', text: text(row.items) || '-' }),
      el('td', { class: 'buyer', 'data-label': 'ผู้สั่ง' }, [text(row.buyer) || '-', row.contact ? el('span', { class: 'sub', text: text(row.contact) }) : null]),
      order,
      el('td', { class: 'status-cell', 'data-label': 'สถานะ' }, [
        el('span', { class: 'badge ' + (row.shipped ? 'done' : 'wait'), text: row.shipped ? 'ส่งแล้ว' : 'รอส่ง' }),
        row.tracking ? el('span', { class: 'track', text: text(row.tracking) }) : null,
      ]),
      el('td', { class: 'when', 'data-label': 'วันที่สั่ง', text: shortDate(row.time) }),
      slip,
    ]);
  }

  function runItem(label, value, extraClass) {
    return el('div', { class: (value === 0 ? 'zero ' : '') + (extraClass || '') }, [
      el('dt', { text: label }),
      el('dd', { class: 'num', text: String(value) }),
    ]);
  }

  function summary(rows, view) {
    if (view.kind === 'shirt') {
      const sizes = state.data.sizes.slice();
      rows.forEach((r) => { const s = text(r.size); if (s && sizes.indexOf(s) === -1) sizes.push(s); });
      const items = sizes.map((s) => [s, rows.filter((r) => text(r.size) === s).length]);
      return { items, total: ['รวม (ตัว)', rows.length] };
    }
    if (view.kind === 'ship') {
      const done = rows.filter((r) => r.shipped).length;
      return { items: [['รอส่ง', rows.length - done], ['ส่งแล้ว', done]], total: ['รวม (ออเดอร์)', rows.length] };
    }
    const withShirt = rows.filter((r) => /jersey|เสื้อ/i.test(text(r.product))).reduce((t, r) => t + qtyOf(r), 0);
    const total = countOf(view, rows);
    return {
      items: [['สั่งคู่กับเสื้อ', withShirt], ['หมวกอย่างเดียว', total - withShirt]],
      total: ['รวม (ใบ)', total],
    };
  }

  function rangeText() {
    if (state.from && state.to) return dayLabel(state.from) + ' – ' + dayLabel(state.to);
    if (state.from) return 'ตั้งแต่ ' + dayLabel(state.from);
    if (state.to) return 'ถึง ' + dayLabel(state.to);
    return 'ทุกวันที่';
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const views = viewList(d);
    const view = currentView();
    state.view = view.key;
    // สคริปต์เวอร์ชันใหม่ส่งเลขออเดอร์ / จำนวนหมวกมาด้วย (เวอร์ชันเก่าไม่มี ก็ซ่อนคอลัมน์นั้น)
    const has = (rows, key) => rows.some((r) => Object.prototype.hasOwnProperty.call(r, key));
    state.withOrder = has(d.shirts.concat(d.caps, d.shipping || []), 'order');
    state.withQty = has(d.caps, 'qty');
    const rows = rowsOf(view, true);
    const shown = rows.filter(matches);

    $('switch').replaceChildren(...views.map((v) => el('button', { type: 'button', 'data-view': v.key, 'aria-pressed': String(v.key === view.key) }, [
      el('span', { class: 'label' }, [v.swatch ? el('span', { class: 'swatch ' + v.swatch, 'aria-hidden': 'true' }) : null, v.label]),
      el('span', { class: 'num', text: String(countOf(v, rowsOf(v, true))) }),
    ])));
    $('q').placeholder = (view.kind === 'shirt' ? 'ชื่อหลังเสื้อ หรือเลข'
      : view.kind === 'ship' ? 'ชื่อ เบอร์ ที่อยู่ หรือเลขพัสดุ'
      : 'ชื่อ เบอร์ IG หรือห้อง') + (state.withOrder ? ' หรือ #ออเดอร์' : '');
    $('q-clear').hidden = !state.q;
    $('status').textContent = state.q
      ? (shown.length ? 'พบ ' + shown.length + ' ' + UNIT[view.kind] : 'ไม่พบ "' + state.q + '"')
      : '';
    $('clear-dates').hidden = !state.from && !state.to;
    const hasRange = !!(state.from || state.to);
    const rangeLabel = $('range-label');
    rangeLabel.textContent = rangeText();
    rangeLabel.classList.toggle('active', hasRange);

    // The file holds what is on screen: the date range, and the search when one is typed.
    const exportBtn = $('export');
    exportBtn.textContent = 'ดาวน์โหลด Excel (' + countOf(view, shown) + ' ' + UNIT[view.kind] + (state.q ? ' ที่ค้นพบ' : '') + ')';
    exportBtn.disabled = shown.length === 0;

    const s = summary(rows, view);
    $('run').replaceChildren(...s.items.map(([k, v]) => runItem(k, v)), runItem(s.total[0], s.total[1], 'total'));

    $('thead').closest('table').className = view.kind;
    $('thead').replaceChildren(el('tr', null, columnsFor(view.kind).map((label) => el('th', { scope: 'col', text: label }))));
    const make = view.kind === 'shirt' ? shirtRow : view.kind === 'ship' ? shipRow : capRow;
    $('tbody').replaceChildren(...shown.map(make));

    const empty = shown.length === 0;
    $('empty').hidden = !empty;
    if (empty) {
      $('empty-text').textContent = state.q
        ? 'ไม่พบ "' + state.q + '" ในรายการนี้'
        : hasRange ? 'ไม่มีออเดอร์ในช่วงวันที่นี้'
        : view.kind === 'ship' ? 'ยังไม่มีออเดอร์ที่ต้องจัดส่ง' : 'ยังไม่มีออเดอร์ที่สลิปผ่าน';
      $('empty-reset').hidden = !hasRange || !!state.q;
    }

    $('subtitle').textContent = d.demo ? 'ตัวอย่างข้อมูลสมมติ' : (d.onlyVerified ? 'รายการที่สลิปผ่านแล้ว' : 'ทุกรายการ');
    const updated = toDate(d.updatedAt);
    $('updated').textContent = updated ? 'อัปเดตล่าสุด ' + timeFmt.format(updated) : '';
    const link = safeLink(d.sheetUrl);
    $('sheet-link').hidden = !link;
    if (link) $('sheet-link').href = link;
    const note = $('mode-note');
    const oldScript = !!(state.auth && state.auth.mode === 'password');
    note.hidden = !oldScript;
    note.textContent = oldScript ? 'สคริปต์รุ่นเก่า: ปิดหน้านี้แล้วต้องเข้าสู่ระบบใหม่' : '';
  }

  // ---------- Excel (xlsx-lite.js, no download from a CDN) ----------
  function saveFile(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function exportExcel() {
    const btn = $('export');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'กำลังสร้างไฟล์…';
    try {
      if (!window.XlsxLite) throw new Error('โหลดตัวสร้างไฟล์ Excel ไม่ได้ รีเฟรชหน้าแล้วลองใหม่');
      const view = currentView();
      const rows = rowsOf(view, true).filter(matches);
      const when = (r) => { const t = toDate(r.time); return t ? fullFmt.format(t).replace(',', '') : ''; };
      let header, body, widths;
      const sheetName = view.label.slice(0, 31);
      const withOrder = state.withOrder;
      const order = (r) => (withOrder ? [text(r.order) || 'เพิ่มเอง'] : []);
      const orderHead = withOrder ? ['ออเดอร์'] : [];
      const orderWidth = withOrder ? [10] : [];
      // ช่องที่มีหลายบรรทัด (รายการ ผู้สั่ง) ต่อกันด้วย " / " จะได้อ่านง่ายใน Excel
      const oneLine = (v) => text(v).split('\n').map((x) => x.trim()).filter(Boolean).join(' / ');
      const qtyHead = state.withQty ? ['จำนวน (ใบ)'] : [];
      if (view.kind === 'shirt') {
        header = ['ลำดับ', 'Size', 'ชื่อหลังเสื้อ', 'เลขหลังเสื้อ'].concat(orderHead, ['วันที่สั่ง', 'ลิงก์สลิป']);
        body = rows.map((r, i) => [i + 1, text(r.size), text(r.name), text(r.number)].concat(order(r), [when(r), safeLink(r.slip)]));
        widths = [7, 8, 18, 12].concat(orderWidth, [18, 45]);
      } else if (view.kind === 'ship') {
        header = ['ลำดับ', 'ชื่อผู้รับ', 'เบอร์โทร', 'ที่อยู่', 'รายการ', 'ผู้สั่ง', 'ติดต่อผู้สั่ง'].concat(orderHead, ['สถานะ', 'เลขพัสดุ', 'วันที่สั่ง', 'ลิงก์สลิป']);
        body = rows.map((r, i) => [i + 1, text(r.name), text(r.phone), oneLine(r.address), oneLine(r.items), oneLine(r.buyer), oneLine(r.contact)]
          .concat(order(r), [r.shipped ? 'ส่งแล้ว' : 'รอส่ง', text(r.tracking), when(r), safeLink(r.slip)]));
        widths = [7, 22, 14, 50, 45, 26, 22].concat(orderWidth, [9, 18, 18, 45]);
      } else {
        header = ['ลำดับ', 'ชื่อ', 'ชั้น', 'ห้อง', 'เบอร์ติดต่อ', 'IG / Line', 'สินค้าที่สั่ง'].concat(qtyHead, orderHead, ['วันที่สั่ง', 'ลิงก์สลิป']);
        body = rows.map((r, i) => [i + 1, text(r.name), text(r.grade), text(r.room), text(r.phone), text(r.social), text(r.product)]
          .concat(state.withQty ? [qtyOf(r)] : [], order(r), [when(r), safeLink(r.slip)]));
        widths = [7, 26, 10, 6, 14, 20, 26].concat(state.withQty ? [10] : [], orderWidth, [18, 45]);
      }
      const s = summary(rows, view);
      const sumHead = [view.kind === 'shirt' ? 'Size' : view.kind === 'ship' ? 'สถานะ' : 'รายการ', 'จำนวน'];
      const blob = window.XlsxLite.build({
        sheets: [
          { name: sheetName, rows: [header].concat(body), widths },
          { name: 'สรุป', rows: [sumHead].concat(s.items, [s.total]), widths: [16, 10] },
        ],
      });
      const range = state.from || state.to ? (state.from || 'เริ่ม') + '_ถึง_' + (state.to || 'ล่าสุด') : 'ทั้งหมด';
      const found = state.q ? '-ค้นหา' : '';
      saveFile(blob, 'RCWD-' + sheetName + '-' + range + found + '.xlsx');
    } catch (e) {
      toast(e.message || 'สร้างไฟล์ไม่สำเร็จ');
    } finally {
      btn.textContent = label;
      btn.disabled = false;
      render();
    }
  }

  // ---------- auth ----------
  function adopt(json, auth) {
    state.data = normalize(json);
    state.loadedAt = Date.now();
    if (DEMO) {
      state.auth = { mode: 'demo' };
    } else if (typeof json.token === 'string' && json.token) {
      // สคริปต์รุ่นใหม่: เก็บโทเค็นแทนรหัสผ่าน
      state.auth = { mode: 'token', username: auth.username, token: json.token, expiresAt: text(json.expiresAt) };
      writeSession({ username: auth.username, token: json.token, expiresAt: state.auth.expiresAt });
    } else if (auth.mode === 'token') {
      state.auth = auth; // refresh answered without a token: keep the one we have
    } else {
      // สคริปต์รุ่นเก่า: รหัสผ่านอยู่แค่ในหน่วยความจำของหน้านี้ ไม่ถูกเก็บลงเครื่อง
      state.auth = { mode: 'password', username: auth.username, password: auth.password };
      writeSession(null);
    }
    show('app');
    render();
  }

  async function signIn(username, password) {
    const json = DEMO ? await demoData() : await callApi({ action: 'login', username, password });
    adopt(json, { mode: 'password', username, password });
  }

  async function refreshData() {
    const a = state.auth;
    if (!a) throw Object.assign(new Error('เซสชันหมดอายุ เข้าสู่ระบบอีกครั้ง'), { auth: true, code: 'session' });
    const json = a.mode === 'demo' ? await demoData()
      : a.mode === 'token' ? await callApi({ action: 'refresh', token: a.token })
      : await callApi({ username: a.username, password: a.password });
    adopt(json, a);
  }

  function clearScreen() {
    state.data = null;
    $('tbody').replaceChildren();
    $('thead').replaceChildren();
    $('run').replaceChildren();
    $('switch').replaceChildren();
    $('status').textContent = '';
    $('updated').textContent = '';
  }

  function showLogin(message, opts) {
    const o = opts || {};
    if (o.forget !== false) { writeSession(null); state.auth = null; }
    clearScreen();
    $('login-error').textContent = message || '';
    $('setup-note').hidden = !o.setup && !!API_URL;
    show('login');
  }

  async function logout() {
    const a = state.auth;
    showLogin('');
    if (a && a.mode === 'token' && API_URL) {
      try { await callApi({ action: 'logout', token: a.token }, { keepalive: true }); } catch (e) { /* the token expires on its own */ }
    }
  }

  async function doRefresh(opts) {
    const o = opts || {};
    if (state.busy) return;
    state.busy = true;
    const buttons = [$('refresh'), $('refresh-top')];
    const labels = buttons.map((b) => b.textContent);
    buttons.forEach((b) => { b.disabled = true; });
    if (!o.silent) $('refresh').textContent = 'กำลังดึงข้อมูล…';
    try {
      await refreshData();
      if (!o.silent) toast('อัปเดตข้อมูลแล้ว', 1800);
    } catch (err) {
      if (err.auth && (err.code === 'session' || state.auth.mode !== 'token')) showLogin(err.message);
      else toast(err.message);
    } finally {
      state.busy = false;
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
    }
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    const f = e.target;
    const user = $('username');
    const pass = $('password');
    const btn = $('login-btn');
    const username = user.value.trim();
    const password = pass.value;
    if (!DEMO && (!username || !password)) {
      $('login-error').textContent = 'กรอกชื่อผู้ใช้และรหัสผ่านก่อนนะ';
      (username ? pass : user).focus();
      return;
    }
    state.busy = true;
    btn.disabled = true;
    btn.textContent = 'กำลังเข้าสู่ระบบ…';
    $('login-error').textContent = '';
    try {
      await signIn(username, password);
      f.reset();
      $('app-title').focus({ preventScroll: true });
    } catch (err) {
      $('login-error').textContent = err.message;
      $('setup-note').hidden = !err.setup && !!API_URL;
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = 'เข้าสู่ระบบ';
    }
  });

  $('pw-toggle').addEventListener('click', () => {
    const pass = $('password');
    const btn = $('pw-toggle');
    const showing = pass.type === 'text';
    pass.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'แสดงรหัสผ่าน' : 'ซ่อนรหัสผ่าน');
    pass.focus();
  });

  $('logout').addEventListener('click', logout);
  $('refresh').addEventListener('click', () => doRefresh());
  $('refresh-top').addEventListener('click', () => doRefresh());

  // กลับมาที่แท็บ/แอปหลังจากห่างไปสักพัก: ดึงข้อมูลใหม่ให้เงียบ ๆ
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.data || !state.auth || state.busy) return;
    if (Date.now() - state.loadedAt < STALE_MS) return;
    doRefresh({ silent: true });
  });

  // ---------- controls ----------
  $('switch').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    writeUi({ view: state.view });
    render();
  });
  $('toast').addEventListener('click', hideToast);
  $('from').addEventListener('change', (e) => { state.from = e.target.value; render(); });
  $('to').addEventListener('change', (e) => { state.to = e.target.value; render(); });
  $('q').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });
  $('searchbar').addEventListener('submit', (e) => { e.preventDefault(); $('q').blur(); });
  $('q-clear').addEventListener('click', () => { state.q = ''; $('q').value = ''; render(); $('q').focus(); });
  const clearDates = () => { state.from = state.to = ''; $('from').value = $('to').value = ''; render(); };
  $('clear-dates').addEventListener('click', clearDates);
  $('empty-reset').addEventListener('click', clearDates);
  $('export').addEventListener('click', exportExcel);

  // ช่วงวันที่: พับไว้บนมือถือ กางเสมอบนจอกว้าง
  const wide = window.matchMedia('(min-width: 860px)');
  const syncMore = () => { if (wide.matches) $('more').open = true; };
  syncMore();
  if (wide.addEventListener) wide.addEventListener('change', syncMore);

  // ---------- start ----------
  (async () => {
    forgetLegacy();
    const ui = readUi();
    if (ui) state.view = ui.view;
    if (DEMO) {
      try { await signIn('', ''); } catch (err) { showLogin(err.message); }
      return;
    }
    const saved = readSession();
    if (!saved) return showLogin('', { setup: !API_URL });
    if (saved.expiresAt && Date.parse(saved.expiresAt) < Date.now()) return showLogin('เซสชันหมดอายุ เข้าสู่ระบบอีกครั้ง');
    state.auth = { mode: 'token', username: saved.username, token: saved.token, expiresAt: text(saved.expiresAt) };
    try {
      await refreshData();
    } catch (err) {
      // a network hiccup keeps the session for the next try; a dead session is forgotten
      showLogin(err.message, { setup: !!err.setup, forget: !!(err.auth || err.setup) });
    }
  })();
})();
