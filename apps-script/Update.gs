/**
 * Update.gs — แก้ "ชื่อหลังเสื้อ" และ "เลขหลังเสื้อ" จากหน้าเว็บ RCWD Jersey 2026
 *
 * ทำอะไร: หาแถวที่มีเลขออเดอร์ตรงกัน (เช่น #9-1) ในแท็บเสื้อ แล้วแก้เฉพาะ 2 เซลล์นั้น
 * ไม่ทำอะไร: ไม่ลบแถว ไม่ลบคอลัมน์ ไม่แตะเซลล์อื่น ทุกครั้งที่แก้จะจดค่าเดิมไว้ในแท็บ "แก้ไขจากเว็บ (log)"
 * (เวลา ผู้แก้ แท็บ แถว ออเดอร์ ช่อง ค่าเดิม ค่าใหม่) ถ้าแก้ผิดก็เอาค่าเดิมกลับมาได้
 *
 * ติดตั้ง:
 *  1. Apps Script ของชีต > ไฟล์ > เพิ่มสคริปต์ ชื่อ Update แล้ววางไฟล์นี้ทั้งไฟล์
 *  2. ปรับ CONFIG ด้านล่างให้ตรงกับชื่อแท็บและหัวคอลัมน์ในชีตของคุณ (ดูแถวที่ 1 ของแท็บเสื้อ)
 *  3. ใน doPost: หลังเช็กผู้ใช้ผ่านแล้ว เพิ่ม
 *       if (body.action === 'update') return ContentService.createTextOutput(JSON.stringify(RCWD_UPDATE.handle(body, body.username)))
 *         .setMimeType(ContentService.MimeType.JSON);
 *     (ถ้าใช้ Auth.gs อยู่แล้ว: if (auth.action === 'update') return Auth.json(RCWD_UPDATE.handle(auth.body, auth.username));)
 *  4. Deploy > Manage deployments > Edit > Version: New version
 *
 * หน้าเว็บส่งมา: { action: 'update', kind: 'shirt', order: '#9-1', color: 'เขียว', name: 'FLAG', number: '63' }
 *   หรือจากหน้าเช็กลิสต์: { action: 'update', kind: 'shirt' | 'cap', order: '#9-1', given: true }
 *   (ติ๊ก "แจกแล้ว": ต้องมีคอลัมน์หัวว่า "แจกแล้ว" ในแท็บเสื้อ/หมวก สร้างเองได้เลย สคริปต์เขียน TRUE/FALSE ลงช่องนั้น)
 * สคริปต์ตอบ:   { ok: true, updated: true, changed: 2 } หรือ { ok: false, error: '...' }
 */
var RCWD_UPDATE = (function () {
  var CONFIG = {
    // แท็บที่มีรายการเสื้อ (ตามสี) — ชื่อต้องตรงกับในชีต; ถ้าเสื้อทุกสีอยู่แท็บเดียว ใส่แค่ชื่อเดียว
    sheets: ['Jersey เขียว', 'Jersey ขาว'],
    capSheets: ['หมวก RCWD'],
    headerRow: 1,
    // หัวคอลัมน์ที่เป็นไปได้ (เทียบแบบไม่สนตัวพิมพ์/ช่องว่าง) ใส่เพิ่มได้ถ้าชีตใช้ชื่ออื่น
    columns: {
      order: ['ออเดอร์', 'เลขออเดอร์', 'order', 'order id'],
      name: ['ชื่อหลังเสื้อ', 'ชื่อบนเสื้อ', 'ชื่อ', 'name', 'back name'],
      number: ['เลขหลังเสื้อ', 'เบอร์เสื้อ', 'เลข', 'number', 'back number'],
      given: ['แจกแล้ว', 'รับแล้ว', 'given'],
    },
    logSheet: 'แก้ไขจากเว็บ (log)',
    maxName: 20,
  };

  function norm(v) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function fail(msg) { return { ok: false, error: msg, code: 'update' }; }
  function findCol(headers, names) {
    for (var n = 0; n < names.length; n++) {
      for (var c = 0; c < headers.length; c++) if (norm(headers[c]) === norm(names[n])) return c;
    }
    return -1;
  }

  // หน้าเช็กลิสต์ส่งหลายออเดอร์มาทีเดียว: { kind: 'orders', changes: [{ order: '#9', given: true }, ...] }
  // ติ๊กทุกแถวของออเดอร์นั้น (เสื้อ #9-1, #9-2 และหมวก #9) ในคำขอเดียว
  function handleOrders(body, user) {
    var changes = Array.isArray(body.changes) ? body.changes.slice(0, 50) : [];
    if (!changes.length) return fail('ไม่มีอะไรให้แก้');
    var total = 0;
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i] || {};
      var key = String(c.order || '').trim();
      if (!/^#\d{1,6}$/.test(key)) return fail('เลขออเดอร์ไม่ถูกต้อง: ' + key);
      var given = c.given === true || c.given === 'true';
      var kinds = ['shirt', 'cap'];
      for (var k = 0; k < kinds.length; k++) {
        var names = kinds[k] === 'cap' ? CONFIG.capSheets : CONFIG.sheets;
        for (var n = 0; n < names.length; n++) {
          var r = setGivenInSheet(names[n], key, given, user);
          if (r.error) return fail(r.error);
          total += r.changed;
        }
      }
    }
    return { ok: true, updated: true, changed: total };
  }
  // ติ๊ก/เอาติ๊กออก ทุกแถวในแท็บนี้ที่ออเดอร์เป็น key หรือ key-n
  function setGivenInSheet(sheetName, key, given, user) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() < CONFIG.headerRow + 1) return { changed: 0 };
    var values = sheet.getRange(CONFIG.headerRow, 1, sheet.getLastRow() - CONFIG.headerRow + 1, sheet.getLastColumn()).getValues();
    var oc = findCol(values[0], CONFIG.columns.order);
    var gc = findCol(values[0], CONFIG.columns.given);
    if (oc < 0) return { changed: 0 };
    if (gc < 0) return { error: 'ไม่พบคอลัมน์ "' + CONFIG.columns.given[0] + '" ในแท็บ ' + sheetName };
    var changed = 0;
    for (var r = 1; r < values.length; r++) {
      var cell = norm(values[r][oc]);
      if (cell !== norm(key) && cell.indexOf(norm(key) + '-') !== 0) continue;
      var was = values[r][gc] === true || norm(values[r][gc]) === 'true';
      if (was === given) continue;
      sheet.getRange(CONFIG.headerRow + r, gc + 1).setValue(given);
      logChange(ss, user, sheetName, CONFIG.headerRow + r, String(values[r][oc]), 'แจกแล้ว', String(was), String(given));
      changed++;
    }
    return { changed: changed };
  }
  function logChange(ss, user, sheetName, row, order, label, oldValue, value) {
    var log = ss.getSheetByName(CONFIG.logSheet);
    if (!log) {
      log = ss.insertSheet(CONFIG.logSheet);
      log.appendRow(['เวลา', 'ผู้แก้', 'แท็บ', 'แถว', 'ออเดอร์', 'ช่อง', 'ค่าเดิม', 'ค่าใหม่']);
    }
    log.appendRow([new Date(), String(user || ''), sheetName, row, order, label, oldValue, value]);
  }

  function handle(body, user) {
    if (!body || typeof body !== 'object') return fail('คำขอไม่ถูกต้อง');
    if (body.kind === 'orders') {
      var lk = LockService.getScriptLock();
      if (!lk.tryLock(10000)) return fail('ชีตกำลังถูกใช้งาน ลองใหม่อีกครั้ง');
      try { return handleOrders(body, user); }
      catch (err) { return fail('แก้ไขไม่สำเร็จ: ' + (err && err.message ? err.message : err)); }
      finally { lk.releaseLock(); }
    }
    if (body.kind !== 'shirt' && body.kind !== 'cap') return fail('แก้ได้เฉพาะรายการเสื้อหรือหมวก');
    var order = String(body.order || '').trim();
    if (!/^#\d{1,6}(-\d{1,3})?$/.test(order)) return fail('เลขออเดอร์ไม่ถูกต้อง');
    var fields = {};
    if (body.name !== undefined) {
      var name = String(body.name).replace(/\s+/g, ' ').trim();
      if (!name) return fail('ใส่ชื่อหลังเสื้อ');
      if (name.length > CONFIG.maxName) return fail('ชื่อหลังเสื้อยาวเกิน ' + CONFIG.maxName + ' ตัวอักษร');
      fields.name = name;
    }
    if (body.number !== undefined) {
      var number = String(body.number).trim();
      if (!/^\d{1,3}$/.test(number)) return fail('เลขหลังเสื้อต้องเป็นตัวเลข 1-3 หลัก');
      fields.number = number;
    }
    if (body.given !== undefined) fields.given = body.given === true || body.given === 'true';
    if (body.kind === 'cap' && (fields.name !== undefined || fields.number !== undefined)) return fail('หมวกแก้ได้เฉพาะช่องแจกแล้ว');
    var keys = Object.keys(fields);
    if (!keys.length) return fail('ไม่มีอะไรให้แก้');

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return fail('ชีตกำลังถูกใช้งาน ลองใหม่อีกครั้ง');
    try {
      var ss = SpreadsheetApp.getActiveSpreadsheet();
      var hit = null;
      var sheetNames = body.kind === 'cap' ? CONFIG.capSheets : CONFIG.sheets;
      for (var i = 0; i < sheetNames.length; i++) {
        var sheet = ss.getSheetByName(sheetNames[i]);
        if (!sheet || sheet.getLastRow() < CONFIG.headerRow + 1) continue;
        var values = sheet.getRange(CONFIG.headerRow, 1, sheet.getLastRow() - CONFIG.headerRow + 1, sheet.getLastColumn()).getValues();
        var headers = values[0];
        var oc = findCol(headers, CONFIG.columns.order);
        if (oc < 0) continue;
        for (var r = 1; r < values.length; r++) {
          if (norm(values[r][oc]) !== norm(order)) continue;
          if (hit) return fail('พบออเดอร์ ' + order + ' มากกว่า 1 แถว แก้ในชีตโดยตรง');
          hit = { sheet: sheet, row: CONFIG.headerRow + r, headers: headers, values: values[r] };
        }
      }
      if (!hit) return fail('ไม่พบออเดอร์ ' + order + ' ในชีต (ดึงข้อมูลใหม่แล้วลองอีกครั้ง)');

      var changes = [];
      for (var k = 0; k < keys.length; k++) {
        var field = keys[k];
        var col = findCol(hit.headers, CONFIG.columns[field]);
        if (col < 0) return fail('ไม่พบคอลัมน์ "' + CONFIG.columns[field][0] + '" ในแท็บ ' + hit.sheet.getName() + ' (ปรับ CONFIG ใน Update.gs)');
        var oldValue = hit.values[col];
        if (field === 'given') { if ((oldValue === true || norm(oldValue) === 'true') === fields.given) continue; }
        else if (norm(oldValue) === norm(fields[field])) continue;
        changes.push({ col: col, field: field, oldValue: oldValue, value: fields[field] });
      }
      if (!changes.length) return { ok: true, updated: true, changed: 0 };

      var log = ss.getSheetByName(CONFIG.logSheet);
      if (!log) {
        log = ss.insertSheet(CONFIG.logSheet);
        log.appendRow(['เวลา', 'ผู้แก้', 'แท็บ', 'แถว', 'ออเดอร์', 'ช่อง', 'ค่าเดิม', 'ค่าใหม่']);
      }
      for (var c = 0; c < changes.length; c++) {
        var ch = changes[c];
        var cell = hit.sheet.getRange(hit.row, ch.col + 1);
        // เลขหลังเสื้อเก็บเป็นข้อความ เพื่อให้ "07" ไม่กลายเป็น 7
        if (ch.field === 'number') cell.setNumberFormat('@');
        cell.setValue(ch.value);
        var label = ch.field === 'name' ? 'ชื่อหลังเสื้อ' : ch.field === 'number' ? 'เลขหลังเสื้อ' : 'แจกแล้ว';
        log.appendRow([new Date(), String(user || ''), hit.sheet.getName(), hit.row, order, label, String(ch.oldValue), String(ch.value)]);
      }
      return { ok: true, updated: true, changed: changes.length };
    } catch (err) {
      return fail('แก้ไขไม่สำเร็จ: ' + (err && err.message ? err.message : err));
    } finally {
      lock.releaseLock();
    }
  }

  return { handle: handle };
})();
