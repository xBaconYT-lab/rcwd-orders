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
  const CACHE_KEY = 'rcwd-cache';      // the last data pulled, next to the session: the page opens instantly and refreshes behind
  const CHECKLIST = document.body.dataset.page === 'checklist'; // checklist.html: the same app, a different screen
  const UI_KEY = CHECKLIST ? 'rcwd-ui-checklist' : 'rcwd-ui'; // the last category opened (no personal data), so the app reopens where it was
  const PRICING_KEY = 'rcwd-pricing';  // prices and costs used by the profit view (no personal data)
  const EXPORT_KEY = 'rcwd-export';    // which columns to leave out of the Excel file, per category (no personal data)
  // ราคาและต้นทุนตาม "บันทึกข้อความ การจัดทำและจัดจำหน่ายของที่ระลึก คณะราชาวดี 2569" (เอกสารแนบ ข้อ 1-2)
  const PRICING_DEFAULTS = {
    shirtPrice: 299, capPrice: 279, pairPrice: 590, shirtCapPrice: 570, fullSetPrice: 849,
    shirtCost: 240, shirt3xlCost: 260, capCost: 220,
    shipCostPerOrder: 0, otherCost: 0,
  };
  const LEGACY_KEYS = ['rcwd-auth']; // older versions kept the password here
  const FETCH_TIMEOUT_MS = 25000;
  const STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;

  const state = { data: null, auth: null, view: '', from: '', to: '', q: '', loadedAt: 0, busy: false, withOrder: false, withQty: false, pricing: null, editing: null, exportPrefs: {}, hideGiven: false, withGiven: false };
  const $ = (id) => document.getElementById(id);
  const on = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); }; // checklist.html has fewer controls

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
  const bahtFmt = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 0 });
  const baht = (n) => bahtFmt.format(Math.round(Number(n) || 0));
  const pct = (n) => (Number.isFinite(n) ? (Math.round(n * 10) / 10).toLocaleString('th-TH', { maximumFractionDigits: 1 }) + '%' : '-');

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
  // The last data pulled stays on the device (sessionStorage in a tab, localStorage in the home-screen app) so a
  // reload, a page switch or a reopen shows the list at once while the sheet is asked again behind it (see autoSync).
  // Dropped on "ออกจากระบบ", on a dead session, and after 12 hours.
  function readCache() {
    try {
      const v = JSON.parse(store().getItem(CACHE_KEY) || 'null');
      if (!v || typeof v !== 'object' || !v.data || typeof v.savedAt !== 'number') return null;
      if (Date.now() - v.savedAt > 12 * 3600 * 1000) return null;
      v.data.cachedAt = v.savedAt;
      return v.data;
    } catch (e) { return null; }
  }
  function writeCache(json) {
    try {
      sessionStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(CACHE_KEY);
      if (json) store().setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data: json }));
    } catch (e) { /* storage full or private mode: the next load just waits for the sheet */ }
  }
  function readUi() {
    try {
      const v = JSON.parse(localStorage.getItem(UI_KEY) || 'null');
      if (!v || typeof v.view !== 'string') return null;
      return { view: v.view, hideGiven: v.hideGiven === true };
    } catch (e) { return null; }
  }
  function writeUi(v) {
    try { localStorage.setItem(UI_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }
  function readPricing() {
    const out = Object.assign({}, PRICING_DEFAULTS);
    try {
      const v = JSON.parse(localStorage.getItem(PRICING_KEY) || 'null');
      if (v && typeof v === 'object') {
        for (const k of Object.keys(PRICING_DEFAULTS)) {
          const n = Number(v[k]);
          if (Number.isFinite(n) && n >= 0) out[k] = n;
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }
  function writePricing(v) {
    try { localStorage.setItem(PRICING_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }
  // { shirt: { off: ['ลิงก์สลิป'], summary: false }, cap: {...}, ship: {...} }
  function readExportPrefs() {
    try {
      const v = JSON.parse(localStorage.getItem(EXPORT_KEY) || 'null');
      if (!v || typeof v !== 'object') return {};
      const out = {};
      for (const kind of ['shirt', 'cap', 'ship', 'checklist']) {
        const p = v[kind];
        if (p && typeof p === 'object') out[kind] = { off: Array.isArray(p.off) ? p.off.map(text).slice(0, 40) : [], summary: p.summary !== false };
      }
      return out;
    } catch (e) { return {}; }
  }
  function writeExportPrefs(v) {
    try { localStorage.setItem(EXPORT_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }
  const exportPref = (kind) => state.exportPrefs[kind] || { off: [], summary: true };
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
    // ออเดอร์ #9 มีเสื้อ 2 สี + หมวก (ครบเซ็ต), #2 มีเสื้อ + หมวก, #21 หมวก 3 ใบ: ตรงกับรายการจัดส่งตัวอย่างด้านล่าง
    const orders = ['#1-1', '#2-1', '#3-1', '#4-1', '#5-1', '#6-1', '#7-1', '#8-1', '#12-1', '#9-1', '#9-2', '#13-1', '#14-1', '#15-1'];
    // ผู้สั่งกับชั้น/ห้อง (จากแท็บตรวจสลิป) มาหลายแบบ: "ม.1" + "2", "1/5" ในช่องชั้น, เลขไทย, ไม่กรอก
    const buyers = [['นักเรียน ก', 'ม.1', '2'], ['นักเรียน ข', '5/2', ''], ['นักเรียน ค', 'ม.1', '5'], ['นักเรียน ง', 'ม.6', '7'],
      ['นักเรียน จ', '2', '5'], ['นักเรียน ฉ', 'ม.๑', '๒'], ['นักเรียน ช', '', ''], ['นักเรียน ซ', 'ม.5', '2'],
      ['นักเรียน ฌ', 'ม.2', '5'], ['นักเรียน ญ', 'ม.1', '5'], ['นักเรียน ญ', 'ม.1', '5'], ['นักเรียน ฎ', 'ม.6', '7'],
      ['นักเรียน ฏ', 'ม.1', '2'], ['นักเรียน ฐ', 'ม.2', '5']];
    const shirts = names.map((n, i) => ({
      order: orders[i], time: day(3 + (i % 5)), color: i % 3 === 0 ? 'ขาว' : 'เขียว', size: sizes[i], name: n,
      buyer: buyers[i][0], grade: buyers[i][1], room: buyers[i][2],
      number: i === 5 ? '1234' : String((i * 7) % 99).padStart(i % 4 === 0 ? 2 : 1, '0'), piece: 1, slip: '', given: i % 4 === 1,
    }));
    shirts.push({ order: '', time: '', color: 'เขียว', size: 'M', name: 'STAFF', number: '0', slip: '' });
    const capOrders = [
      { order: '#2', product: 'RCWD Jersey + หมวก RCWD', qty: 1 },
      { order: '#21', product: 'หมวก RCWD', qty: 3 },
      { order: '#9', product: 'RCWD Jersey + หมวก RCWD', qty: 1 },
      { order: '#23', product: 'หมวก RCWD', qty: 2 },
      { order: '#24', product: 'RCWD Jersey + หมวก RCWD', qty: 1 },
    ];
    // ชั้น/ห้อง หลายแบบที่คนกรอกจริง: "ม.5" + "2", "1/2" ในช่องชั้น, เลขไทย — เรียงแล้วต้องได้ 1/2, 1/5, 2/5, 5/2, 6/7
    const capGrades = [['5/2', ''], ['1/2', ''], ['ม.๑', '5'], ['ม.2', '5'], ['1', '5']];
    const caps = ['นักเรียน ข', 'ตัวอย่าง สอง', 'นักเรียน ญ', 'ตัวอย่าง สี่', 'ตัวอย่าง ห้า'].map((n, i) => ({
      order: capOrders[i].order, time: day(4 + (i % 4)), name: n, grade: capGrades[i][0], room: capGrades[i][1], phone: '0800000' + String(100 + i),
      social: '@demo' + (i + 1), product: capOrders[i].product, qty: capOrders[i].qty, slip: '', given: i === 1 || i === 3,
    }));
    const shipping = [
      { order: '#2', time: day(3), name: 'ผู้รับ ตัวอย่าง', phone: '0811111111', address: '99/1 ถ.ตัวอย่าง แขวงสามเสนใน เขตพญาไท กรุงเทพฯ 10400',
        items: 'Jersey เขียว · L · DEMO · 7\nหมวก RCWD 1 ใบ', buyer: 'ตัวอย่าง สอง\nม.5 ห้อง 2', contact: '0800000101\n@demo2', shipped: true, tracking: 'TH0000000001', slip: '' },
      { order: '#21', time: day(5), name: 'ผู้ปกครอง ตัวอย่าง', phone: '0822222222', address: '12 หมู่ 3 ต.ตัวอย่าง อ.ตัวอย่าง นนทบุรี 11120',
        items: 'หมวก RCWD 3 ใบ', buyer: 'ตัวอย่าง สอง\nม.2 ห้อง 3', contact: '0800000101\n@demo2', shipped: false, tracking: '', slip: '' },
      { order: '#9', time: day(6), name: 'ป้า ตัวอย่าง', phone: '0833333333', address: 'คอนโดตัวอย่าง ห้อง 1201\nซอยตัวอย่าง 3',
        items: 'Jersey ขาว · M · FLAG · 63\nJersey เขียว · 3XL · STAND · 70\nหมวก RCWD 1 ใบ', buyer: 'ตัวอย่าง สาม\nม.3 ห้อง 4', contact: '0800000102\n@demo3', shipped: false, tracking: '', slip: '' },
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
    views.push({ key: 'profit', kind: 'profit', label: 'กำไร' });
    return views;
  }
  function currentView() {
    const views = viewList(state.data);
    return views.find((v) => v.key === state.view) || views[0];
  }
  function rowsOf(view, onlyInRange) {
    const base = view.kind === 'cap' ? state.data.caps
      : view.kind === 'ship' ? (state.data.shipping || [])
      : view.kind === 'profit' ? state.data.shirts.concat(state.data.caps)
      : state.data.shirts.filter((r) => view.color === null || text(r.color) === view.color);
    if (!onlyInRange) return base;
    const inside = base.filter(inRange);
    return view.kind === 'profit' ? inside : byOrderNo(inside);
  }
  // หน้าออเดอร์เรียงตามเลขออเดอร์ (#1-1, #2-1, #2-2, #3 …) แถวที่พิมพ์เพิ่มเอง (ไม่มีเลข) ไปท้ายสุดตามลำดับในชีต
  const orderParts = (row) => { const m = /^#(\d+)(?:-(\d+))?/.exec(text(row.order)); return m ? [Number(m[1]), Number(m[2] || 0)] : null; };
  function byOrderNo(rows) {
    return rows.map((r, i) => ({ r, i })).sort((a, b) => {
      const ka = orderParts(a.r), kb = orderParts(b.r);
      if (ka && kb) return ka[0] - kb[0] || ka[1] - kb[1] || a.i - b.i;
      if (ka) return -1;
      if (kb) return 1;
      return a.i - b.i;
    }).map((x) => x.r);
  }
  // ไฟล์ Excel ของเสื้อเรียงตามไซซ์ (S, M, L, XL, 2XL, 3XL …) ในไซซ์เดียวกันเรียงตามเลขออเดอร์
  function bySize(rows) {
    const order = state.data.sizes.map((x) => text(x).trim().toUpperCase());
    const rank = (r) => { const i = order.indexOf(text(r.size).trim().toUpperCase()); return i === -1 ? 999 : i; };
    return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
  }

  // ---------- เรียงลำดับ ----------
  // ชั้น/ห้อง: อ่านตัวเลขจากช่องชั้น ("ม.4", "ม.๔", "4", หรือ "4/2" ที่กรอกรวมมา) และช่องห้อง แล้วเรียงเป็นตัวเลข
  // จึงได้ 1/2, 1/5, 2/5, 5/2, 6/7 (ไม่ใช่เรียงตามตัวอักษร) ชั้นที่อ่านไม่ออกไปท้ายสุด
  const arabic = (v) => text(v).replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)));
  const numbersIn = (v) => (arabic(v).match(/\d+/g) || []).map(Number);
  function classKey(row) {
    const g = numbersIn(row.grade);
    const r = numbersIn(row.room);
    return [g.length ? g[0] : Infinity, r.length ? r[0] : (g.length > 1 ? g[1] : Infinity)];
  }
  const classLabel = (row) => {
    const k = classKey(row);
    return isFinite(k[0]) ? 'ม.' + k[0] + (isFinite(k[1]) ? '/' + k[1] : '') : '';
  };
  // หมวกนับเป็นใบ (ออเดอร์หนึ่งสั่งได้หลายใบ) ที่เหลือนับแถว; หมวดกำไรโชว์ยอดกำไร (บาท)
  const qtyOf = (r) => Math.max(1, Number(r.qty) || 1);
  const countOf = (view, rows) => (view.kind === 'cap' ? rows.reduce((t, r) => t + qtyOf(r), 0)
    : view.kind === 'profit' ? computeProfit().profit
    : rows.length);
  const UNIT = { shirt: 'ตัว', cap: 'ใบ', ship: 'ออเดอร์', profit: 'บาท' };

  // ---------- กำไร ----------
  // Groups the rows in the chosen date range by order number (#8-1 and #8 belong to order 8) and prices
  // each order at the cheapest bundle its items form (ครบเซ็ต > เสื้อ 2 สี > เสื้อ + หมวก > ชิ้นเดี่ยว), then
  // subtracts the unit costs and the extra costs. A row with a numeric `amount` from the sheet (a newer
  // script could send what was actually paid) wins over the bundle estimate for its order.
  const orderNo = (row) => { const m = /^#(\d+)/.exec(text(row.order)); return m ? m[1] : null; };
  const is3xl = (row) => /^3\s*xl$/i.test(text(row.size).trim());
  function computeProfit() {
    const P = state.pricing || PRICING_DEFAULTS;
    const shirts = state.data.shirts.filter(inRange);
    const caps = state.data.caps.filter(inRange);
    const shipping = (state.data.shipping || []).filter(inRange);
    const groups = new Map();
    let manual = 0;
    const groupFor = (row) => {
      const key = orderNo(row) || ('manual:' + (manual++));
      if (!groups.has(key)) groups.set(key, { green: 0, white: 0, shirts: 0, caps: 0, amount: null });
      return groups.get(key);
    };
    const cost = { green: 0, white: 0, greenQty: 0, whiteQty: 0, shirt3xl: 0, capQty: 0 };
    for (const r of shirts) {
      const g = groupFor(r);
      const colour = text(r.color);
      if (colour === 'ขาว') { g.white++; cost.whiteQty++; } else { g.green++; cost.greenQty++; }
      g.shirts++;
      const unit = is3xl(r) ? P.shirt3xlCost : P.shirtCost;
      if (is3xl(r)) cost.shirt3xl++;
      if (colour === 'ขาว') cost.white += unit; else cost.green += unit;
      if (Number.isFinite(Number(r.amount)) && r.amount !== '' && r.amount !== null) g.amount = (g.amount || 0) + Number(r.amount);
    }
    for (const r of caps) {
      const g = groupFor(r);
      g.caps += qtyOf(r);
      cost.capQty += qtyOf(r);
      if (Number.isFinite(Number(r.amount)) && r.amount !== '' && r.amount !== null) g.amount = (g.amount || 0) + Number(r.amount);
    }
    const bundles = { fullSet: 0, pair: 0, shirtCap: 0, shirt: 0, cap: 0 };
    let revenue = 0;
    let fromSheet = 0;
    for (const g of groups.values()) {
      if (g.amount !== null) { revenue += g.amount; fromSheet++; continue; }
      let { green, white, caps: c } = g;
      while (green > 0 && white > 0 && c > 0) { bundles.fullSet++; revenue += P.fullSetPrice; green--; white--; c--; }
      while (green > 0 && white > 0) { bundles.pair++; revenue += P.pairPrice; green--; white--; }
      let loose = green + white;
      while (loose > 0 && c > 0) { bundles.shirtCap++; revenue += P.shirtCapPrice; loose--; c--; }
      bundles.shirt += loose; revenue += loose * P.shirtPrice;
      bundles.cap += c; revenue += c * P.capPrice;
    }
    const capCost = cost.capQty * P.capCost;
    const shipCost = shipping.length * P.shipCostPerOrder;
    const totalCost = cost.green + cost.white + capCost + shipCost + P.otherCost;
    const profit = revenue - totalCost;
    return {
      orders: groups.size, revenue, bundles, cost, capCost, shipCost, shipOrders: shipping.length, otherCost: P.otherCost,
      totalCost, profit, margin: revenue > 0 ? (profit / revenue) * 100 : NaN, fromSheet,
      shirtQty: cost.greenQty + cost.whiteQty, capQty: cost.capQty, withOrder: state.withOrder,
    };
  }

  // On phones the row folds to two lines: the label, then "qty × unit" in small print (prefix = "×",
  // or a word such as อัตรากำไร for the grand row), with the total on the right.
  function ledgerRow(label, qty, unit, total, cls, prefix) {
    const zero = total === 0 && !(cls || '').includes('total');
    return el('tr', { class: ((cls || '') + (zero ? ' zero' : '')).trim() || null }, [
      el('td', { class: 'label', text: label }),
      el('td', { class: 'qty-col', text: qty }),
      el('td', { class: 'amount unit', 'data-prefix': unit ? (prefix || '×') : null, text: unit }),
      el('td', { class: 'amount total-col' + (total < 0 ? ' neg' : ''), text: baht(total) }),
    ]);
  }
  function sectionRow(label) {
    return el('tr', { class: 'section' }, [el('th', { scope: 'colgroup', colspan: '4', text: label })]);
  }

  function renderProfit(view) {
    const P = state.pricing;
    const r = computeProfit();
    $('run').replaceChildren(
      runItem('รายได้', baht(r.revenue)),
      runItem('ต้นทุน', baht(r.totalCost)),
      (() => { const item = runItem('กำไร', baht(r.profit), 'total'); if (r.profit < 0) item.querySelector('dd').classList.add('neg'); return item; })(),
      runItem('อัตรากำไร', pct(r.margin)),
    );
    $('thead').replaceChildren(el('tr', null, [
      el('th', { scope: 'col', text: 'รายการ' }),
      el('th', { scope: 'col', text: 'จำนวน' }),
      el('th', { scope: 'col', class: 'amount', text: 'ต่อหน่วย' }),
      el('th', { scope: 'col', class: 'amount', text: 'รวม (บาท)' }),
    ]));
    const b = r.bundles;
    const shirtUnit = P.shirt3xlCost !== P.shirtCost ? baht(P.shirtCost) + ' (3XL ' + baht(P.shirt3xlCost) + ')' : baht(P.shirtCost);
    const rows = [
      sectionRow('รายได้ (จากรายการที่สลิปผ่านแล้ว ' + r.orders + ' ออเดอร์)'),
      ledgerRow('ครบเซ็ต เสื้อ 2 สี + หมวก', b.fullSet + ' ชุด', baht(P.fullSetPrice), b.fullSet * P.fullSetPrice),
      ledgerRow('เสื้อ 2 สี', b.pair + ' ชุด', baht(P.pairPrice), b.pair * P.pairPrice),
      ledgerRow('เสื้อ + หมวก', b.shirtCap + ' ชุด', baht(P.shirtCapPrice), b.shirtCap * P.shirtCapPrice),
      ledgerRow('เสื้อเดี่ยว', b.shirt + ' ตัว', baht(P.shirtPrice), b.shirt * P.shirtPrice),
      ledgerRow('หมวกเดี่ยว', b.cap + ' ใบ', baht(P.capPrice), b.cap * P.capPrice),
      r.fromSheet ? ledgerRow('ยอดที่ชีตระบุเอง', r.fromSheet + ' ออเดอร์', '', r.revenue - (b.fullSet * P.fullSetPrice + b.pair * P.pairPrice + b.shirtCap * P.shirtCapPrice + b.shirt * P.shirtPrice + b.cap * P.capPrice)) : null,
      ledgerRow('รวมรายได้', '', '', r.revenue, 'total'),
      sectionRow('ต้นทุน'),
      ledgerRow('Jersey เขียว', r.cost.greenQty + ' ตัว', shirtUnit, r.cost.green),
      ledgerRow('Jersey ขาว', r.cost.whiteQty + ' ตัว', shirtUnit, r.cost.white),
      ledgerRow('หมวก RCWD', r.capQty + ' ใบ', baht(P.capCost), r.capCost),
      ledgerRow('ค่าส่งพัสดุ', r.shipOrders + ' ออเดอร์', baht(P.shipCostPerOrder), r.shipCost),
      ledgerRow('ค่าใช้จ่ายอื่น ๆ', '', '', r.otherCost),
      ledgerRow('รวมต้นทุน', '', '', r.totalCost, 'total'),
      ledgerRow('กำไร', r.orders + ' ออเดอร์', pct(r.margin), r.profit, 'total grand', 'อัตรากำไร'),
    ].filter(Boolean);
    $('tbody').replaceChildren(...rows);
    $('empty').hidden = true;
    const note = $('profit-note') || el('p', { id: 'profit-note', class: 'profit-note' });
    note.textContent = (r.withOrder
      ? 'คิดราคาจากของในออเดอร์เดียวกัน (เลขออเดอร์เดียวกัน) ตามชุดที่ถูกที่สุด '
      : 'สคริปต์รุ่นนี้ไม่ส่งเลขออเดอร์ จึงคิดราคาแยกชิ้นทุกรายการ ')
      + 'ต้นทุนเสื้อ ' + baht(P.shirtCost) + ' (3XL ' + baht(P.shirt3xlCost) + ') หมวก ' + baht(P.capCost) + ' บาท ตัวเลขอัปเดตทุกครั้งที่ดึงข้อมูล';
    $('thead').closest('.panel').append(note);
    $('pricing').hidden = false;
    $('pricing-state').textContent = Object.keys(PRICING_DEFAULTS).every((k) => P[k] === PRICING_DEFAULTS[k]) ? 'ตามบันทึกข้อความ ต.ค. 2569' : 'แก้ไขเอง';
  }

  function syncPricingForm() {
    const P = state.pricing;
    for (const input of document.querySelectorAll('#pricing-form [data-price]')) input.value = String(P[input.dataset.price]);
  }

  // ---------- เช็กลิสต์แจกของ (checklist.html) ----------
  // หนึ่งรายการ = หนึ่งออเดอร์ (คนสั่งหนึ่งคน) รวมทุกชิ้นที่ซื้อ: เสื้อแต่ละตัว (สี ไซซ์ ชื่อ เลข) และหมวก (จำนวนใบ)
  // จัดกลุ่มตามชั้น/ห้องของคนสั่ง เรียงเป็นตัวเลข (ม.1/2, ม.1/5, ม.2/5, ม.5/2, ม.6/7) ในกลุ่มเรียงตามชื่อ
  // ติ๊ก "แจกแล้ว" ครั้งเดียวต่อออเดอร์: บันทึกคอลัมน์ "แจกแล้ว" ของทุกแถวในออเดอร์นั้น (เสื้อทุกตัว + หมวก)
  function checklistOrders() {
    const d = state.data;
    const byNo = new Map();
    let manual = 0;
    const entryFor = (row) => {
      const no = orderNo(row);
      const key = no ? no : 'manual:' + (manual++);
      if (!byNo.has(key)) byNo.set(key, { no, key: no ? '#' + no : '', who: '', grade: '', room: '', items: [], rows: [], i: byNo.size, ship: false });
      return byNo.get(key);
    };
    d.shirts.forEach((r) => {
      const e = entryFor(r);
      if (!e.who && text(r.buyer)) e.who = text(r.buyer);
      if (!e.grade && text(r.grade)) { e.grade = text(r.grade); e.room = text(r.room); }
      e.items.push({ kind: 'shirt', label: ['Jersey ' + (text(r.color) || ''), text(r.size), text(r.name), text(r.number)].filter(Boolean).join(' · '), row: r });
      e.rows.push({ kind: 'shirt', row: r });
    });
    d.caps.forEach((r) => {
      const e = entryFor(r);
      if (!e.who && text(r.name)) e.who = text(r.name);
      if (!e.grade && text(r.grade)) { e.grade = text(r.grade); e.room = text(r.room); }
      e.items.push({ kind: 'cap', label: (text(r.product).match(/หมวก[^+·]*/) || ['หมวก'])[0].trim() + (qtyOf(r) > 1 ? ' × ' + qtyOf(r) + ' ใบ' : ' 1 ใบ'), row: r });
      e.rows.push({ kind: 'cap', row: r });
    });
    (d.shipping || []).forEach((r) => { const no = orderNo(r); if (no && byNo.has(no)) byNo.get(no).ship = true; });
    const list = Array.from(byNo.values());
    list.forEach((e) => {
      const fake = { grade: e.grade, room: e.room };
      e.ck = classKey(fake);
      e.cls = classLabel(fake);
      e.given = e.rows.filter((x) => x.row.given).length;
      e.state = e.given === 0 ? 'none' : e.given === e.rows.length ? 'all' : 'some';
    });
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    list.sort((a, b) => cmp(a.ck[0], b.ck[0]) || cmp(a.ck[1], b.ck[1]) || cmp(a.who.toLowerCase(), b.who.toLowerCase()) || a.i - b.i);
    return list;
  }
  function clMatches(e) {
    if (!state.q) return true;
    const q = state.q.toLowerCase();
    if (/^#\d+$/.test(q)) return e.key === q;
    return [e.who, e.cls, e.key, e.grade, e.room].concat(e.items.map((it) => it.label)).some((v) => text(v).toLowerCase().includes(q));
  }
  function orderGivenCell(e) {
    if (!canEdit() || !e.key) return el('td', { class: 'given' });
    const label = pendingGiven.has(e.key) ? 'กำลังบันทึก…' : e.state === 'all' ? 'แจกแล้ว' : e.state === 'some' ? 'แจกบางส่วน' : 'ยังไม่แจก';
    const box = el('label', { class: 'given-box' + (e.state === 'all' ? ' on' : e.state === 'some' ? ' some' : '') + (pendingGiven.has(e.key) ? ' pending' : '') }, [
      el('input', { type: 'checkbox', 'data-given-order': e.key, checked: e.state === 'all' ? '' : null, 'aria-label': 'แจกแล้ว ' + e.key }),
      el('span', { text: label }),
    ]);
    if (e.state === 'some') box.querySelector('input').indeterminate = true;
    return el('td', { class: 'given' }, [box]);
  }
  // ติ๊กแล้วเห็นผลทันที: จดไว้ในคิว แล้วส่งให้ชีตรวมกันเป็นคำขอเดียวเบื้องหลัง (หลายออเดอร์ = ส่งครั้งเดียว)
  // ระหว่างรอแถวขึ้น "กำลังบันทึก…" ถ้าชีตตอบไม่ผ่านจะดีดกลับค่าเดิมและบอก ข้อมูลที่ดึงใหม่ระหว่างรอไม่ทับค่าที่ติ๊กไว้
  const pendingGiven = new Map(); // order key -> { value, before: [{row, given}] }
  let flushTimer = 0;
  let flushing = false;
  function rowsOfOrder(key) {
    const no = key.slice(1);
    return state.data.shirts.concat(state.data.caps).filter((r) => orderNo(r) === no);
  }
  function applyPending() {
    pendingGiven.forEach((p, key) => rowsOfOrder(key).forEach((r) => { r.given = p.value; }));
  }
  function saveGivenOrder(cb) {
    const key = cb.dataset.givenOrder;
    const value = cb.checked;
    const rows = rowsOfOrder(key);
    if (!rows.length) return;
    const prev = pendingGiven.get(key);
    pendingGiven.set(key, { value, before: prev ? prev.before : rows.map((r) => ({ row: r, given: !!r.given })) });
    rows.forEach((r) => { r.given = value; });
    render();
    if (state.auth.mode === 'demo') {
      setTimeout(() => { pendingGiven.delete(key); render(); }, 400);
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushGiven, 350);
  }
  async function flushGiven() {
    if (flushing || !pendingGiven.size || !state.auth) return;
    flushing = true;
    const batch = Array.from(pendingGiven.entries()).map(([order, p]) => ({ order, given: p.value }));
    try {
      const json = await callApi(authBody({ action: 'update', kind: 'orders', changes: batch }));
      if (!json.updated) throw new Error('สคริปต์ของชีตยังไม่รองรับการติ๊กหลายออเดอร์: อัปเดต updateFromWeb_ ใน Code.gs ตาม README');
      batch.forEach((c) => { const p = pendingGiven.get(c.order); if (p && p.value === c.given) pendingGiven.delete(c.order); });
      writeCache(stripForCache(Object.assign({}, state.data)));
      render();
      toast('บันทึกลงชีตแล้ว ' + batch.length + ' ออเดอร์', 1200);
    } catch (err) {
      // ดีดกลับค่าก่อนติ๊ก แล้วบอก (ค่าที่ชีตรับไปแล้วส่วนหนึ่งจะกลับมาเองตอนดึงข้อมูลครั้งถัดไป)
      batch.forEach((c) => {
        const p = pendingGiven.get(c.order);
        if (p && p.value === c.given) { p.before.forEach((b) => { b.row.given = b.given; }); pendingGiven.delete(c.order); }
      });
      render();
      if (err.auth && err.code === 'session') showLogin(err.message);
      else toast('บันทึกไม่สำเร็จ: ' + (err.message || '') + ' (ติ๊กถูกดีดกลับ ลองใหม่)', 7000);
    } finally {
      flushing = false;
      if (pendingGiven.size) { clearTimeout(flushTimer); flushTimer = setTimeout(flushGiven, 200); }
    }
  }
  // ปิดหน้าทั้งที่ยังมีติ๊กค้าง: ส่งทันทีแบบ keepalive
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingGiven.size && !flushing && state.auth && state.auth.mode !== 'demo') {
      const batch = Array.from(pendingGiven.entries()).map(([order, p]) => ({ order, given: p.value }));
      try { callApi(authBody({ action: 'update', kind: 'orders', changes: batch }), { keepalive: true }).catch(() => {}); } catch (e) { /* ignore */ }
    }
  });
  function renderChecklist() {
    const d = state.data;
    const has = (rows, key) => rows.some((r) => Object.prototype.hasOwnProperty.call(r, key));
    state.withOrder = has(d.shirts.concat(d.caps), 'order');
    state.withQty = has(d.caps, 'qty');
    state.withGiven = has(d.shirts.concat(d.caps), 'given');
    const all = checklistOrders();
    const done = all.filter((e) => e.state === 'all').length;
    const some = all.filter((e) => e.state === 'some').length;
    $('switch').hidden = true;
    renderReadonlyBar();
    $('q').placeholder = 'ชื่อ ชั้น/ห้อง เสื้อ หมวก หรือ #ออเดอร์';
    $('q-clear').hidden = !state.q;
    const hideBox = $('hide-given');
    if (hideBox) hideBox.checked = state.hideGiven;
    const shown = all.filter(clMatches).filter((e) => !(state.hideGiven && e.state === 'all'));
    $('status').textContent = state.q ? (shown.length ? 'พบ ' + shown.length + ' ออเดอร์' : 'ไม่พบ "' + state.q + '"') : '';
    $('run').replaceChildren(
      runItem('แจกแล้ว', done),
      runItem('ยังไม่แจก', all.length - done - some),
      ...(some ? [runItem('แจกบางส่วน', some)] : []),
      runItem('รวม (ออเดอร์)', all.length, 'total'),
    );
    const exportBtn = $('export');
    if (exportBtn) {
      exportBtn.textContent = 'ดาวน์โหลด Excel (' + shown.length + ' ออเดอร์' + (state.q ? ' ที่ค้นพบ' : state.hideGiven ? ' ที่ยังไม่แจก' : '') + ')';
      exportBtn.disabled = shown.length === 0;
    }
    if ($('columns')) renderColumnPicker({ kind: 'checklist' });
    $('thead').closest('table').className = 'checklist cards';
    $('thead').replaceChildren(el('tr', null, [
      el('th', { scope: 'col', text: 'คนสั่ง' }),
      el('th', { scope: 'col', text: 'ของที่ต้องให้' }),
      el('th', { scope: 'col', text: 'ออเดอร์' }),
      el('th', { scope: 'col', text: 'แจกแล้ว' }),
    ]));
    const rows = [];
    let lastCls = null;
    shown.forEach((e) => {
      const cls = e.cls || 'ไม่ระบุชั้น';
      if (cls !== lastCls) {
        const inGroup = shown.filter((x) => (x.cls || 'ไม่ระบุชั้น') === cls);
        const left = inGroup.filter((x) => x.state !== 'all').length;
        rows.push(el('tr', { class: 'section' }, [el('th', { scope: 'colgroup', colspan: '4' }, [
          cls, el('span', { class: 'group-count', text: left ? 'ยังไม่แจก ' + left + ' ออเดอร์' : 'แจกครบแล้ว' }),
        ])]));
        lastCls = cls;
      }
      rows.push(el('tr', { class: e.state === 'all' ? 'done' : null }, [
        el('td', { class: 'who' }, [
          e.who || el('span', { class: 'muted', text: '-' }),
          e.ship ? el('span', { class: 'ship-tag', text: 'จัดส่ง' }) : null,
        ]),
        el('td', { class: 'item' }, [el('ul', { class: 'items' }, e.items.map((it) => el('li', { class: it.kind + (it.row.given ? ' got' : '') }, [
          el('span', { class: 'dot ' + (it.kind === 'shirt' ? (SWATCH[text(it.row.color)] || 'other') : 'cap'), 'aria-hidden': 'true' }),
          it.label,
        ])))]),
        e.key ? el('td', { class: 'order', text: e.key }) : el('td', { class: 'order' }, [el('span', { class: 'manual', text: 'เพิ่มเอง' })]),
        orderGivenCell(e),
      ]));
    });
    $('tbody').replaceChildren(...rows);
    const empty = shown.length === 0;
    $('empty').hidden = !empty;
    if (empty) $('empty-text').textContent = state.q ? 'ไม่พบ "' + state.q + '"' : state.hideGiven && all.length ? 'แจกครบทุกออเดอร์แล้ว' : 'ยังไม่มีรายการ';
    $('subtitle').textContent = d.demo ? 'ตัวอย่างข้อมูลสมมติ' : (d.onlyVerified ? 'รายการที่สลิปผ่านแล้ว' : 'ทุกรายการ');
    const updated = toDate(d.updatedAt);
    $('updated').textContent = updated ? 'อัปเดตล่าสุด ' + timeFmt.format(updated) : '';
    const link = safeLink(d.sheetUrl);
    $('sheet-link').hidden = !link;
    if (link) $('sheet-link').href = link;
    const note = $('mode-note');
    const oldScript = !!(state.auth && state.auth.mode === 'password');
    note.hidden = !oldScript && !!state.auth;
    note.textContent = !state.auth ? 'ข้อมูลที่เคยดึงไว้ · เข้าสู่ระบบเพื่อดึงใหม่หรือแก้ไข' : oldScript ? 'สคริปต์รุ่นเก่า: ปิดหน้านี้แล้วต้องเข้าสู่ระบบใหม่' : '';
    $('logout').textContent = state.auth ? 'ออกจากระบบ' : 'เข้าสู่ระบบ';
  }

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
    return main.concat(order, ['วันที่สั่ง', 'สลิป'], kind === 'shirt' && canEdit() ? [''] : []);
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

  // แก้ชื่อ/เลขหลังเสื้อได้เมื่อแถวมีเลขออเดอร์ (สคริปต์ต้องมี Update.gs ด้วย จึงจะบันทึกลงชีตได้)
  const canEdit = () => state.withOrder; // ไม่ได้เข้าสู่ระบบ: ปุ่ม/ช่องติ๊กยังอยู่ กดแล้วพาไปเข้าสู่ระบบก่อน
  const needLogin = (why) => { showLogin(why, { forget: false }); return true; };
  // แถบบอกสถานะดูอย่างเดียว (เปิดจากข้อมูลที่เคยดึงไว้ ยังไม่ได้เข้าสู่ระบบ)
  function renderReadonlyBar() {
    let bar = $('readonly-bar');
    if (state.auth) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = el('div', { id: 'readonly-bar', class: 'readonly-bar', role: 'status' }, [
        el('span', { text: 'ข้อมูลที่เคยดึงไว้ ดูได้อย่างเดียว' }),
        el('button', { type: 'button', class: 'btn primary small', id: 'readonly-login', text: 'เข้าสู่ระบบเพื่อติ๊ก/แก้ไข/ดึงใหม่' }),
      ]);
      bar.querySelector('button').addEventListener('click', () => needLogin(''));
      document.querySelector('.panel').before(bar);
    }
  }
  const editKey = (row) => text(row.order);
  function shirtRow(row, i) {
    const nameBad = badName(row.name);
    const numberBad = badNumber(row.number);
    const editing = canEdit() && !!editKey(row) && state.editing === editKey(row);
    const editCell = !canEdit() ? null : el('td', { class: 'edit' }, editing ? [
      el('button', { class: 'btn primary small', type: 'submit', form: 'edit-form', id: 'edit-save', text: 'บันทึก' }),
      el('button', { class: 'btn small', type: 'button', id: 'edit-cancel', text: 'ยกเลิก' }),
    ] : [
      editKey(row)
        ? el('button', { class: 'btn small', type: 'button', 'data-edit': editKey(row), 'aria-label': 'แก้ไขชื่อและเลขหลังเสื้อ ' + editKey(row), text: 'แก้ไข' })
        : null,
    ]);
    return el('tr', { class: editing ? 'editing' : null }, [
      el('td', { class: 'idx', text: String(i + 1) }),
      el('td', { class: 'size' }, [el('span', { text: text(row.size) || '-' })]),
      editing
        ? el('td', { class: 'back-name' }, [el('label', { class: 'edit-field' }, [
            el('span', { text: 'ชื่อหลังเสื้อ' }),
            el('input', { type: 'text', id: 'edit-name', form: 'edit-form', value: text(row.name), maxlength: '20', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: '' }),
          ])])
        : el('td', { class: 'back-name' + (nameBad ? ' flag' : '') }, [
            text(row.name) || '-',
            nameBad ? el('span', { class: 'hint', text: 'เกิน 8 ตัวอักษร' }) : null,
          ]),
      editing
        ? el('td', { class: 'back-number' }, [el('label', { class: 'edit-field' }, [
            el('span', { text: 'เลขหลังเสื้อ' }),
            el('input', { type: 'text', id: 'edit-number', form: 'edit-form', value: text(row.number), inputmode: 'numeric', pattern: '[0-9]{1,3}', maxlength: '3', autocomplete: 'off', required: '', title: 'ตัวเลข 1-3 หลัก' }),
          ])])
        : el('td', { class: 'back-number' + (numberBad ? ' flag' : '') }, [
            el('span', { class: 'num', text: text(row.number) || '-' }),
            numberBad ? el('span', { class: 'hint', text: 'ต้องเป็นตัวเลข 1-3 หลัก' }) : null,
          ]),
      orderCell(row),
      el('td', { class: 'when', text: shortDate(row.time) }),
      slipCell(row),
      editCell,
    ]);
  }

  // ---------- แก้ไขลงชีต ----------
  // ส่ง { action: 'update', kind: 'shirt', order, color, name, number } พร้อมโทเค็น (หรือชื่อผู้ใช้/รหัสผ่านกับสคริปต์รุ่นเก่า)
  // สคริปต์ฝั่งชีต (apps-script/Update.gs) แก้เฉพาะสองเซลล์นั้นและจดค่าเดิมไว้ในแท็บ log ไม่ลบอะไร
  function authBody(body) {
    const a = state.auth;
    if (a && a.mode === 'token') return Object.assign({ token: a.token }, body);
    if (a && a.mode === 'password') return Object.assign({ username: a.username, password: a.password }, body);
    return body;
  }
  let editsInFlight = 0;
  function findShirt(key) {
    return state.data ? state.data.shirts.find((r) => editKey(r) === key) : null;
  }
  async function saveEdit() {
    const key = state.editing;
    const row = findShirt(key);
    const nameInput = $('edit-name');
    const numberInput = $('edit-number');
    if (!row || !nameInput || !numberInput) return;
    const name = nameInput.value.replace(/\s+/g, ' ').trim();
    const number = numberInput.value.trim();
    if (!name) { toast('ใส่ชื่อหลังเสื้อ'); nameInput.focus(); return; }
    if (name.length > 20) { toast('ชื่อหลังเสื้อยาวเกิน 20 ตัวอักษร'); nameInput.focus(); return; }
    if (!/^\d{1,3}$/.test(number)) { toast('เลขหลังเสื้อต้องเป็นตัวเลข 1-3 หลัก'); numberInput.focus(); return; }
    if (name === text(row.name) && number === text(row.number)) { state.editing = null; render(); return; }
    // แสดงค่าใหม่ทันที ส่งให้ชีตเบื้องหลัง ถ้าไม่ผ่านดีดกลับค่าเดิม
    const before = { name: row.name, number: row.number };
    row.name = name; row.number = number;
    state.editing = null;
    render();
    if (state.auth.mode === 'demo') { toast('แก้ไขแล้ว (ตัวอย่าง: ไม่ได้บันทึกจริง)', 2500); return; }
    toast('กำลังบันทึก ' + key + '…', 1500);
    editsInFlight++;
    try {
      const json = await callApi(authBody({ action: 'update', kind: 'shirt', order: key, color: text(row.color), name, number }));
      if (!json.updated) throw new Error('สคริปต์ของชีตยังไม่รองรับการแก้ไข: เพิ่ม Update.gs ตามขั้นตอนใน README ก่อน');
      writeCache(stripForCache(Object.assign({}, state.data)));
      toast('บันทึกลงชีตแล้ว ' + key, 1500);
    } catch (err) {
      row.name = before.name; row.number = before.number;
      render();
      if (err.auth && err.code === 'session') showLogin(err.message);
      else toast('บันทึกไม่สำเร็จ: ' + (err.message || '') + ' (ค่าถูกดีดกลับ)', 7000);
    } finally {
      editsInFlight--;
    }
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
    return { items: [['สั่งคู่กับเสื้อ', withShirt], ['หมวกอย่างเดียว', total - withShirt]], total: ['รวม (ใบ)', total] };
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
    if (CHECKLIST) return renderChecklist();
    const views = viewList(d);
    renderReadonlyBar();
    const view = currentView();
    state.view = view.key;
    // สคริปต์เวอร์ชันใหม่ส่งเลขออเดอร์ / จำนวนหมวกมาด้วย (เวอร์ชันเก่าไม่มี ก็ซ่อนคอลัมน์นั้น)
    const has = (rows, key) => rows.some((r) => Object.prototype.hasOwnProperty.call(r, key));
    state.withOrder = has(d.shirts.concat(d.caps, d.shipping || []), 'order');
    state.withQty = has(d.caps, 'qty');
    state.withGiven = has(d.shirts.concat(d.caps), 'given');
    const rows = rowsOf(view, true);
    const shown = view.kind === 'profit' ? rows : rows.filter(matches);

    $('switch').replaceChildren(...views.map((v) => el('button', { type: 'button', 'data-view': v.key, 'aria-pressed': String(v.key === view.key) }, [
      el('span', { class: 'label' }, [v.swatch ? el('span', { class: 'swatch ' + v.swatch, 'aria-hidden': 'true' }) : null, v.label]),
      el('span', { class: 'num', text: v.kind === 'profit' ? baht(countOf(v, rowsOf(v, true))) : String(countOf(v, rowsOf(v, true))) }),
    ])));
    const isProfit = view.kind === 'profit';
    if (state.editing && (view.kind !== 'shirt' || !findShirt(state.editing))) state.editing = null;
    $('searchbar').hidden = isProfit;
    $('q').placeholder = (view.kind === 'shirt' ? 'ชื่อหลังเสื้อ หรือเลข'
      : view.kind === 'ship' ? 'ชื่อ เบอร์ ที่อยู่ หรือเลขพัสดุ'
      : 'ชื่อ เบอร์ IG หรือห้อง') + (state.withOrder ? ' หรือ #ออเดอร์' : '');
    $('q-clear').hidden = !state.q;
    $('status').textContent = state.q && !isProfit
      ? (shown.length ? 'พบ ' + shown.length + ' ' + UNIT[view.kind] : 'ไม่พบ "' + state.q + '"')
      : '';
    const oldNote = $('profit-note');
    if (oldNote && !isProfit) oldNote.remove();
    $('pricing').hidden = !isProfit;
    $('clear-dates').hidden = !state.from && !state.to;
    const hasRange = !!(state.from || state.to);
    const rangeLabel = $('range-label');
    rangeLabel.textContent = rangeText();
    rangeLabel.classList.toggle('active', hasRange);

    // The file holds what is on screen: the date range, and the search when one is typed.
    const exportBtn = $('export');
    exportBtn.textContent = isProfit
      ? 'ดาวน์โหลด Excel (สรุปกำไร)'
      : 'ดาวน์โหลด Excel (' + countOf(view, shown) + ' ' + UNIT[view.kind] + (state.q ? ' ที่ค้นพบ' : '') + ')';
    exportBtn.disabled = shown.length === 0;
    renderColumnPicker(view);

    $('thead').closest('table').className = isProfit ? 'profit' : view.kind + ' cards';
    if (isProfit) {
      renderProfit(view);
    } else {
      const s = summary(rows, view);
      $('run').replaceChildren(...s.items.map(([k, v]) => runItem(k, v)), runItem(s.total[0], s.total[1], 'total'));
      $('thead').replaceChildren(el('tr', null, columnsFor(view.kind).map((label) => el('th', { scope: 'col', text: label }))));
      const make = view.kind === 'shirt' ? shirtRow : view.kind === 'ship' ? shipRow : capRow;
      $('tbody').replaceChildren(...shown.map(make));
    }

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
    note.hidden = !oldScript && !!state.auth;
    note.textContent = !state.auth ? 'ข้อมูลที่เคยดึงไว้ · เข้าสู่ระบบเพื่อดึงใหม่หรือแก้ไข' : oldScript ? 'สคริปต์รุ่นเก่า: ปิดหน้านี้แล้วต้องเข้าสู่ระบบใหม่' : '';
    $('logout').textContent = state.auth ? 'ออกจากระบบ' : 'เข้าสู่ระบบ';
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
      const view = CHECKLIST ? { kind: 'checklist', label: 'เช็กลิสต์' } : currentView();
      const rows = CHECKLIST ? checklistOrders().filter(clMatches).filter((e) => !(state.hideGiven && e.state === 'all')) : rowsOf(view, true).filter(matches);
      let { header, body, widths } = buildExport(view, rows);
      const sheetName = view.label.slice(0, 31);
      // columns the user unticked in "เลือกคอลัมน์"
      const pref = exportPref(view.kind);
      if (view.kind !== 'profit' && pref.off.length) {
        const keep = header.map((h) => !pref.off.includes(h));
        if (!keep.some(Boolean)) throw new Error('เลือกคอลัมน์อย่างน้อย 1 คอลัมน์ก่อนดาวน์โหลด');
        header = header.filter((h, i) => keep[i]);
        widths = widths.filter((w, i) => keep[i]);
        body = body.map((r) => r.filter((c, i) => keep[i]));
      }
      let sheets;
      if (view.kind === 'profit') {
        sheets = profitSheets();
      } else if (view.kind === 'checklist') {
        sheets = [{ name: sheetName, rows: [header].concat(body), widths }];
      } else {
        const s = summary(rows, view);
        const sumHead = [view.kind === 'shirt' ? 'Size' : view.kind === 'ship' ? 'สถานะ' : 'รายการ', 'จำนวน'];
        sheets = [{ name: sheetName, rows: [header].concat(body), widths }];
        if (pref.summary) sheets.push({ name: 'สรุป', rows: [sumHead].concat(s.items, [s.total]), widths: [16, 10] });
      }
      const blob = window.XlsxLite.build({ sheets });
      const range = CHECKLIST ? (state.hideGiven ? 'ยังไม่แจก' : 'ทั้งหมด') : state.from || state.to ? (state.from || 'เริ่ม') + '_ถึง_' + (state.to || 'ล่าสุด') : 'ทั้งหมด';
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

  // หัวคอลัมน์ + แถวข้อมูล + ความกว้าง ของไฟล์ Excel ในหมวดนั้น (ใช้ทั้งตอนดาวน์โหลดและตอนให้เลือกคอลัมน์)
  function buildExport(view, rows) {
    const when = (r) => { const t = toDate(r.time); return t ? fullFmt.format(t).replace(',', '') : ''; };
    let header, body, widths;
    const withOrder = state.withOrder;
    const order = (r) => (withOrder ? [text(r.order) || 'เพิ่มเอง'] : []);
    const orderHead = withOrder ? ['ออเดอร์'] : [];
    const orderWidth = withOrder ? [10] : [];
    // ช่องที่มีหลายบรรทัด (รายการ ผู้สั่ง) ต่อกันด้วย " / " จะได้อ่านง่ายใน Excel
    const oneLine = (v) => text(v).split('\n').map((x) => x.trim()).filter(Boolean).join(' / ');
    const qtyHead = state.withQty ? ['จำนวน (ใบ)'] : [];
    {
      if (view.kind === 'checklist') {
        // หนึ่งแถวต่อคนสั่ง (ออเดอร์) ตามที่เห็นบนหน้าเช็กลิสต์
        header = ['ลำดับ', 'ชั้น/ห้อง', 'ชื่อคนสั่ง', 'ออเดอร์', 'เสื้อ', 'หมวก', 'ของทั้งหมด', 'เบอร์ติดต่อ', 'จัดส่ง', 'แจกแล้ว'];
        body = rows.map((e, i) => {
          const shirts = e.items.filter((it) => it.kind === 'shirt').map((it) => it.label.replace(/^Jersey /, '')).join(' / ');
          const caps = e.items.filter((it) => it.kind === 'cap').reduce((t, it) => t + qtyOf(it.row), 0);
          const phone = (e.rows.map((x) => text(x.row.phone)).filter(Boolean)[0]) || '';
          return [i + 1, e.cls || '', e.who, e.key || 'เพิ่มเอง', shirts, caps ? caps + ' ใบ' : '', e.items.map((it) => it.label).join(' / '), phone,
            e.ship ? 'จัดส่ง' : '', e.state === 'all' ? 'แจกแล้ว' : e.state === 'some' ? 'แจกบางส่วน' : ''];
        });
        widths = [7, 10, 22, 10, 40, 10, 50, 14, 8, 12];
      } else if (view.kind === 'profit') {
        header = []; body = []; widths = [];
      } else if (view.kind === 'shirt') {
        header = ['ลำดับ', 'Size', 'ชื่อหลังเสื้อ', 'เลขหลังเสื้อ'].concat(orderHead, ['วันที่สั่ง', 'ลิงก์สลิป']);
        body = bySize(rows).map((r, i) => [i + 1, text(r.size), text(r.name), text(r.number)].concat(order(r), [when(r), safeLink(r.slip)]));
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
    }
    return { header, body, widths };
  }

  function profitSheets() {
        const P = state.pricing;
        const r = computeProfit();
        const b = r.bundles;
        const ledger = [
          ['รายการ', 'จำนวน', 'ต่อหน่วย (บาท)', 'รวม (บาท)'],
          ['รายได้'],
          ['ครบเซ็ต เสื้อ 2 สี + หมวก', b.fullSet, P.fullSetPrice, b.fullSet * P.fullSetPrice],
          ['เสื้อ 2 สี', b.pair, P.pairPrice, b.pair * P.pairPrice],
          ['เสื้อ + หมวก', b.shirtCap, P.shirtCapPrice, b.shirtCap * P.shirtCapPrice],
          ['เสื้อเดี่ยว', b.shirt, P.shirtPrice, b.shirt * P.shirtPrice],
          ['หมวกเดี่ยว', b.cap, P.capPrice, b.cap * P.capPrice],
          r.fromSheet ? ['ยอดที่ชีตระบุเอง', r.fromSheet + ' ออเดอร์', '', r.revenue - (b.fullSet * P.fullSetPrice + b.pair * P.pairPrice + b.shirtCap * P.shirtCapPrice + b.shirt * P.shirtPrice + b.cap * P.capPrice)] : null,
          ['รวมรายได้', '', '', r.revenue],
          ['ต้นทุน'],
          ['Jersey เขียว', r.cost.greenQty, P.shirtCost, r.cost.green],
          ['Jersey ขาว', r.cost.whiteQty, P.shirtCost, r.cost.white],
          ['เสื้อไซซ์ 3XL (รวมอยู่ด้านบน)', r.cost.shirt3xl, P.shirt3xlCost, ''],
          ['หมวก RCWD', r.capQty, P.capCost, r.capCost],
          ['ค่าส่งพัสดุ', r.shipOrders, P.shipCostPerOrder, r.shipCost],
          ['ค่าใช้จ่ายอื่น ๆ', '', '', r.otherCost],
          ['รวมต้นทุน', '', '', r.totalCost],
          ['กำไร', r.orders + ' ออเดอร์', pct(r.margin), r.profit],
        ].filter(Boolean);
        return [{ name: 'กำไร', rows: ledger, widths: [34, 12, 16, 14] }];
  }

  // เลือกคอลัมน์ที่จะลงในไฟล์ Excel (จำไว้ต่อหมวดในเครื่องนี้)
  function renderColumnPicker(view) {
    const box = $('columns');
    if (view.kind === 'profit') { box.hidden = true; return; }
    box.hidden = false;
    const { header } = buildExport(view, []);
    const pref = exportPref(view.kind);
    const items = header.map((h) => el('label', { class: 'col-opt' }, [
      el('input', { type: 'checkbox', 'data-col': h, checked: pref.off.includes(h) ? null : '' }),
      el('span', { text: h }),
    ]));
    if (view.kind !== 'checklist') {
      items.push(el('label', { class: 'col-opt summary-opt' }, [
        el('input', { type: 'checkbox', 'data-summary': '', checked: pref.summary ? '' : null }),
        el('span', { text: 'แผ่น "สรุป" (ยอดรวม)' }),
      ]));
    }
    $('columns-list').replaceChildren(...items);
    const n = header.length - pref.off.length;
    $('columns-state').textContent = pref.off.length ? n + ' จาก ' + header.length + ' คอลัมน์' : 'ทุกคอลัมน์';
  }

  // ---------- auth ----------
  function adopt(json, auth) {
    state.data = normalize(json);
    state.loadedAt = Date.now();
    if (CHECKLIST) applyPending();
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
    if (!DEMO) writeCache(stripForCache(json));
    show('app');
    if (!state.editing) render(); // a background pull must not wipe what is being typed; closing the editor renders
  }

  // what is cached: the data only, never the token or anything about the sign-in
  function stripForCache(json) {
    const out = {};
    for (const k of ['updatedAt', 'sheetUrl', 'onlyVerified', 'sizes', 'colors', 'capLabel', 'shipLabel', 'shirts', 'caps', 'shipping']) {
      if (json[k] !== undefined) out[k] = json[k];
    }
    return out;
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
    if (o.dropCache) writeCache(null);
    clearScreen();
    $('login-error').textContent = message || '';
    $('setup-note').hidden = !o.setup && !!API_URL;
    show('login');
  }

  async function logout() {
    const a = state.auth;
    writeCache(null);
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
      else if (!o.silent) toast(err.message);
    } finally {
      state.busy = false;
      buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
    }
  }

  on('login-form', 'submit', async (e) => {
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

  on('pw-toggle', 'click', () => {
    const pass = $('password');
    const btn = $('pw-toggle');
    const showing = pass.type === 'text';
    pass.type = showing ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!showing));
    btn.setAttribute('aria-label', showing ? 'แสดงรหัสผ่าน' : 'ซ่อนรหัสผ่าน');
    pass.focus();
  });

  on('logout', 'click', () => (state.auth ? logout() : showLogin('', { forget: false })));
  on('refresh', 'click', () => (state.auth ? doRefresh() : showLogin('เข้าสู่ระบบเพื่อดึงข้อมูลใหม่', { forget: false })));
  on('refresh-top', 'click', () => (state.auth ? doRefresh() : showLogin('เข้าสู่ระบบเพื่อดึงข้อมูลใหม่', { forget: false })));

  // ดึงข้อมูลเองเบื้องหลัง: ทุก 30 วินาทีขณะเปิดหน้าอยู่ และทันทีที่กลับมาที่หน้านี้ ติ๊ก/แก้ไขจากเครื่องอื่นจึงขึ้นเองโดยไม่ต้องกด
  // ข้ามรอบถ้ากำลังแก้ชื่อ/เลข หรือยังมีค่าที่รอบันทึก เพื่อไม่ให้ข้อมูลเก่าจากชีตทับสิ่งที่เพิ่งทำ
  const SYNC_MS = 30000;
  function autoSync() {
    if (!state.auth || state.auth.mode === 'demo' || !state.data || document.visibilityState !== 'visible') return;
    if (state.busy || state.editing || editsInFlight || flushing || pendingGiven.size) return;
    if (Date.now() - state.loadedAt < 10000) return;
    doRefresh({ silent: true });
  }
  setInterval(autoSync, SYNC_MS);
  document.addEventListener('visibilitychange', autoSync);
  window.addEventListener('focus', autoSync);

  // ---------- controls ----------
  on('switch', 'click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    writeUi({ view: state.view, hideGiven: state.hideGiven });
    render();
  });
  on('toast', 'click', hideToast);
  on('from', 'change', (e) => { state.from = e.target.value; render(); });
  on('to', 'change', (e) => { state.to = e.target.value; render(); });
  on('q', 'input', (e) => { state.q = e.target.value.trim(); render(); });
  on('searchbar', 'submit', (e) => { e.preventDefault(); $('q').blur(); });
  on('q-clear', 'click', () => { state.q = ''; $('q').value = ''; render(); $('q').focus(); });
  const clearDates = () => { state.from = state.to = ''; $('from').value = $('to').value = ''; render(); };
  on('clear-dates', 'click', clearDates);
  on('empty-reset', 'click', clearDates);
  on('export', 'click', exportExcel);

  // แก้ไขชื่อ/เลขหลังเสื้อ
  on('tbody', 'click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (btn) {
      if (!state.auth) return needLogin('เข้าสู่ระบบก่อนแก้ไข');
      if (state.busy) return;
      state.editing = btn.dataset.edit;
      render();
      const input = $('edit-name');
      if (input) { input.focus(); input.select(); }
      return;
    }
    if (e.target.closest('#edit-cancel')) { state.editing = null; render(); }
  });
  on('edit-form', 'submit', (e) => { e.preventDefault(); saveEdit(); });
  on('hide-given', 'change', (e) => { state.hideGiven = e.target.checked; writeUi({ view: state.view, hideGiven: state.hideGiven }); render(); });
  on('tbody', 'change', (e) => {
    const cb = e.target.closest('[data-given-order]');
    if (!cb) return;
    if (!state.auth) { cb.checked = !cb.checked; needLogin('เข้าสู่ระบบก่อนติ๊กแจกแล้ว'); return; }
    saveGivenOrder(cb);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editing) { state.editing = null; render(); }
  });

  // คอลัมน์ในไฟล์ Excel
  state.exportPrefs = readExportPrefs();
  on('columns-list', 'change', (e) => {
    const view = CHECKLIST ? { kind: 'checklist' } : currentView();
    if (!view || view.kind === 'profit') return;
    const pref = exportPref(view.kind);
    const input = e.target;
    if (input.matches('[data-summary]')) pref.summary = input.checked;
    else if (input.matches('[data-col]')) {
      const col = input.dataset.col;
      pref.off = pref.off.filter((c) => c !== col);
      if (!input.checked) pref.off.push(col);
    }
    state.exportPrefs[view.kind] = pref;
    writeExportPrefs(state.exportPrefs);
    renderColumnPicker(view);
  });

  // ราคาและต้นทุน: แก้แล้วคำนวณใหม่ทันที เก็บไว้ในเครื่องนี้
  state.pricing = readPricing();
  syncPricingForm();
  on('pricing-form', 'input', (e) => {
    const input = e.target.closest('[data-price]');
    if (!input) return;
    const n = Number(input.value);
    if (Number.isFinite(n) && n >= 0) {
      state.pricing[input.dataset.price] = n;
      writePricing(state.pricing);
      render();
    }
  });
  on('pricing-form', 'submit', (e) => e.preventDefault());
  on('pricing-reset', 'click', () => {
    state.pricing = Object.assign({}, PRICING_DEFAULTS);
    writePricing(state.pricing);
    syncPricingForm();
    render();
    toast('ใช้ราคาและต้นทุนตามเอกสารแล้ว', 2500);
  });


  // ช่วงวันที่: พับไว้บนมือถือ กางเสมอบนจอกว้าง
  const wide = window.matchMedia('(min-width: 860px)');
  const syncMore = () => { if (wide.matches && $('more')) $('more').open = true; };
  syncMore();
  if (wide.addEventListener) wide.addEventListener('change', syncMore);

  // ---------- start ----------
  (async () => {
    forgetLegacy();
    const ui = readUi();
    if (ui) { state.view = ui.view; state.hideGiven = ui.hideGiven; }
    if (DEMO) {
      try { await signIn('', ''); } catch (err) { showLogin(err.message); }
      return;
    }
    const saved = readSession();
    const cached = API_URL ? readCache() : null;
    if (saved && saved.expiresAt && Date.parse(saved.expiresAt) < Date.now()) return showLogin('เซสชันหมดอายุ เข้าสู่ระบบอีกครั้ง', { dropCache: true });
    if (saved) state.auth = { mode: 'token', username: saved.username, token: saved.token, expiresAt: text(saved.expiresAt) };
    if (cached) {
      // ข้อมูลชุดล่าสุดที่เคยดึงไว้แสดงทันที แล้วดึงใหม่เบื้องหลัง (ไม่มีโทเค็น = ดูได้อย่างเดียวจนกว่าจะเข้าสู่ระบบ)
      state.data = normalize(cached);
      state.loadedAt = cached.cachedAt || 0;
      show('app');
      render();
      autoSync();
      return;
    }
    if (!saved) return showLogin('', { setup: !API_URL });
    try {
      await refreshData();
    } catch (err) {
      // a network hiccup keeps the session for the next try; a dead session is forgotten
      showLogin(err.message, { setup: !!err.setup, forget: !!(err.auth || err.setup), dropCache: !!(err.auth || err.setup) });
    }
  })();
})();
