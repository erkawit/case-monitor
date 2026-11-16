/*!
 * processor.js — แกนประมวลผลข้อมูลคดีตามเกณฑ์การ Monitor
 * ทำงานได้ทั้งในเบราว์เซอร์ (window.CaseProcessor) และ Node.js (module.exports)
 * รับข้อมูลชีตในรูปแบบ Array of Arrays (แถว x คอลัมน์) ไม่ผูกกับไลบรารีอ่าน Excel ตัวใด
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CaseProcessor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------
   * 1) ค่ากำหนดเกณฑ์ (แก้ไขได้ที่นี่ที่เดียว)
   * ------------------------------------------------------------------ */
  var RULES = {
    // คดีจัดการพิเศษ — อักษรย่อที่ใช้เกณฑ์ 5–6 เดือนเสมอ
    SPECIAL_PREFIXES: ['ผบ', 'ผบE', 'ม', 'มE', 'มย', 'มยE'],
    // อักษรย่อ พ / พE — ต้องตรวจช่อง "จำเลย" และ "ข้อหา" ก่อนจัดประเภท
    CONDITIONAL_PREFIXES: ['พ', 'พE'],
    // อักษรย่อที่ "หากมีข้อมูลจำเลย" ให้พิจารณาเหมือน พ / พE ที่มีจำเลย (ไม่มีจำเลย => กลุ่มอักษรย่ออื่น)
    // ไม่มีข้อมูลจำเลย => คดีจัดการพิเศษ (5–6 เดือน) / มีข้อมูลจำเลย => คดีจัดการทั่วไป (11–12 เดือน)
    DEFENDANT_SPLIT_PREFIXES: ['รส'],
    // คดีจัดการทั่วไป — อักษรย่อที่ใช้เกณฑ์ 11–12 เดือน
    GENERAL_PREFIXES: ['อ', 'ย', 'ยฝ', 'ฝ'],
    // อักษรย่ออื่นที่ไม่อยู่ในรายการ — ตรวจกรอบ 11–12 เดือน โดยพิจารณาวันนัดต่อไปประกอบ
    OTHER_WINDOW: '12M',
    // ข้อหาที่ถือเป็นคดีจัดการมรดก (ตรวจแบบ "มีคำนี้อยู่ในข้อหา")
    INHERITANCE_KEYWORDS: ['จัดการมรดก', 'ขอจัดการมรดก'],
    // รายงานหมายระหว่างพิจารณา (คดีอาญา) — เฝ้าระวังนับจาก "วันเดือนปีที่ออกหมาย"
    WRIT_WINDOW: '6M',
    // กรอบระยะเวลา (เดือน)
    WINDOW: {
      '6M':  { warn: 5,  limit: 6,  label: 'กรอบ 5 เดือน แต่ไม่เกิน 6 เดือน' },
      '12M': { warn: 11, limit: 12, label: 'กรอบ 11 เดือน แต่ไม่เกิน 1 ปี' },
      // เฝ้าระวังตั้งแต่ครบ 1 ปีขึ้นไป (สีเขียว) จนถึง 1 ปี 6 เดือน (สีแดง)
      '18M': { warn: 12, limit: 18, label: 'กรอบเกิน 1 ปี แต่ไม่เกิน 1 ปี 6 เดือน' }
    }
  };

  var STATUS = {
    red:     { rank: 4, label: 'เกินกำหนด' },
    green:   { rank: 3, label: 'เฝ้าระวัง' },
    normal:  { rank: 2, label: 'ปกติ' },
    done:    { rank: 1, label: 'เสร็จสิ้น (มีเลขคดีแดง)' },
    out:     { rank: 0, label: 'นอกเกณฑ์' },
    nodate:  { rank: 0, label: 'ไม่มีวันที่รับฟ้อง' },
    bail:    { rank: 1, label: 'ปล่อยชั่วคราวแล้ว' },
    noissue: { rank: 0, label: 'ไม่มีวันออกหมาย' },
    excluded:{ rank: 0, label: 'ไม่อยู่ในเกณฑ์เฝ้าระวัง' }
  };

  /* ------------------------------------------------------------------
   * 2) เครื่องมือข้อความ / วันที่
   * ------------------------------------------------------------------ */
  function str(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return toISO(v);
    return String(v).replace(/ /g, ' ').replace(/\r/g, '').trim();
  }
  function squash(v) { return str(v).replace(/\s+/g, ''); }
  function oneLine(v) { return str(v).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim(); }
  function isEmptyValue(v) { var s = str(v); return s === '' || s === '-' || s === '–'; }

  var TH_MONTHS = [
    ['มกราคม', 'ม.ค.', 'มค'], ['กุมภาพันธ์', 'ก.พ.', 'กพ'], ['มีนาคม', 'มี.ค.', 'มีค'],
    ['เมษายน', 'เม.ย.', 'เมย'], ['พฤษภาคม', 'พ.ค.', 'พค'], ['มิถุนายน', 'มิ.ย.', 'มิย'],
    ['กรกฎาคม', 'ก.ค.', 'กค'], ['สิงหาคม', 'ส.ค.', 'สค'], ['กันยายน', 'ก.ย.', 'กย'],
    ['ตุลาคม', 'ต.ค.', 'ตค'], ['พฤศจิกายน', 'พ.ย.', 'พย'], ['ธันวาคม', 'ธ.ค.', 'ธค']
  ];
  var MONTH_LOOKUP = {};
  var monthAlts = [];
  TH_MONTHS.forEach(function (names, i) {
    names.forEach(function (n) {
      MONTH_LOOKUP[n.replace(/\./g, '')] = i;
      monthAlts.push(n.replace(/\./g, '\\.'));
    });
  });
  monthAlts.sort(function (a, b) { return b.length - a.length; });
  var RE_TH_DATE = new RegExp('(\\d{1,2})\\s*[-/ ]?\\s*(' + monthAlts.join('|') + ')\\s*[-/ ]?\\s*(\\d{2,4})');
  var RE_NUM_DATE = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/;

  function normYear(y) {
    y = parseInt(y, 10);
    if (y < 100) y = 2500 + y;          // ปี พ.ศ. 2 หลัก เช่น 69 => 2569
    if (y > 2400) y -= 543;             // แปลง พ.ศ. => ค.ศ.
    return y;
  }
  function makeDate(y, m, d) {
    var dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return dt;
  }
  function toISO(d) {
    if (!d) return '';
    if (!(d instanceof Date)) return '';
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function fromISO(s) {
    if (!s) return null;
    var p = String(s).split('-');
    return makeDate(+p[0], +p[1] - 1, +p[2]);
  }
  /** แปลงค่าใด ๆ เป็นวันที่ (UTC เที่ยงคืน) — รองรับ '03-เม.ย.-69', '2 พ.ย. 69', '10/11/2569', Excel serial, Date */
  function parseDate(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date && !isNaN(v)) {
      return makeDate(v.getFullYear(), v.getMonth(), v.getDate());
    }
    if (typeof v === 'number' && v > 20000 && v < 80000) {           // Excel serial date
      var ms = Math.round((v - 25569) * 86400000);
      var e = new Date(ms);
      return makeDate(e.getUTCFullYear(), e.getUTCMonth(), e.getUTCDate());
    }
    var s = str(v);
    var m = s.match(RE_TH_DATE);
    if (m) {
      var mi = MONTH_LOOKUP[m[2].replace(/\./g, '')];
      if (mi !== undefined) return makeDate(normYear(m[3]), mi, parseInt(m[1], 10));
    }
    m = s.match(RE_NUM_DATE);
    if (m) return makeDate(normYear(m[3]), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    return null;
  }
  /** แยกข้อความวันนัด เช่น '11-พ.ย.-69\n09.00\nไต่สวนคำร้อง' หรือ 'ไต่สวนมูลฟ้อง\n18 ม.ค. 70\n เวลา 09.00 น.' */
  function parseAppointment(v) {
    var raw = str(v);
    var out = { raw: oneLine(raw), date: '', time: '', detail: '' };
    if (!raw) return out;
    var d = parseDate(raw);
    out.date = toISO(d);
    var t = raw.match(/(\d{1,2})[.:](\d{2})(?:\s*น\.)?/);   // "น." ต้องมีจุด เพื่อไม่ให้กินตัว "น" ของคำว่า "นัด"
    var detail = raw;
    var dm = raw.match(RE_TH_DATE) || raw.match(RE_NUM_DATE);
    if (dm) detail = detail.replace(dm[0], ' ');
    if (t) { out.time = (t[1].length < 2 ? '0' : '') + t[1] + '.' + t[2] + ' น.'; detail = detail.replace(t[0], ' '); }
    out.detail = detail.replace(/เวลา/g, ' ').replace(/\s+/g, ' ').trim();
    return out;
  }
  /** จำนวนเดือนเต็ม + วันที่เหลือ ระหว่าง a ถึง b (นับแบบปฏิทิน) */
  function diffMonths(a, b) {
    if (!a || !b) return null;
    var sign = 1;
    if (b < a) { var tmp = a; a = b; b = tmp; sign = -1; }
    var months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    if (b.getUTCDate() < a.getUTCDate()) months--;
    var anchor = addMonths(a, months);
    if (anchor > b) { months--; anchor = addMonths(a, months); }
    var days = Math.round((b - anchor) / 86400000);
    var total = Math.round((b - a) / 86400000);
    return { months: months * sign, days: days * sign, totalDays: total * sign };
  }
  function addMonths(d, n) {
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  }
  function formatAge(a) {
    if (!a) return '';
    var txt = [];
    if (a.months) txt.push(a.months + ' เดือน');
    txt.push(a.days + ' วัน');
    return txt.join(' ');
  }
  var TH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function thaiDate(iso) {
    var d = typeof iso === 'string' ? fromISO(iso) : iso;
    if (!d) return '';
    return d.getUTCDate() + ' ' + TH_SHORT[d.getUTCMonth()] + ' ' + (d.getUTCFullYear() + 543);
  }

  /* ------------------------------------------------------------------
   * 3) เลขคดี / อักษรย่อ
   * ------------------------------------------------------------------ */
  var RE_CASE = /([ก-ฮA-Za-z]{1,8})\s*\.?\s*(\d{1,6})\s*\/\s*(\d{4})/g;
  function normPrefix(p) { return String(p || '').replace(/e$/, 'E'); }
  function extractCaseNumbers(v) {
    var s = str(v), m, out = [];
    RE_CASE.lastIndex = 0;
    while ((m = RE_CASE.exec(s)) !== null) {
      var prefix = normPrefix(m[1]);
      out.push({ text: prefix + m[2] + '/' + m[3], prefix: prefix, no: +m[2], year: +m[3] });
    }
    return out;
  }

  /* ------------------------------------------------------------------
   * 4) ตรวจหัวตาราง และจับคู่คอลัมน์
   * ------------------------------------------------------------------ */
  // ลำดับมีผล: ตรวจจากบนลงล่าง คอลัมน์ใดจับคู่แล้วจะไม่ถูกนำไปจับคู่ซ้ำ
  var FIELD_PATTERNS = [
    ['seq',        [/^(ที่|ลำดับ|ลำดับที่)$/]],
    ['blackRed',   [/เลขดำ.*เลขแดง/, /หมายเลขดำ.*แดง/]],
    ['black',      [/เลขคดีดำ/, /หมายเลขคดีดำ/, /หมายเลขดำ/, /เลขดำ/]],
    ['red',        [/เลขคดีแดง/, /หมายเลขคดีแดง/, /หมายเลขแดง/, /เลขแดง/]],
    ['filingDate', [/วันที่รับฟ้อง/, /วันรับฟ้อง/, /วันที่ฟ้อง/, /วันฟ้อง/]],
    ['nextAppt',   [/วันนัดต่อไป/, /วันนัดพิจารณา/, /วันนัด/]],
    ['plaintiff',  [/^โจทก์/, /ผู้ร้อง/]],
    ['defendant',  [/^จำเลย/, /ผู้คัดค้าน/]],
    ['charge',     [/^ข้อหา/, /เรื่อง\/สถิติ/, /^เรื่อง$/]],
    ['pendingReason', [/เหตุที่ค้าง/]],
    ['owner',      [/เจ้าของสำนวน/]],
    ['judge',      [/ผู้พิพากษา/]],
    ['caseType',   [/ประเภทคดี/]]
  ];
  var HEADER_HINTS = /(เลขดำ|เลขคดีดำ|หมายเลขดำ|วันรับฟ้อง|วันที่รับฟ้อง|โจทก์|จำเลย|ข้อหา)/;

  function findHeaderRow(rows) {
    var best = -1, bestScore = 0;
    var lim = Math.min(rows.length, 40);
    for (var i = 0; i < lim; i++) {
      var r = rows[i] || [], score = 0, hasSeq = false;
      for (var c = 0; c < r.length; c++) {
        var h = squash(r[c]);
        if (!h || h.length > 40) continue;
        if (/^(ที่|ลำดับ|ลำดับที่)$/.test(h)) hasSeq = true;
        if (HEADER_HINTS.test(h)) score++;
      }
      if (hasSeq) score++;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return bestScore >= 2 ? best : -1;
  }

  function mapColumns(headerRow) {
    var map = {}, used = {}, headers = [];
    for (var c = 0; c < headerRow.length; c++) {
      var label = oneLine(headerRow[c]);
      if (label) headers.push({ col: c, label: label });
    }
    FIELD_PATTERNS.forEach(function (fp) {
      var field = fp[0];
      for (var p = 0; p < fp[1].length && map[field] === undefined; p++) {
        for (var i = 0; i < headers.length; i++) {
          var h = headers[i];
          if (used[h.col]) continue;
          if (fp[1][p].test(squash(h.label))) { map[field] = h.col; used[h.col] = field; break; }
        }
      }
    });
    return { map: map, headers: headers, used: used };
  }

  /** ข้อมูลส่วนหัวรายงาน (ชื่อรายงาน, กลุ่มคดี, ช่วงวันที่) ที่อยู่เหนือหัวตาราง */
  function readReportMeta(rows, headerIdx) {
    var meta = { title: '', group: '', period: '' };
    var lim = headerIdx >= 0 ? headerIdx : Math.min(rows.length, 6);
    for (var i = 0; i < lim; i++) {
      (rows[i] || []).forEach(function (cell) {
        var s = oneLine(cell);
        if (!s || /^แผ่นที่/.test(s) || s === 'รวม' || s === 'เรื่อง') return;
        if (/^กลุ่มคดี/.test(s)) { if (!meta.group) meta.group = s; }
        else if (/(ถึงวันที่|ตั้งแต่วันที่|ระหว่างวันที่|ค้างถึง)/.test(s)) { if (!meta.period) meta.period = s; }
        else if (!meta.title && s.length > 4 && !/^\d+(\.\d+)?$/.test(s)) meta.title = s;
      });
    }
    return meta;
  }

  /* ------------------------------------------------------------------
   * 5) อ่านแต่ละชีต => records + ข้อมูลดิบ
   * ------------------------------------------------------------------ */
  function parseSheet(fileName, sheetName, rows) {
    var result = { file: fileName, sheet: sheetName, ok: false, message: '', meta: null, headers: [], rawRows: [], rawKeys: [], records: [], fieldMap: {} };
    rows = rows || [];
    var hIdx = findHeaderRow(rows);
    if (hIdx < 0) {
      result.message = 'ไม่พบแถวหัวตาราง (ข้ามชีตนี้)';
      return result;
    }
    var meta = readReportMeta(rows, hIdx);
    var cm = mapColumns(rows[hIdx]);
    var map = cm.map;
    result.meta = meta;
    result.headers = cm.headers.map(function (h) { return h.label; });
    result.fieldMap = map;
    var caseCol = map.blackRed !== undefined ? map.blackRed : map.black;
    if (caseCol === undefined) {
      result.message = 'ไม่พบคอลัมน์เลขคดีดำ (ข้ามชีตนี้)';
      return result;
    }

    for (var i = hIdx + 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var cells = cm.headers.map(function (h) { return str(r[h.col]); });
      var filled = cells.filter(function (x) { return x !== ''; }).length;
      if (filled < 2) continue;                         // แถวว่าง / หมายเหตุ / ผู้ส่ง-ผู้รับ
      // หัวตารางซ้ำ (กรณีรายงานหลายหน้า)
      if (squash(r[caseCol]) === squash(rows[hIdx][caseCol])) continue;

      var nums = extractCaseNumbers(r[caseCol]);
      if (!nums.length) continue;                       // ไม่ใช่แถวข้อมูลคดี
      var black = nums[0], red = '';
      result.rawRows.push(cells);
      result.rawKeys.push(black.text);

      if (map.blackRed !== undefined && nums.length > 1) red = nums[1].text;
      if (map.red !== undefined) {
        var rn = extractCaseNumbers(r[map.red]);
        if (rn.length) red = rn[0].text; else if (!isEmptyValue(r[map.red])) red = oneLine(r[map.red]);
      }
      var appt = map.nextAppt !== undefined ? parseAppointment(r[map.nextAppt]) : null;
      var fd = map.filingDate !== undefined ? parseDate(r[map.filingDate]) : null;

      var extra = {};
      cm.headers.forEach(function (h) {
        if (cm.used[h.col]) return;
        var v = oneLine(r[h.col]);
        if (v) extra[h.label] = v;
      });

      result.records.push({
        key: black.text,
        black: black.text,
        prefix: black.prefix,
        caseYear: black.year,
        red: red,
        filingDateRaw: map.filingDate !== undefined ? oneLine(r[map.filingDate]) : '',
        filingDate: toISO(fd),
        filingDateFrom: fd ? fileName + ' › ' + sheetName : '',
        plaintiff: map.plaintiff !== undefined ? oneLine(r[map.plaintiff]) : '',
        defendant: map.defendant !== undefined && !isEmptyValue(r[map.defendant]) ? oneLine(r[map.defendant]) : '',
        hasDefendantColumn: map.defendant !== undefined,
        charge: map.charge !== undefined ? oneLine(r[map.charge]) : '',
        nextApptRaw: appt ? appt.raw : '',
        nextApptDate: appt ? appt.date : '',
        nextApptTime: appt ? appt.time : '',
        nextApptDetail: appt ? appt.detail : '',
        hasNextApptColumn: map.nextAppt !== undefined,
        hasRedColumn: map.red !== undefined || map.blackRed !== undefined,
        pendingReason: map.pendingReason !== undefined && !isEmptyValue(r[map.pendingReason]) ? oneLine(r[map.pendingReason]) : '',
        owner: map.owner !== undefined && !isEmptyValue(r[map.owner]) ? oneLine(r[map.owner]) : '',
        judge: map.judge !== undefined && !isEmptyValue(r[map.judge]) ? oneLine(r[map.judge]) : '',
        caseType: map.caseType !== undefined ? oneLine(r[map.caseType]) : '',
        group: meta.group,
        reportTitle: meta.title,
        sources: [{ file: fileName, sheet: sheetName }],
        extra: extra
      });
    }
    result.ok = true;
    result.message = 'พบข้อมูล ' + result.records.length + ' แถว';
    return result;
  }

  /* ------------------------------------------------------------------
   * 5.1) รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา
   *      ตรวจจากคอลัมน์ "วันเดือนปีที่ออกหมาย" — แยกออกเป็นรายงานต่างหาก ไม่นำไปนับระยะเวลาคดี
   * ------------------------------------------------------------------ */
  var WRIT_KEY = /วันเดือนปีที่ออกหมาย/;
  function findWritHeaderRow(rows) {
    var lim = Math.min((rows || []).length, 40);
    for (var i = 0; i < lim; i++) {
      var r = rows[i] || [];
      for (var c = 0; c < r.length; c++) if (WRIT_KEY.test(squash(r[c]))) return i;
    }
    return -1;
  }
  function isWritSheet(rows) { return findWritHeaderRow(rows) >= 0; }

  var WRIT_FIELDS = [
    ['seq',       [/^(ที่|ลำดับ|ลำดับที่)$/]],
    ['issueDate', [WRIT_KEY]],
    ['refNo',     [/เลขที่หมายอ้างอิง/, /หมายอ้างอิง/]],
    ['writNo',    [/^เลขที่หมาย$/, /เลขที่หมาย/]],
    ['black',     [/หมายเลขดำ/, /เลขคดีดำ/, /เลขดำ/]],
    ['red',       [/หมายเลขแดง/, /เลขคดีแดง/, /เลขแดง/]],
    ['name',      [/ผู้ต้องขัง/, /ชื่อ/, /จำเลย/]],
    ['charge',    [/^ข้อหา/]],
    ['penalty',   [/กำหนดโทษ/, /โทษ/]]
  ];

  function parseWritSheet(fileName, sheetName, rows) {
    var result = { type: 'writ', file: fileName, sheet: sheetName, ok: false, message: '', meta: null,
      headers: [], rawRows: [], rawKeys: [], records: [], fieldMap: {} };
    rows = rows || [];
    var hIdx = findWritHeaderRow(rows);
    if (hIdx < 0) { result.message = 'ไม่พบคอลัมน์ "วันเดือนปีที่ออกหมาย"'; return result; }

    // ส่วนหัวรายงาน เช่น "รวมทั้งสิ้น 125 ฉบับ", "แบบ ๙ ค.", "ระหว่างวันที่ ..."
    var meta = { title: 'รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา', form: '', period: '', totalText: '', group: 'คดีอาญา (ออกหมายระหว่างพิจารณา)' };
    for (var i = 0; i < hIdx; i++) {
      (rows[i] || []).forEach(function (cell) {
        var s = oneLine(cell);
        if (!s) return;
        if (/^แบบ/.test(s)) meta.form = s;
        else if (/รวมทั้งสิ้น/.test(s)) meta.totalText = s;
        else if (/(ระหว่างวันที่|ตั้งแต่วันที่|ถึงวันที่)/.test(s)) meta.period = s;
        else if (!/^แผ่นที่/.test(s) && s.length > 4 && !/^\d+(\.\d+)?$/.test(s)) meta.subtitle = meta.subtitle || s;
      });
    }
    var hdr = rows[hIdx], headers = [], used = {}, map = {};
    for (var c = 0; c < hdr.length; c++) { var lb = oneLine(hdr[c]); if (lb) headers.push({ col: c, label: lb }); }
    WRIT_FIELDS.forEach(function (fp) {
      for (var p = 0; p < fp[1].length && map[fp[0]] === undefined; p++) {
        for (var k = 0; k < headers.length; k++) {
          if (used[headers[k].col]) continue;
          if (fp[1][p].test(squash(headers[k].label))) { map[fp[0]] = headers[k].col; used[headers[k].col] = fp[0]; break; }
        }
      }
    });
    result.meta = meta;
    result.headers = headers.map(function (h) { return h.label; });
    result.fieldMap = map;

    for (var r = hIdx + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var cells = headers.map(function (h) { return str(row[h.col]); });
      if (cells.filter(function (x) { return x !== ''; }).length < 3) continue;   // ผู้ส่ง/ผู้รับ/หมายเหตุ
      if (WRIT_KEY.test(squash(row[map.issueDate]))) continue;                  // หัวตารางซ้ำ
      var issue = map.issueDate !== undefined ? parseDate(row[map.issueDate]) : null;
      var nums = map.black !== undefined ? extractCaseNumbers(row[map.black]) : [];
      if (!issue && !nums.length) continue;
      var extra = {};
      headers.forEach(function (h) { if (!used[h.col]) { var v = oneLine(row[h.col]); if (v) extra[h.label] = v; } });
      var g = function (f) { return map[f] !== undefined && !isEmptyValue(row[map[f]]) ? oneLine(row[map[f]]) : ''; };
      var blackText = nums.length ? nums[0].text : g('black');
      result.rawRows.push(cells);
      result.rawKeys.push(blackText);
      var rec = {
        seq: g('seq'),
        issueDate: toISO(issue), issueDateRaw: g('issueDate'),
        refNo: g('refNo'), writNo: g('writNo'),
        black: blackText, prefix: nums.length ? nums[0].prefix : '',
        red: g('red'), name: g('name'), charge: g('charge'), penalty: g('penalty'),
        extra: extra, source: { file: fileName, sheet: sheetName }
      };
      rec.uid = writKey(rec);
      result.records.push(rec);
    }
    result.ok = true;
    result.message = 'รายงานหมายระหว่างพิจารณา ' + result.records.length + ' ฉบับ';
    return result;
  }

  /** รหัสประจำรายการหมาย (คงที่ข้ามการนำเข้าแต่ละครั้ง) ใช้ผูกกับการบันทึก "ปล่อยชั่วคราว" ของเจ้าหน้าที่ */
  function writKey(w) {
    var id = w.writNo || w.refNo || ((w.issueDateRaw || '') + '#' + (w.name || ''));
    return squash(w.black) + '|' + squash(id);
  }

  /**
   * ประเมินหมายแต่ละรายการ: กรอบ 5 เดือน แต่ไม่เกิน 6 เดือน
   * โดยเทียบระยะเวลาจาก "วันที่รับฟ้อง" (จากรายงานคดี — เลขคดีดำตรงกัน) ถึง "วันเดือนปีที่ออกหมาย"
   *  - นำออกจากเกณฑ์โดยเจ้าหน้าที่ => excluded
   *  - เจ้าหน้าที่ระบุว่ามีการออกหมายปล่อยชั่วคราวระหว่างพิจารณา => bail
   *  - ไม่มีวันเดือนปีที่ออกหมาย => noissue
   *  - ไม่พบวันที่รับฟ้องของคดี => nodate (เทียบไม่ได้)
   *  - ช่วงรับฟ้อง→ออกหมาย ≥ 6 เดือน => red, ≥ 5 เดือน => green, อื่น ๆ => normal
   */
  function evaluateWrit(w, today, flag, exclude, filingISO) {
    var win = RULES.WINDOW[RULES.WRIT_WINDOW];
    var issue = fromISO(w.issueDate);
    var filing = fromISO(filingISO);
    var age = (filing && issue) ? diffMonths(filing, issue) : null;
    var lim = filing ? addMonths(filing, win.limit) : null;
    var ev = { window: RULES.WRIT_WINDOW, windowLabel: win.label, filingDate: filingISO || '',
      ageText: formatAge(age), ageDays: age ? age.totalDays : null, ageMonths: age ? age.months : null,
      status: 'normal', note: '', nowStatus: '',
      warnDate: filing ? toISO(addMonths(filing, win.warn)) : '', limitDate: toISO(lim), soonDate: '',
      // จำนวนวันจากวันออกหมายถึงวันครบ 6 เดือนนับจากวันรับฟ้อง (บวก = ออกหมายก่อนครบ, ลบ = ออกหมายหลังครบ)
      daysToLimit: (lim && issue) ? daysBetween(issue, lim) : null };
    if (exclude) {
      ev.status = 'excluded';
      ev.note = 'เจ้าหน้าที่นำออกจากเกณฑ์เฝ้าระวัง' + (exclude.note ? ' — ' + exclude.note : '');
      ev.daysToLimit = null;
      return ev;
    }
    if (flag && flag.bail) {
      ev.status = 'bail';
      ev.note = 'เจ้าหน้าที่ระบุว่ามีการขอประกันตัวและออกหมายปล่อยชั่วคราวระหว่างพิจารณาแล้ว' + (flag.note ? ' — ' + flag.note : '');
      return ev;
    }
    if (!issue) {
      ev.status = 'noissue';
      ev.note = w.issueDateRaw ? 'อ่านวันเดือนปีที่ออกหมายไม่ได้ ("' + w.issueDateRaw + '")' : 'ไม่มีข้อมูลวันเดือนปีที่ออกหมาย';
      return ev;
    }
    if (!filing) {
      ev.status = 'nodate';
      ev.note = 'ไม่พบวันที่รับฟ้องของคดีนี้ในรายงานคดีที่นำเข้า จึงเทียบระยะเวลากับวันออกหมายไม่ได้';
      return ev;
    }
    ev.status = statusFor(age, win);
    ev.nowStatus = ev.status;
    ev.note = 'จากวันที่รับฟ้อง ' + thaiDate(filing) + ' ถึงวันออกหมาย ' + thaiDate(issue) + ' = ' + ev.ageText +
      (ev.status === 'red' ? ' — เกิน 6 เดือน' : ev.status === 'green' ? ' — อยู่ในกรอบเฝ้าระวัง 5–6 เดือน' : ' — ยังไม่ถึง 5 เดือน');
    return ev;
  }

  /* ------------------------------------------------------------------
   * 6) รวมข้อมูลซ้ำ (เลขคดีดำเดียวกันจากหลายชีต/หลายไฟล์)
   * ------------------------------------------------------------------ */
  var MERGE_FIELDS = ['red', 'plaintiff', 'defendant', 'charge', 'nextApptRaw',
    'nextApptDate', 'nextApptTime', 'nextApptDetail', 'pendingReason', 'owner', 'judge', 'caseType', 'group', 'reportTitle'];
  function mergeRecords(list) {
    var byKey = {}, order = [], dup = 0, filingFilled = 0;
    list.forEach(function (rec) {
      var cur = byKey[rec.key];
      if (!cur) { byKey[rec.key] = JSON.parse(JSON.stringify(rec)); order.push(rec.key); return; }
      dup++;
      // วันที่รับฟ้อง: หากไฟล์ใดไฟล์หนึ่งมี ให้อ้างอิงใช้ได้ทันที (เก็บแหล่งที่มาไว้ด้วย)
      if (!cur.filingDate && rec.filingDate) {
        filingFilled++;
        cur.filingDate = rec.filingDate; cur.filingDateRaw = rec.filingDateRaw; cur.filingDateFrom = rec.filingDateFrom;
      } else if (!cur.filingDateRaw && rec.filingDateRaw) {
        cur.filingDateRaw = rec.filingDateRaw;
      } else if (cur.filingDate && rec.filingDate && cur.filingDate !== rec.filingDate) {
        cur.filingDateAlt = cur.filingDateAlt || [];
        if (!cur.filingDateAlt.some(function (a) { return a.date === rec.filingDate; })) cur.filingDateAlt.push({ date: rec.filingDate, from: rec.filingDateFrom });
      }
      MERGE_FIELDS.forEach(function (f) { if (!cur[f] && rec[f]) cur[f] = rec[f]; });
      cur.hasDefendantColumn = cur.hasDefendantColumn || rec.hasDefendantColumn;
      cur.hasNextApptColumn = cur.hasNextApptColumn || rec.hasNextApptColumn;
      cur.hasRedColumn = cur.hasRedColumn || rec.hasRedColumn;
      Object.keys(rec.extra).forEach(function (k) { if (!cur.extra[k]) cur.extra[k] = rec.extra[k]; });
      rec.sources.forEach(function (s) {
        if (!cur.sources.some(function (x) { return x.file === s.file && x.sheet === s.sheet; })) cur.sources.push(s);
      });
    });
    return { records: order.map(function (k) { return byKey[k]; }), duplicates: dup, filingFilled: filingFilled };
  }

  /* ------------------------------------------------------------------
   * 6.1) อ้างอิงข้ามไฟล์กับรายงานหมายระหว่างพิจารณา (จับคู่ด้วยเลขคดีดำ)
   *      แนบรายการหมาย + วันออกหมายแรก/ล่าสุดเข้ากับคดี เพื่อใช้ประกอบการนับระยะเวลา
   * ------------------------------------------------------------------ */
  function groupWrits(writs) {
    var by = {};
    (writs || []).forEach(function (w) { if (w.black) (by[w.black] = by[w.black] || []).push(w); });
    return by;
  }
  function attachWrits(rec, ws) {
    rec.writRefs = (ws || []).map(function (w) {
      return { issueDate: w.issueDate, issueDateRaw: w.issueDateRaw, writNo: w.writNo, refNo: w.refNo, name: w.name, penalty: w.penalty };
    });
    var ds = rec.writRefs.map(function (w) { return w.issueDate; }).filter(Boolean).sort();
    rec.writFirstIssue = ds[0] || '';
    rec.writLastIssue = ds[ds.length - 1] || '';
    return rec;
  }
  function linkWrits(records, writs) {
    var by = groupWrits(writs), keys = {}, linked = 0, filled = 0;
    records.forEach(function (r) {
      keys[r.key] = 1;
      attachWrits(r, by[r.key]);
      if (r.writRefs.length) { linked++; if (!r.filingDate && r.writFirstIssue) filled++; }
    });
    // หมายที่ไม่พบเลขคดีในรายงานคดี — สร้างข้อมูลคดีจากหมาย (ใช้วันออกหมายเป็นวันอ้างอิง)
    var writOnly = Object.keys(by).filter(function (k) { return !keys[k]; }).map(function (k) {
      var w = by[k][0], nums = extractCaseNumbers(k);
      return attachWrits({ key: k, black: k, prefix: w.prefix || (nums[0] && nums[0].prefix) || '', red: w.red || '',
        defendant: w.name || '', charge: w.charge || '', filingDate: '', filingDateRaw: '', nextApptDate: '', writOnly: true }, by[k]);
    });
    return { linkedCases: linked, filledFromWrit: filled, writOnly: writOnly };
  }

  /* ------------------------------------------------------------------
   * 7) จัดประเภทคดีตามอักษรย่อ (เงื่อนไขข้อ 1 และ 2)
   * ------------------------------------------------------------------ */
  function isInheritance(charge) {
    var c = squash(charge);
    return RULES.INHERITANCE_KEYWORDS.some(function (k) { return c.indexOf(squash(k)) >= 0; });
  }
  function classify(rec) {
    var p = rec.prefix;
    if (RULES.SPECIAL_PREFIXES.indexOf(p) >= 0) {
      return { category: 'special', window: '6M', basis: 'อักษรย่อ ' + p + ' เป็นคดีจัดการพิเศษ' };
    }
    if (RULES.DEFENDANT_SPLIT_PREFIXES.indexOf(p) >= 0) {
      return rec.defendant
        ? { category: 'general', window: '12M', basis: 'อักษรย่อ ' + p + ' มีข้อมูลจำเลย' }
        : { category: 'special', window: '6M', basis: 'อักษรย่อ ' + p + ' และไม่มีข้อมูลจำเลย' };
    }
    if (RULES.CONDITIONAL_PREFIXES.indexOf(p) >= 0) {
      if (!rec.defendant) return { category: 'special', window: '6M', basis: 'อักษรย่อ ' + p + ' และไม่มีข้อมูลจำเลย' };
      if (isInheritance(rec.charge)) return { category: 'special', window: '6M', basis: 'อักษรย่อ ' + p + ' มีจำเลย และข้อหาเป็นการจัดการมรดก' };
      return { category: 'general', window: '12M', basis: 'อักษรย่อ ' + p + ' มีจำเลย และข้อหาไม่ใช่การจัดการมรดก' };
    }
    if (RULES.GENERAL_PREFIXES.indexOf(p) >= 0) {
      return { category: 'general', window: '12M', basis: 'อักษรย่อ ' + p + ' เป็นคดีจัดการทั่วไป' };
    }
    return { category: 'other', window: RULES.OTHER_WINDOW, basis: 'อักษรย่อ ' + p + ' ไม่อยู่ในรายการอักษรย่อที่กำหนด — ตรวจกรอบ 11 เดือน แต่ไม่เกิน 1 ปี (พิจารณาวันนัดต่อไปประกอบ)' };
  }

  /* ------------------------------------------------------------------
   * 8) ประเมินสถานะ ณ วันที่กำหนด (เรียกซ้ำได้ทุกครั้งที่เปิดหน้า)
   * ------------------------------------------------------------------ */
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  /** วันเริ่มเฝ้าระวัง / วันครบกำหนด (เกิน) และจำนวนวันที่เหลือ นับจากวันอ้างอิง ณ วันที่เปิดดู */
  function deadlineInfo(ref, win, today) {
    if (!ref || !win) return { warnDate: '', limitDate: '', soonDate: '', daysToLimit: null };
    var lim = addMonths(ref, win.limit);
    // soonDate = 1 เดือนก่อนวันครบกำหนด (ใช้แจ้งเตือน "เหลือไม่เกิน 1 เดือน" — กรอบเฝ้าระวังบางเกณฑ์ยาวกว่า 1 เดือน)
    return { warnDate: toISO(addMonths(ref, win.warn)), limitDate: toISO(lim), soonDate: toISO(addMonths(ref, win.limit - 1)),
      daysToLimit: daysBetween(today, lim) };
  }
  function statusFor(age, win) {
    if (!age || !win) return 'normal';
    if (age.months >= win.limit) return 'red';
    if (age.months >= win.warn) return 'green';
    return 'normal';
  }
  /** override = { window: '6M' | '12M' | '18M' } — เกณฑ์ที่เจ้าหน้าที่ปรับเองรายคดี (มีผลเหนือเกณฑ์อัตโนมัติ) */
  function evaluate(rec, today, override) {
    today = today || todayUTC();
    var cls = classify(rec);   // จัดประเภทใหม่ทุกครั้ง เพื่อให้ใช้เกณฑ์ล่าสุดเสมอ
    var autoWindow = cls.window;
    if (override && RULES.WINDOW[override.window] && override.window !== cls.window) {
      cls = { category: cls.category, window: override.window,
        basis: cls.basis + ' — เจ้าหน้าที่ปรับเกณฑ์เป็น "' + RULES.WINDOW[override.window].label + '"' };
    }
    var win = cls.window ? RULES.WINDOW[cls.window] : null;
    var filing = fromISO(rec.filingDate), refSource = filing ? 'filing' : '';
    if (!filing && rec.writFirstIssue) { filing = fromISO(rec.writFirstIssue); refSource = filing ? 'writ' : ''; }
    var appt = fromISO(rec.nextApptDate);
    var ageNow = filing ? diffMonths(filing, today) : null;
    var ageAppt = (filing && appt) ? diffMonths(filing, appt) : null;
    var dl = deadlineInfo(filing, win, today);
    var ev = {
      category: cls.category, window: cls.window, basis: cls.basis,
      autoWindow: autoWindow, overridden: !!(cls.window && cls.window !== autoWindow),
      windowLabel: win ? win.label : '-',
      ageMonths: ageNow ? ageNow.months : null,
      ageDays: ageNow ? ageNow.totalDays : null,
      ageText: formatAge(ageNow),
      apptAgeText: ageAppt ? formatAge(ageAppt) : '',
      apptStatus: '',
      refDate: toISO(filing), refSource: refSource,
      writNote: '',
      status: 'normal', note: '', nowStatus: '',
      // ณ วันที่เปิดดู: วันครบกำหนด / จำนวนวันที่เหลือก่อนเกินกำหนด / จำนวนวันถึงวันนัดต่อไป
      warnDate: dl.warnDate, limitDate: dl.limitDate, soonDate: dl.soonDate, daysToLimit: dl.daysToLimit,
      daysToAppt: appt ? daysBetween(today, appt) : null
    };
    var wr = rec.writRefs || [];
    if (wr.length) {
      ev.writNote = 'อ้างอิงรายงานหมายระหว่างพิจารณา ' + wr.length + ' ฉบับ' +
        (rec.writFirstIssue ? ' (ออกหมาย' + (rec.writLastIssue && rec.writLastIssue !== rec.writFirstIssue
          ? 'ครั้งแรก ' + thaiDate(rec.writFirstIssue) + ' ล่าสุด ' + thaiDate(rec.writLastIssue)
          : ' ' + thaiDate(rec.writFirstIssue)) + ')' : '');
    }
    function withWrit(t) { return ev.writNote ? t + ' · ' + ev.writNote : t; }
    if (rec.red) {
      ev.status = 'done';
      ev.note = withWrit('มีเลขคดีแดง ' + rec.red + ' ถือว่าคดีเสร็จสิ้น' + (rec.nextApptDate ? ' (ยังพบวันนัดต่อไป ' + thaiDate(rec.nextApptDate) + ')' : ''));
      return ev;
    }
    if (!filing) { ev.status = 'nodate'; ev.note = withWrit('ไม่พบวันที่รับฟ้องและวันออกหมายจากไฟล์ใด จึงไม่สามารถนับระยะเวลาได้'); return ev; }

    var sNow = statusFor(ageNow, win);
    var refLabel = refSource === 'writ' ? 'วันออกหมายครั้งแรก (ไม่พบวันที่รับฟ้องในไฟล์ใด) ' : 'วันที่รับฟ้อง';
    ev.status = sNow;
    ev.nowStatus = sNow;
    ev.note = 'นับจาก' + refLabel + 'ถึงวันนี้ ' + ev.ageText;
    // เงื่อนไขเพิ่มเติม (คดีจัดการทั่วไป และอักษรย่ออื่น): พิจารณาช่วงวันที่รับฟ้อง => วันนัดต่อไป
    if ((cls.category === 'general' || cls.category === 'other') && ageAppt && appt > today) {
      var sAppt = statusFor(ageAppt, win);
      ev.apptStatus = sAppt;
      if (STATUS[sAppt].rank > STATUS[sNow].rank) {
        ev.status = sAppt;
        ev.note = 'ณ วันนัดต่อไป (' + thaiDate(appt) + ') คดีจะมีอายุ ' + ev.apptAgeText + ' — ' +
          (sAppt === 'red' ? 'เกินกรอบระยะเวลา' : 'เข้าสู่กรอบเฝ้าระวัง');
      }
    }
    ev.note = withWrit(ev.note);
    return ev;
  }
  function todayUTC() {
    var n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  }

  return {
    RULES: RULES, STATUS: STATUS,
    parseDate: parseDate, parseAppointment: parseAppointment, diffMonths: diffMonths,
    toISO: toISO, fromISO: fromISO, thaiDate: thaiDate, formatAge: formatAge, todayUTC: todayUTC,
    extractCaseNumbers: extractCaseNumbers, findHeaderRow: findHeaderRow, mapColumns: mapColumns,
    parseSheet: parseSheet, mergeRecords: mergeRecords, linkWrits: linkWrits,
    isWritSheet: isWritSheet, parseWritSheet: parseWritSheet, writKey: writKey, evaluateWrit: evaluateWrit, classify: classify, evaluate: evaluate,
    isInheritance: isInheritance
  };
});
