# RCWD Jersey 2026 — handoff for working locally with Claude Code

This file is the whole picture of what was built in the cloud sessions, what is still pending on the
Google side, the rules that must never be broken, and how to test. Paste it (or point Claude Code at it)
when you continue on your own computer.

## 0. Non‑negotiable rules

- **Never delete, overwrite or reorder customer data in the Google Sheet.** The page and every script
  here only READ order rows. The only writes are: the two cells ชื่อหลังเสื้อ / เลขหลังเสื้อ of one row
  (web edit), the คอลัมน์ "แจกแล้ว" checkbox (checklist), and separate log tabs that record old values.
  Any new feature must keep that property. Never suggest "clean up" steps that remove rows or columns.
- Keep the project name: **RCWD Jersey 2026** / repo `xBaconYT-lab/rcwd-orders` / site `rcwd.leamm.com`.
- Never commit secrets (web password, SlipOK keys, tokens). The Apps Script project holds them.
- Static GitHub Pages site: no server, no build step, no frameworks, no CDNs. CSP in `index.html` is
  `script-src 'self'; style-src 'self'` etc. → no inline scripts/styles/handlers ever.

## 1. What exists

Repo layout (all live on `main`, deployed by GitHub Pages to rcwd.leamm.com):

| File | Purpose |
|---|---|
| `index.html` | Orders page shell (login form, header, category switch, search, date/export panel, profit pricing panel, table). Meta CSP, viewport-fit=cover, manifest, icons. |
| `checklist.html` | `/checklist`: hand-out checklist. Same `app.js`; `<body data-page="checklist">`. |
| `app.js` | The whole app (IIFE). Auth (token or old password mode), cache, rendering, editing, ticks, profit calc, Excel export, checklist. |
| `styles.css` | Tokens (light/dark), Dynamic Type (`html { font: -apple-system-body }`), cards < 1024px (two columns 720–1023px for iPad), phone ledger/checklist layouts. |
| `xlsx-lite.js` | Dependency-free .xlsx writer (`XlsxLite.build({sheets}) → Blob`). |
| `fonts/` | Self-hosted Prompt (400–700 Thai+Latin) and Teko. |
| `config.js` | `window.RCWD_API_URL` = Apps Script `/exec` URL. |
| `apps-script/Auth.gs` | Optional token auth kit (salted hashes in Script Properties, 12 h HMAC tokens, lockouts, revocation). Not yet installed by the owner. |
| `apps-script/Update.gs` | Generic kit for the `update` action (name/number, given, batched orders). The owner's Code.gs uses a tailored `updateFromWeb_` instead (see §3). |
| `apps-script/Email.gs` | Order-recap emails via GmailApp (see §4). |
| `apps-script/Code.gs.sample` | How doPost wires Auth + Update. |
| `tests/*.test.cjs` | Node tests with Apps Script stand-ins: `auth` (12), `update` (9), `email` (5). |
| `docs/apple-hig-review.md` | HIG review notes. |
| `.claude/skills/apple-design/` | Design review skill. |

### Features on the orders page (`/`)
- Categories: Jersey เขียว / Jersey ขาว / หมวก RCWD / จัดส่ง / กำไร. Search (name, number, #order, class), date range, Excel export of what is shown with a **column picker** (per category, stored in `localStorage` `rcwd-export`).
- **Edit ชื่อ/เลขหลังเสื้อ** inline per jersey row (needs the `update` action in Apps Script). Optimistic: editor closes at once, reverts with a toast if the sheet refuses.
- **กำไร view**: revenue/cost/profit/margin from verified orders in range. Prices/costs default to the school memo (shirt 299, cap 279, two shirts 590, shirt+cap 570, full set 849; cost 240 / 3XL 260 / cap 220), editable panel saved in `localStorage` `rcwd-pricing`. Rows with the same order number are priced as their cheapest bundle (full set > two colours > shirt+cap > singles). A numeric `amount` field from the script overrides the estimate.
- Phones: cards (jersey shows name over a big number), sticky search, folded filters, 44 pt targets, safe areas, Dynamic Type. iPad: two cards per row.

### Checklist page (`/checklist`)
- One row per customer (order number): every shirt (colour dot, size, name, number), caps × qty, "จัดส่ง" tag. Grouped by the buyer's class/room parsed numerically ("ม.4"+"2", "4/2", Thai digits) → ม.1/2, ม.1/5, ม.2/5, ม.5/2, ม.6/7; names sorted inside a group; unknown class last.
- One **แจกแล้ว** tick per order → marks every row of that order. Instant on screen, queued, sent as ONE request `{ action: 'update', kind: 'orders', changes: [{order:'#9', given:true}, …] }` (debounced 350 ms, keepalive flush on tab hide). "กำลังบันทึก…" while pending; revert + toast on failure. Partial state shows "แจกบางส่วน" (indeterminate box).
- Hide-given toggle, search, counts, Excel export (one row per customer, column picker).

### Data flow / performance decisions
- `callApi(body)` POSTs a JSON string (no custom headers → no CORS preflight) to the Apps Script `/exec`.
- Token mode (needs Auth.gs): `{action:'login'|'refresh'|'logout'|'update', token}`; token in `sessionStorage` (`rcwd-session`), or `localStorage` when running as a home-screen app. Old password mode: `{username, password, …}`, password only in memory.
- **Cross-device sync by polling.** Data is cached on the device (`rcwd-cache`, same storage as the session, 12 h, cleared on logout). Reload/page switch/reopen show the cached list instantly, then `autoSync` pulls behind it; while signed in it also pulls every 30 s while the page is visible and on focus/return, so a tick or edit on one device shows on the others. It skips a round while the name/number editor is open, an edit is saving, or ticks are pending, and a pull that lands with the editor open does not re-render. Without credentials the cached list is read-only: a banner + tapping a tick/edit opens the login (this last part is in PR "signed-out fix", see §6).
- Why things felt slow: Apps Script cold executions (lock + opening the Google Form + reading all tabs), 2–6 s each. Fixes delivered: server-side 45 s response cache, lazy form open, batched ticks, client cache. Hosting elsewhere would not help; Google is the slow part.

### Security model (page)
- Meta CSP, `referrer no-referrer`, `form-action 'none'`, no external resources, no password persisted, cache cleared on logout, https-only slip links with `rel="noopener noreferrer"`.
- Remaining weaknesses are in Google: the web password in Code.gs is a trivially short default (change it to a long one), and without Auth.gs there are no tokens (staff retype the password; the cache then shows read-only until login). Installing `Auth.gs` (README "ตั้งค่า") fixes both.

## 2. Commands

```
node tests/auth.test.cjs
node tests/update.test.cjs
node tests/email.test.cjs      # also writes tests/out/email-sample.html
```
Browser harness (not in the repo; recreate if needed): Playwright + Chromium, iPhone 13 viewport,
`page.route()` mocks of the Apps Script URL returning `{ok, token, shirts, caps, shipping, …}`,
served from a static server (`python3 -m http.server 8787` works). Demo data: open `/?demo` and
`/checklist.html?demo` (no backend needed; expected demo numbers: revenue 6,681 / cost 5,380 / profit 1,301, 17 orders).

## 3. Pending on the owner's Code.gs (Google Apps Script of the response sheet)

The owner's Code.gs is their own slip-checking script (SlipOK + tab sync). It already contains, from
earlier sessions: the `update` hook in `handleWeb_`, a 45 s `web_data` cache with invalidation in
`onOrderSubmit`/`onSlipStatusEdit`/menu functions, `webContext_()` (lazy form), `updateFromWeb_` (name/number only)
and `webLogSheet_`. Still to apply, in this order:

1. In `handleWeb_` change `sizes: shirtSizes_(choiceValues_(ctx.fields.sizeItem), shirts),` → `sizes: shirtSizes_([], shirts),` (otherwise every cold request opens the Google Form).
2. In `slipRowInfo_` add after `no: Number(r[0]) || 0,`:
   ```js
    name: String(r[2] || ''), grade: String(r[3] || ''), room: String(r[4] || ''),
   ```
3. In `readTabRows_` change `const all = tab.spec.headers.concat(tab.spec.userHeaders || []);` → `const all = Object.keys(tab.cols);`
4. In `handleWeb_` inside `shirts.push({…})` add `buyer: m.name || '', grade: m.grade || '', room: m.room || '', given: /^true$/i.test(r['แจกแล้ว'] || ''),` and inside `caps.push({…})` add `given: /^true$/i.test(r['แจกแล้ว'] || ''),`.
5. Replace `updateFromWeb_` with the version below, and after any write that changed cells clear the 45 s `web_data` response cache (the same call `onOrderSubmit` uses) so other devices see the change on their next pull instead of up to 45 s later (name/number, single `given`, and the batched `orders` kind the checklist now sends).
6. In the sheet: a column headed exactly `แจกแล้ว` in each Jersey tab and in หมวก RCWD (right after ออเดอร์; Insert > Checkbox). Done by the owner on 31 Oct for หมวก RCWD at least.
7. Deploy > Manage deployments > pencil > New version.

```js
const GIVEN_HEADER = 'แจกแล้ว';

function updateFromWeb_(ctx, body) {
  if (body.kind === 'orders') return updateOrdersGiven_(ctx, body);
  const kind = body.kind === 'cap' ? 'cap' : body.kind === 'shirt' ? 'shirt' : '';
  if (!kind) return { ok: false, error: 'แก้ได้เฉพาะรายการเสื้อหรือหมวก' };
  const key = String(body.order || '').trim();
  if (!/^#\d{1,6}(-\d{1,3})?$/.test(key)) return { ok: false, error: 'เลขออเดอร์ไม่ถูกต้อง' };
  const fields = {};
  if (body.name !== undefined) {
    if (kind === 'cap') return { ok: false, error: 'หมวกแก้ได้เฉพาะช่องแจกแล้ว' };
    const name = String(body.name).replace(/\s+/g, ' ').trim().toUpperCase();
    if (!name) return { ok: false, error: 'ใส่ชื่อหลังเสื้อ' };
    if (name.length > 20) return { ok: false, error: 'ชื่อหลังเสื้อยาวเกิน 20 ตัวอักษร' };
    fields['ชื่อหลังเสื้อ'] = name;
  }
  if (body.number !== undefined) {
    if (kind === 'cap') return { ok: false, error: 'หมวกแก้ได้เฉพาะช่องแจกแล้ว' };
    const number = String(body.number).trim();
    if (!/^\d{1,3}$/.test(number)) return { ok: false, error: 'เลขหลังเสื้อต้องเป็นตัวเลข 1-3 หลัก' };
    fields['เลขหลังเสื้อ'] = number;
  }
  if (body.given !== undefined) fields[GIVEN_HEADER] = body.given === true || body.given === 'true';
  const headers = Object.keys(fields);
  if (!headers.length) return { ok: false, error: 'ไม่มีอะไรให้แก้' };
  const hits = [];
  getTabs_(ctx, []).forEach(tab => {
    if (tab.spec.kind !== (kind === 'cap' ? 'cap' : 'jersey')) return;
    readKeys_(tab).forEach(k => { if (k.key === key) hits.push({ tab: tab, row: k.row }); });
  });
  if (!hits.length) return { ok: false, error: 'ไม่พบออเดอร์ ' + key + ' (ดึงข้อมูลใหม่แล้วลองอีกครั้ง)' };
  if (hits.length > 1) return { ok: false, error: 'พบออเดอร์ ' + key + ' มากกว่า 1 แถว แก้ในชีตโดยตรง' };
  const hit = hits[0];
  const n = applyCellChanges_(ctx.ss, hit.tab.sh, hit.row, key, fields, body.username);
  if (n.error) return { ok: false, error: n.error };
  return { ok: true, updated: true, changed: n.changed };
}

// ติ๊ก/เอาติ๊กออกทุกแถวของแต่ละออเดอร์ (เสื้อ #9-1, #9-2 และหมวก #9) ในคำขอเดียว
function updateOrdersGiven_(ctx, body) {
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, 50) : [];
  if (!changes.length) return { ok: false, error: 'ไม่มีอะไรให้แก้' };
  const tabs = getTabs_(ctx, []).filter(t => t.spec.kind === 'jersey' || t.spec.kind === 'cap');
  let total = 0;
  for (let i = 0; i < changes.length; i++) {
    const key = String((changes[i] || {}).order || '').trim();
    if (!/^#\d{1,6}$/.test(key)) return { ok: false, error: 'เลขออเดอร์ไม่ถูกต้อง: ' + key };
    const given = changes[i].given === true || changes[i].given === 'true';
    for (let t = 0; t < tabs.length; t++) {
      const rows = readKeys_(tabs[t]).filter(k => k.key === key || k.key.indexOf(key + '-') === 0);
      for (let r = 0; r < rows.length; r++) {
        const n = applyCellChanges_(ctx.ss, tabs[t].sh, rows[r].row, rows[r].key, { [GIVEN_HEADER]: given }, body.username);
        if (n.error) return { ok: false, error: n.error };
        total += n.changed;
      }
    }
  }
  return { ok: true, updated: true, changed: total };
}

// เขียนเฉพาะช่องที่เปลี่ยน จดค่าเดิมลง log ไม่แตะช่องอื่น
function applyCellChanges_(ss, sh, row, key, fields, user) {
  const cols = headerCols_(sh);
  const changes = [];
  const headers = Object.keys(fields);
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const col = cols[h];
    if (!col) return { error: 'ไม่พบคอลัมน์ "' + h + '" ในแท็บ ' + sh.getName() + ' (เพิ่มหัวคอลัมน์นี้ในชีตก่อน)' };
    const cell = sh.getRange(row, col);
    if (h === GIVEN_HEADER) {
      const was = cell.getValue() === true || /^true$/i.test(String(cell.getDisplayValue()).trim());
      if (was === fields[h]) continue;
      changes.push({ cell: cell, header: h, oldValue: String(was), value: fields[h] });
    } else {
      const oldValue = String(cell.getDisplayValue()).trim();
      if (oldValue === fields[h]) continue;
      changes.push({ cell: cell, header: h, oldValue: oldValue, value: fields[h] });
    }
  }
  if (!changes.length) return { changed: 0 };
  const log = webLogSheet_(ss);
  changes.forEach(ch => {
    if (ch.header === GIVEN_HEADER) ch.cell.setValue(ch.value);
    else ch.cell.setNumberFormat('@').setValue(cleanText_(ch.value));
    log.appendRow([new Date(), String(user || ''), sh.getName(), row, key, ch.header, ch.oldValue, String(ch.value)]);
  });
  return { changed: changes.length };
}
```
(`webLogSheet_` already exists in the owner's Code.gs. `headerCols_`, `getTabs_`, `readKeys_`, `cleanText_` are theirs.)

## 4. Email recap (apps-script/Email.gs)

Where the button is: **in the Google Sheet menu, not on the website** — RCWD > "ส่งอีเมลสรุปออเดอร์ (ที่ยังไม่ได้ส่ง)" and
"ส่งอีเมลทดสอบมาหาฉัน", after installing:
1. Apps Script > Files > + Script named `Email`, paste `apps-script/Email.gs`. Edit `RCWD_EMAIL` texts (pickupText, contactLine, from alias if the script is not in the rcwd.official account).
2. In `onOpen` before `.addSeparator()` add
   `.addItem('ส่งอีเมลสรุปออเดอร์ (ที่ยังไม่ได้ส่ง)', 'sendOrderEmailsFromMenu')` and `.addItem('ส่งอีเมลทดสอบมาหาฉัน', 'sendTestOrderEmail')`.
3. Optional auto-send in `onOrderSubmit` after `syncOrder_(...)`: `if (slip.status === 'VERIFIED') try { emailOrderIfNeeded_(ctx, e.response); } catch (err) { Logger.log(err); }`
4. Deploy new version; refresh the sheet; run the test item once (Gmail permission prompt).
- Sends via `GmailApp` from the script owner (rcwd.official@gmail.com): sender name, reply-to, plain-text twin, reason footer → good deliverability without an app password. Quota ≈100/day on a consumer Gmail; stops early, continues next run.
- Customer email: `response.getRespondentEmail()` (form collects emails) or any form question whose title contains "อีเมล"/"email". The email column already in the sheet comes from the form, so it works.
- Log tab "อีเมลที่ส่งแล้ว (log)" prevents duplicates; delete a row to resend. Nothing else is written.
- A website button for emails was NOT built (it would need the page to call a new `email` action; the menu is simpler and keeps Gmail auth on the owner's side). If wanted: add `action: 'email', order: '#12'` handling in `handleWeb_` calling `emailOrder_` for that response id, and a per-row button on the checklist.

## 5. Owner setup still outstanding (summary)

1. Code.gs edits in §3 + `แจกแล้ว` columns + new deployment → checklist ticks persist and shirts get class groups.
2. `RCWD.web.password` is a short default → change it to a long, unique one.
3. Email.gs install (§4).
4. Optional: Auth.gs tokens (README "ตั้งค่า") → no re-login every time, cache always editable.

## 6. In-flight at handoff

- Branch `claude/zen-goldberg-ksd0dx` carries a commit "signed-out fix": tick boxes and แก้ไข buttons stay visible when there are no credentials; tapping one opens the login with a message; a dashed banner above the list says "ข้อมูลที่เคยดึงไว้ ดูได้อย่างเดียว" with an เข้าสู่ระบบ button. This answers "แจกแล้ว button is gone on pc" (the PC had no saved login, so the page opened read-only from cache). Check PR status on GitHub; merge if green.

## 7. Conventions for future changes

- **Before committing a release run `sh scripts-stamp.sh`**: it rewrites `app.js?v=<commit>`, `styles.css?v=…`,
  `xlsx-lite.js?v=…` in both HTML files so Safari/GitHub Pages caches never serve an old script after a deploy
  (the classic "my change isn't there" symptom). The stamp is the previous commit's hash, which is fine: it only has to change.

- Thai UI text; keep "RCWD Jersey 2026" and feature names. Pills for buttons, cards on phones, tables on desktop.
- Every action that writes goes through `{action:'update'}` with explicit validation server-side; always log old values; never delete.
- Test with the demo (`?demo`) first, then mocked backend, then real.
- Commit messages describe behaviour; no model names in commits.
