/*
 * xlsx-lite: writes a small .xlsx workbook with no dependencies.
 * An .xlsx file is a zip of XML parts; this writes them with "stored"
 * (uncompressed) zip entries, inline strings (no shared-string table), a
 * bold frozen header row and column widths. Enough for Excel, Numbers on
 * iPhone, LibreOffice and Google Sheets to open the export. Replaces the
 * 900 KB SheetJS script that used to be fetched from a CDN at export time,
 * so nothing is loaded from a third party and the page's CSP can stay
 * script-src 'self'.
 *
 *   XlsxLite.build({ sheets: [{ name, rows: [[cell, …], …], widths: [n, …] }] }) -> Blob
 *   XlsxLite.bytes(workbook) -> Uint8Array (same content, for tests)
 *
 * A cell is a number (numeric cell), a string (text, kept as typed: "007"
 * and phone numbers keep their leading zeros), or null/undefined/'' (empty).
 */
(function (root) {
  'use strict';

  const encoder = new TextEncoder();

  // ---------- zip (stored entries, CRC-32) ----------
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = -1;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function dosStamp(date) {
    const d = date || new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, day };
  }

  /** files: [{ name, data: Uint8Array }] -> Uint8Array of a zip archive. */
  function zip(files, date) {
    const { time, day } = dosStamp(date);
    const entries = files.map((f) => ({ name: encoder.encode(f.name), data: f.data, crc: crc32(f.data) }));
    const localSize = entries.reduce((t, e) => t + 30 + e.name.length + e.data.length, 0);
    const centralSize = entries.reduce((t, e) => t + 46 + e.name.length, 0);
    const out = new Uint8Array(localSize + centralSize + 22);
    const view = new DataView(out.buffer);
    let pos = 0;
    const u16 = (v) => { view.setUint16(pos, v, true); pos += 2; };
    const u32 = (v) => { view.setUint32(pos, v >>> 0, true); pos += 4; };
    const put = (bytes) => { out.set(bytes, pos); pos += bytes.length; };

    const offsets = [];
    for (const e of entries) {
      offsets.push(pos);
      u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
      u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
      put(e.name); put(e.data);
    }
    const centralStart = pos;
    entries.forEach((e, i) => {
      u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
      u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0); u16(0);
      u16(0); u16(0); u32(0); u32(offsets[i]);
      put(e.name);
    });
    u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
    u32(pos - centralStart - 0); // placeholder, fixed below
    // central directory size and offset
    view.setUint32(pos - 4, centralSize, true);
    u32(centralStart); u16(0);
    return out;
  }

  // ---------- XML ----------
  // Characters XML 1.0 cannot carry (control characters) are dropped; the rest is escaped.
  const INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
  function esc(value) {
    return String(value).replace(INVALID, '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  function colRef(index) {
    let s = '';
    let i = index + 1;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  /** Excel sheet names: at most 31 characters, none of []:*?/\ and not empty. */
  function sheetName(name, index) {
    const clean = String(name || '').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31);
    return clean || 'Sheet' + (index + 1);
  }

  function cellXml(ref, value, style) {
    const s = style ? ' s="' + style + '"' : '';
    if (typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '"' + s + '><v>' + value + '</v></c>';
    if (value === null || value === undefined || value === '') return '';
    return '<c r="' + ref + '" t="inlineStr"' + s + '><is><t xml:space="preserve">' + esc(value) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    const widths = sheet.widths || [];
    const cols = Math.max(1, ...rows.map((r) => r.length), widths.length);
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:' + colRef(cols - 1) + Math.max(1, rows.length) + '"/>' +
      // the header row stays put while scrolling
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>';
    if (widths.length) {
      xml += '<cols>' + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (Number(w) || 10) + '" customWidth="1"/>').join('') + '</cols>';
    }
    xml += '<sheetData>';
    rows.forEach((row, r) => {
      const cells = row.map((v, c) => cellXml(colRef(c) + (r + 1), v, r === 0 ? 1 : 0)).join('');
      xml += '<row r="' + (r + 1) + '">' + cells + '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  }

  const CONTENT_TYPES = (count) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    Array.from({ length: count }, (_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') +
    '</Types>';

  const ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const WORKBOOK = (names) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' + names.map((n, i) => '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets>' +
    '</workbook>';

  const WORKBOOK_RELS = (count) =>
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    Array.from({ length: count }, (_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') +
    '<Relationship Id="rId' + (count + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  // Style 0: default. Style 1: bold (the header row).
  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function bytes(workbook) {
    const sheets = (workbook && workbook.sheets) || [];
    if (!sheets.length) throw new Error('xlsx-lite: a workbook needs at least one sheet');
    const names = [];
    sheets.forEach((s, i) => {
      let n = sheetName(s.name, i);
      while (names.some((x) => x.toLowerCase() === n.toLowerCase())) n = (n.slice(0, 28) + ' ' + (i + 1)).trim();
      names.push(n);
    });
    const text = (s) => encoder.encode(s);
    const files = [
      { name: '[Content_Types].xml', data: text(CONTENT_TYPES(sheets.length)) },
      { name: '_rels/.rels', data: text(ROOT_RELS) },
      { name: 'xl/workbook.xml', data: text(WORKBOOK(names)) },
      { name: 'xl/_rels/workbook.xml.rels', data: text(WORKBOOK_RELS(sheets.length)) },
      { name: 'xl/styles.xml', data: text(STYLES) },
    ];
    sheets.forEach((s, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: text(sheetXml(s)) }));
    return zip(files, workbook.date);
  }

  function build(workbook) {
    return new Blob([bytes(workbook)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  root.XlsxLite = { build, bytes, _internal: { crc32, zip, esc, colRef, sheetName } };
})(typeof window !== 'undefined' ? window : globalThis);
