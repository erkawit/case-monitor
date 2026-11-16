/*!
 * app.js — ส่วนติดต่อผู้ใช้ Dashboard Monitoring คดี
 */
(function () {
  'use strict';
  var P = window.CaseProcessor;
  var API = '/api';
  var MAX_SAVE_CHARS = 4300000;   // ขีดจำกัด request body ของ Vercel Functions (4.5 MB)

  /* ================================================================
   * ติดต่อ API (Vercel Functions)
   * ================================================================ */
  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'X-CM-Request': '1' }, opts.headers || {});
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body, credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, message: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP ' + r.status + ')' }; })
          .then(function (res) {
            if (r.status === 401 && path.indexOf('/auth') !== 0) { onSessionExpired(); }
            if (!r.ok || !res.ok) { var e = new Error(res.message || ('HTTP ' + r.status)); e.status = r.status; throw e; }
            return res;
          });
      });
  }
  function postJSON(path, body) { return apiFetch(path, { method: 'POST', json: body }); }
  function storeSet(name, key, value) { return postJSON('/store', { name: name, key: key, value: value }); }

  /* ---------- บีบอัด / คลายข้อมูล (gzip + base64) ---------- */
  function bytesToB64(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function gzipJSON(obj) {
    if (typeof CompressionStream === 'undefined') return Promise.reject(new Error('เบราว์เซอร์นี้ไม่รองรับการบีบอัดข้อมูล กรุณาใช้ Chrome / Edge / Firefox รุ่นปัจจุบัน'));
    var stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) { return bytesToB64(new Uint8Array(buf)); });
  }
  function gunzipJSON(b64) {
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('เบราว์เซอร์นี้ไม่รองรับการคลายข้อมูล กรุณาใช้ Chrome / Edge / Firefox รุ่นปัจจุบัน'));
    var stream = new Blob([b64ToBytes(b64)]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text().then(function (t) { return JSON.parse(t); });
  }

  var state = {
    data: null,          // ข้อมูลจากไฟล์ data (monitor_data.json)
    rows: [],            // records + ผลประเมิน ณ วันนี้
    byKey: {},
    today: P.todayUTC(),
    view: 'dashboard',
    processing: false,
    table: null,
    sheetTable: null,
    writTable: null,
    npTable: null,       // ตารางหมายที่ "กำหนดโทษ" ว่างเปล่า (แสดงด้านบน)
    writs: [],           // รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา
    writFlags: {},       // การบันทึกของเจ้าหน้าที่: ออกหมายปล่อยชั่วคราว (key = uid ของหมาย)
    caseRules: {},       // การปรับเกณฑ์เฝ้าระวังรายคดี (key = เลขคดีดำ)
    writExclude: {},     // หมายที่นำออกจากเกณฑ์เฝ้าระวัง (key = uid ของหมาย)
    exTable: null,
    showAll: false,      // false = แสดงเฉพาะรายการเฝ้าระวัง (ค่าเริ่มต้น)
    cardFilter: ''
  };

  /* ================================================================
   * Utilities
   * ================================================================ */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function fmtDateTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var m = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    var pad = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getDate() + ' ' + m[d.getMonth()] + ' ' + (d.getFullYear() + 543) + ' เวลา ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' น.';
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function tick() { return new Promise(function (r) { requestAnimationFrame(function () { setTimeout(r, 0); }); }); }

  /** SweetAlert มาตรฐานของระบบ: ปิดได้เฉพาะปุ่มปิด หรือกากบาทเท่านั้น */
  function swal(opts) {
    return Swal.fire(Object.assign({
      allowOutsideClick: false,
      allowEscapeKey: false,
      allowEnterKey: false,
      showCloseButton: true,
      timer: undefined,
      confirmButtonText: 'ปิด',
      confirmButtonColor: '#223b63',
      cancelButtonColor: '#64748b',
      closeButtonHtml: '&times;'
    }, opts));
  }

  var STATUS_LABEL = {
    red: 'เกินกำหนด', green: 'เฝ้าระวัง', normal: 'ปกติ', done: 'เสร็จสิ้น',
    out: 'นอกเกณฑ์', nodate: 'ไม่มีวันที่รับฟ้อง', bail: 'ปล่อยชั่วคราวแล้ว', noissue: 'ไม่มีวันออกหมาย', excluded: 'ไม่อยู่ในเกณฑ์เฝ้าระวัง'
  };
  var CAT_LABEL = { special: 'คดีจัดการพิเศษ', general: 'คดีจัดการทั่วไป', other: 'อักษรย่ออื่น' };
  function pill(status) { return '<span class="pill pill-' + status + '">' + esc(STATUS_LABEL[status] || status) + '</span>'; }
  function catPill(cat) { return '<span class="pill pill-cat-' + cat + '">' + esc(CAT_LABEL[cat] || cat) + '</span>'; }

  /* ================================================================
   * โหลด / เตรียมข้อมูล
   * ================================================================ */
  function buildRows() {
    state.today = P.todayUTC();
    state.byKey = {};
    // เชื่อมโยงข้อมูลหมายระหว่างพิจารณากับคดี (เลขคดีดำตรงกัน) ทุกครั้งที่โหลด
    P.linkWrits(state.data.records || [], (state.data.writs && state.data.writs.records) || []);
    state.rows = (state.data.records || []).map(function (rec, i) {
      var ev = P.evaluate(rec, state.today, state.caseRules[rec.key]);
      var row = Object.assign({}, rec, { ev: ev, idx: i });
      state.byKey[rec.key] = row;
      return row;
    });
    state.writs = ((state.data.writs && state.data.writs.records) || []).map(function (w, i) {
      return Object.assign({ idx: i }, w, { uid: w.uid || P.writKey(w) });
    });
    evalWrits();
  }

  function loadStore(name, prop) {
    return apiFetch('/store?name=' + encodeURIComponent(name))
      .then(function (res) { state[prop] = res.items || {}; });
  }
  /** การบันทึกทั้งหมดของเจ้าหน้าที่ (คงอยู่ข้ามการนำเข้าไฟล์ใหม่) */
  function loadStaffData() {
    return Promise.all([loadStore('writ_flags', 'writFlags'), loadStore('case_rules', 'caseRules'), loadStore('writ_exclude', 'writExclude')]);
  }

  function loadData() {
    showOnly('viewLoading');
    return Promise.all([
      apiFetch('/data').then(function (res) { return res.exists ? gunzipJSON(res.data) : null; }),
      loadStaffData()
    ])
      .then(function (all) {
        state.data = all[0];
        if (state.data) buildRows();
        render();
        maybeShowAlerts(false);
      })
      .catch(function (err) {
        if (err.status === 401) return;          // แสดงหน้าเข้าสู่ระบบแล้ว
        $('viewLoading').classList.add('hidden');
        swal({ icon: 'error', title: 'โหลดข้อมูลไม่สำเร็จ', text: err.message });
      });
  }

  /* ================================================================
   * เข้าสู่ระบบ / ตรวจการตั้งค่า
   * ================================================================ */
  var ALL_VIEWS = ['viewLoading', 'viewLogin', 'viewConfig', 'viewEmpty', 'viewMonitor', 'viewFiles', 'viewRules', 'viewWrits'];
  function showOnly(id) {
    ALL_VIEWS.forEach(function (v) { var el = $(v); if (el) el.classList.toggle('hidden', v !== id); });
  }
  function setAuthedUI(on) {
    state.authed = on;
    $('btnLogout').classList.toggle('hidden', !on);
    ['btnImport', 'btnBell', 'mainNav', 'btnMenu'].forEach(function (id) { var el = $(id); if (el) el.classList.toggle('invisible', !on); });
    if (!on) { $('infoBar').classList.add('hidden'); }
  }
  function showLogin(msg) {
    setAuthedUI(false);
    showOnly('viewLogin');
    var e = $('loginError');
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
    setTimeout(function () { var p = $('loginPassword'); if (p) p.focus(); }, 50);
  }
  function onSessionExpired() {
    if (!state.authed) return;
    state.data = null;
    showLogin('หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบอีกครั้ง');
    if (window.Swal && Swal.isVisible() && !state.processing) Swal.close();
  }
  function boot() {
    showOnly('viewLoading');
    apiFetch('/auth').then(function (res) {
      var miss = [];
      if (!res.configured.password) miss.push('ยังไม่ได้กำหนดรหัสผ่าน <code>APP_PASSWORD</code>');
      if (!res.configured.storage) miss.push('ยังไม่ได้เชื่อมต่อฐานข้อมูล Upstash Redis (<code>KV_REST_API_URL</code> / <code>KV_REST_API_TOKEN</code>)');
      if (miss.length) {
        setAuthedUI(false);
        $('configMsg').innerHTML = miss.map(function (m) { return '<p>• ' + m + '</p>'; }).join('');
        showOnly('viewConfig');
        return;
      }
      if (!res.authenticated) { showLogin(''); return; }
      setAuthedUI(true);
      loadData();
    }).catch(function (err) {
      showOnly('viewConfig');
      $('configMsg').textContent = 'ติดต่อเซิร์ฟเวอร์ไม่ได้: ' + err.message;
    });
  }

  /* ================================================================
   * Routing + Render
   * ================================================================ */
  var VIEWS = {
    dashboard: { title: 'ภาพรวมการติดตามคดี', desc: 'คดีทั้งหมดจากไฟล์ที่นำเข้า พร้อมสถานะตามเกณฑ์ระยะเวลา', category: '', status: '' },
    special:   { title: 'คดีจัดการพิเศษ', desc: 'กรอบระยะเวลา 5 เดือน แต่ไม่เกิน 6 เดือน', category: 'special', status: '' },
    general:   { title: 'คดีจัดการทั่วไป', desc: 'กรอบระยะเวลา 11 เดือน แต่ไม่เกิน 1 ปี (พิจารณาวันนัดต่อไปประกอบ)', category: 'general', status: '' }
  };

  function currentView() {
    var h = (location.hash || '#dashboard').slice(1);
    return ['dashboard', 'special', 'general', 'writs', 'files', 'rules'].indexOf(h) >= 0 ? h : 'dashboard';
  }

  function render() {
    state.view = currentView();
    document.querySelectorAll('[data-nav]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === state.view);
    });
    $('mobileNav').classList.add('hidden');
    ['viewLoading', 'viewLogin', 'viewConfig', 'viewEmpty', 'viewMonitor', 'viewWrits', 'viewFiles', 'viewRules'].forEach(function (id) { $(id).classList.add('hidden'); });

    if (state.view === 'rules') { $('viewRules').classList.remove('hidden'); renderInfoBar(); return; }
    if (!state.data) { $('viewEmpty').classList.remove('hidden'); $('infoBar').classList.add('hidden'); return; }

    renderInfoBar();
    if (state.view === 'files') { $('viewFiles').classList.remove('hidden'); renderFiles(); return; }
    if (state.view === 'writs') { $('viewWrits').classList.remove('hidden'); renderWrits(); return; }

    var v = VIEWS[state.view];
    $('monitorTitle').textContent = v.title;
    $('monitorDesc').textContent = v.desc;
    $('fCategory').value = v.category;
    $('fStatus').value = v.status;
    $('fPrefix').value = '';
    $('fGroup').value = '';
    state.cardFilter = '';
    state.showAll = false;               // ค่าเริ่มต้น: แสดงเฉพาะรายการเฝ้าระวัง
    $('viewMonitor').classList.remove('hidden');
    fillFilterOptions();
    applyModeUI();
    renderMonitor();
    if (state.table) state.table.columns.adjust();
  }

  function renderInfoBar() {
    if (!state.data) { $('infoBar').classList.add('hidden'); return; }
    updateBell();
    var m = state.data.meta || {};
    $('infoBar').classList.remove('hidden');
    $('infoProcessed').textContent = fmtDateTime(m.processedAt);
    $('infoToday').textContent = P.thaiDate(state.today);
    $('infoFiles').textContent = (m.files || []).length + ' ไฟล์';
    $('infoCases').textContent = state.rows.length.toLocaleString('th-TH') + ' คดี' +
      (state.writs.length ? ' · หมายระหว่างพิจารณา ' + state.writs.length.toLocaleString('th-TH') + ' ฉบับ' : '');
  }

  function fillFilterOptions() {
    var prefixes = {}, groups = {};
    state.rows.forEach(function (r) { prefixes[r.prefix] = 1; if (r.group) groups[r.group] = 1; });
    var fp = $('fPrefix'), fg = $('fGroup');
    fp.innerHTML = '<option value="">ทั้งหมด</option>' + Object.keys(prefixes).sort().map(function (p) {
      return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
    }).join('');
    fg.innerHTML = '<option value="">ทั้งหมด</option>' + Object.keys(groups).sort().map(function (g) {
      return '<option value="' + esc(g) + '">' + esc(g) + '</option>';
    }).join('');
  }

  function isWatch(r) { return r.ev.status === 'red' || r.ev.status === 'green'; }

  /** ตัวกรองพื้นฐาน (ประเภท / อักษรย่อ / กลุ่มคดี) ไม่รวมสถานะ */
  function baseRows() {
    var cat = $('fCategory').value, px = $('fPrefix').value, gp = $('fGroup').value;
    return state.rows.filter(function (r) {
      if (cat && r.ev.category !== cat) return false;
      if (px && r.prefix !== px) return false;
      if (gp && r.group !== gp) return false;
      return true;
    });
  }

  function applyModeUI() {
    $('modeWatch').classList.toggle('active', !state.showAll);
    $('modeAll').classList.toggle('active', state.showAll);
    var fs = $('fStatus');
    if (!state.showAll) {
      if (fs.value !== 'red' && fs.value !== 'green') fs.value = 'watch';
      Array.prototype.forEach.call(fs.options, function (o) { o.hidden = ['watch', 'red', 'green'].indexOf(o.value) < 0; });
    } else {
      Array.prototype.forEach.call(fs.options, function (o) { o.hidden = false; });
    }
    $('modeHint').textContent = state.showAll
      ? 'กำลังแสดงทุกรายการตามตัวกรอง'
      : 'ค่าเริ่มต้น: แสดงเฉพาะคดีที่ไฮไลต์สีเขียว (เฝ้าระวัง) และสีแดง (เกินกำหนด) — รายการอื่นกด "แสดงผลทั้งหมด"';
  }
  function setMode(showAll) {
    state.showAll = showAll;
    $('fStatus').value = showAll ? '' : 'watch';
    state.cardFilter = '';
    applyModeUI();
    renderMonitor();
  }

  function filteredRows() {
    var cat = $('fCategory').value, st = $('fStatus').value, px = $('fPrefix').value, gp = $('fGroup').value;
    return state.rows.filter(function (r) {
      if (!state.showAll && !isWatch(r)) return false;
      if (cat && r.ev.category !== cat) return false;
      if (st === 'watch' && r.ev.status !== 'red' && r.ev.status !== 'green') return false;
      if (st === 'na' && r.ev.status !== 'out' && r.ev.status !== 'nodate') return false;
      if (st && st !== 'watch' && st !== 'na' && r.ev.status !== st) return false;
      if (px && r.prefix !== px) return false;
      if (gp && r.group !== gp) return false;
      return true;
    });
  }

  function renderCards() {
    var base = state.rows.filter(function (r) {
      var cat = $('fCategory').value;
      return !cat || r.ev.category === cat;
    });
    var c = { all: base.length, special: 0, general: 0, green: 0, red: 0, done: 0, other: 0 };
    base.forEach(function (r) {
      if (r.ev.category === 'special') c.special++;
      if (r.ev.category === 'general') c.general++;
      if (r.ev.status === 'green') c.green++;
      if (r.ev.status === 'red') c.red++;
      if (r.ev.status === 'done') c.done++;
      if (r.ev.category === 'other') c.other++;
    });
    var cards = [
      ['', 'คดีทั้งหมด', c.all, '#223b63'],
      ['cat:special', 'คดีจัดการพิเศษ', c.special, '#4f46e5'],
      ['cat:general', 'คดีจัดการทั่วไป', c.general, '#0369a1'],
      ['st:green', 'เฝ้าระวัง', c.green, '#3fa66b'],
      ['st:red', 'เกินกำหนด', c.red, '#d64545'],
      ['st:done', 'เสร็จสิ้น (มีเลขแดง)', c.done, '#8aa1c8'],
      ['cat:other', 'อักษรย่ออื่น (11–12 เดือน)', c.other, '#c48a00']
    ];
    $('summaryCards').innerHTML = cards.map(function (k) {
      return '<button type="button" class="lockable stat-card' + (state.cardFilter === k[0] && k[0] ? ' selected' : '') +
        '" data-card="' + k[0] + '" style="border-top-color:' + k[3] + '">' +
        '<div class="lbl">' + esc(k[1]) + '</div><div class="num" style="color:' + k[3] + '">' +
        k[2].toLocaleString('th-TH') + '</div></button>';
    }).join('');
  }

  var DT_LANG = {
    emptyTable: 'ไม่พบข้อมูล', info: 'แสดง _START_ ถึง _END_ จาก _TOTAL_ รายการ', infoEmpty: 'แสดง 0 รายการ',
    infoFiltered: '(กรองจาก _MAX_ รายการ)', lengthMenu: 'แสดง _MENU_ รายการ', search: 'ค้นหา:',
    zeroRecords: 'ไม่พบรายการที่ค้นหา', paginate: { first: '«', last: '»', next: '›', previous: '‹' }
  };

  function renderMonitor() {
    renderCards();
    var b = baseRows();
    $('cntWatch').textContent = b.filter(isWatch).length.toLocaleString('th-TH');
    $('cntAll').textContent = b.length.toLocaleString('th-TH');
    var rows = filteredRows();
    if (state.table) { state.table.clear().rows.add(rows).draw(); return; }

    var dt = new DataTable('#tblMonitor', {
      data: rows,
      language: DT_LANG,
      scrollX: true,
      pageLength: 25,
      lengthMenu: [10, 25, 50, 100, 500],
      order: [[2, 'desc'], [7, 'desc']],
      autoWidth: false,
      columns: [
        { title: 'ปรับเกณฑ์', data: null, orderable: false, searchable: false, className: 'text-center',
          render: function (d, t, r) {
            return '<button type="button" class="btn-rule lockable' + (r.ev.overridden ? ' changed' : '') + '" data-rule="' + r.idx + '" title="ปรับเกณฑ์การเฝ้าระวังของคดีนี้">' +
              '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>' +
              'ปรับเกณฑ์</button>' + (r.ev.overridden ? '<div class="text-[11px] text-amber-700 mt-0.5 whitespace-nowrap">ปรับแล้ว</div>' : '');
          } },
        { title: 'ลำดับ', data: null, orderable: false, searchable: false, className: 'text-center',
          render: function (d, t, r, meta) { return meta.row + 1; } },
        { title: 'สถานะ', data: 'ev.status',
          render: function (d, t) { return t === 'sort' || t === 'type' ? P.STATUS[d].rank : pill(d); } },
        { title: 'เลขคดีดำ', data: 'black', render: function (d) { return '<b class="whitespace-nowrap">' + esc(d) + '</b>'; } },
        { title: 'เลขคดีแดง', data: 'red', render: function (d) { return d ? '<span class="whitespace-nowrap text-red-700">' + esc(d) + '</span>' : '-'; } },
        { title: 'ประเภทการจัดการ', data: 'ev.category', render: function (d, t) { return t === 'display' ? catPill(d) : CAT_LABEL[d]; } },
        { title: 'วันที่รับฟ้อง', data: 'ev.refDate',
          render: function (d, t, r) {
            if (t === 'sort' || t === 'type') return d || '';
            if (!d) return esc(r.filingDateRaw || '-');
            var html = '<span class="whitespace-nowrap">' + esc(P.thaiDate(d)) + '</span>';
            if (r.ev.refSource === 'writ') html += '<br><span class="text-xs text-amber-700">(วันออกหมายครั้งแรก)</span>';
            else if (r.sources && r.sources.length > 1 && r.filingDateFrom) html += '<br><span class="text-xs text-slate-500" title="' + esc(r.filingDateFrom) + '">อ้างอิงข้ามไฟล์</span>';
            return html;
          } },
        { title: 'ระยะเวลา ณ วันนี้', data: 'ev.ageDays',
          render: function (d, t, r) { if (t === 'sort' || t === 'type') return d == null ? -1 : d; return d == null ? '-' : '<span class="whitespace-nowrap">' + esc(r.ev.ageText) + '</span>'; } },
        { title: 'เหลือเวลาก่อนเกินกำหนด (ณ วันนี้)', data: 'ev.daysToLimit',
          render: function (d, t, r) {
            var na = d == null || r.ev.status === 'done';
            if (t === 'sort' || t === 'type') return na ? 1e9 : d;
            if (na) return '-';
            var cls = d <= 0 ? 'text-red-700' : (r.ev.nowStatus === 'green' ? 'text-amber-700' : 'text-slate-700');
            return '<span class="whitespace-nowrap font-semibold ' + cls + '">' + esc(remainText(d)) + '</span>' +
              '<br><span class="text-xs text-slate-500 whitespace-nowrap">ครบกำหนด ' + esc(P.thaiDate(r.ev.limitDate)) + '</span>';
          } },
        { title: 'เกณฑ์', data: 'ev.window',
          render: function (d, t, r) { return '<span class="whitespace-nowrap">' + esc(WINDOW_SHORT[d] || '-') + '</span>' + (r.ev.overridden ? '<br><span class="text-[11px] text-amber-700 whitespace-nowrap">ปรับโดยเจ้าหน้าที่</span>' : ''); } },
        { title: 'วันนัดต่อไป', data: 'nextApptDate',
          render: function (d, t, r) {
            if (t === 'sort' || t === 'type') return d || '';
            if (!r.nextApptRaw) return '-';
            if (!d) return '<span class="clip-sm">' + esc(r.nextApptRaw) + '</span>';
            return '<span class="clip-sm"><b class="whitespace-nowrap">' + esc(P.thaiDate(d)) + '</b>' + (r.nextApptTime ? ' ' + esc(r.nextApptTime) : '') +
              (r.nextApptDetail ? '<br><span class="text-slate-500">' + esc(r.nextApptDetail) + '</span>' : '') + '</span>';
          } },
        { title: 'ระยะเวลา ณ วันนัด', data: 'ev.daysToAppt',
          render: function (d, t, r) {
            if (t === 'sort' || t === 'type') return d == null ? 1e9 : d;
            if (!r.ev.apptAgeText) return '-';
            var html = '<span class="whitespace-nowrap">' + esc(r.ev.apptAgeText) + '</span>' + (r.ev.apptStatus ? '<br>' + pill(r.ev.apptStatus) : '');
            // ณ วันที่เปิดดู: อีกกี่วันถึงวันนัด และวันนัดอยู่ก่อน/หลังวันครบกำหนด
            if (d != null) html += '<br><span class="text-xs whitespace-nowrap ' + (d < 0 ? 'text-slate-400' : 'text-gov-700 font-semibold') + '">' +
              (d > 0 ? 'อีก ' + d + ' วันถึงวันนัด' : d === 0 ? 'นัดวันนี้' : 'วันนัดผ่านมาแล้ว ' + (-d) + ' วัน') + '</span>';
            if (r.ev.limitDate && r.nextApptDate && r.ev.status !== 'done' && d != null && d >= 0) {
              var gap = Math.round((P.fromISO(r.nextApptDate) - P.fromISO(r.ev.limitDate)) / 86400000);
              html += '<br><span class="text-xs whitespace-nowrap ' + (gap >= 0 ? 'text-red-700' : 'text-slate-500') + '">' +
                (gap >= 0 ? 'นัดหลังวันครบกำหนด ' + gap + ' วัน' : 'นัดก่อนวันครบกำหนด ' + (-gap) + ' วัน') + '</span>';
            }
            return html;
          } },
        { title: 'โจทก์ / ผู้ร้อง', data: 'plaintiff', render: function (d) { return '<span class="clip">' + esc(d || '-') + '</span>'; } },
        { title: 'จำเลย', data: 'defendant', render: function (d) { return '<span class="clip">' + esc(d || '-') + '</span>'; } },
        { title: 'ข้อหา', data: 'charge', render: function (d) { return '<span class="clip">' + esc(d || '-') + '</span>'; } },
        { title: 'เหตุที่ค้าง', data: 'pendingReason', render: function (d) { return '<span class="clip-sm">' + esc(d || '-') + '</span>'; } },
        { title: 'เจ้าของสำนวน / ผู้พิพากษา', data: null,
          render: function (d, t, r) { return '<span class="clip-sm">' + esc(r.owner || r.judge || '-') + '</span>'; } },
        { title: 'หมายระหว่างพิจารณา', data: 'writFirstIssue',
          render: function (d, t, r) {
            var n = (r.writRefs || []).length;
            if (t === 'sort' || t === 'type') return n ? (d || '0') : '';
            if (!n) return '-';
            return '<span class="clip-sm"><b>' + n + ' ฉบับ</b>' + (d ? '<br>ออกหมาย ' + esc(P.thaiDate(d)) + (r.writLastIssue && r.writLastIssue !== d ? ' – ' + esc(P.thaiDate(r.writLastIssue)) : '') : '') + '</span>';
          } },
        { title: 'กลุ่มคดี', data: 'group', render: function (d) { return '<span class="clip-sm">' + esc(d || '-') + '</span>'; } },
        { title: 'ผลการประเมิน', data: 'ev.note', render: function (d) { return '<span class="clip">' + esc(d) + '</span>'; } },
        { title: '', data: null, orderable: false, searchable: false,
          render: function (d, t, r) { return '<button type="button" class="btn-detail lockable" data-detail="' + r.idx + '">รายละเอียด</button>'; } }
      ],
      createdRow: function (tr, r) {
        if (r.ev.status === 'red') tr.classList.add('row-red');
        else if (r.ev.status === 'green') tr.classList.add('row-green');
        else if (r.ev.status === 'done') tr.classList.add('row-done');
      }
    });
    state.table = dt;
    dt.on('draw', function () {
      // เลขลำดับให้เรียงตามการแสดงผลปัจจุบัน (ใช้ instance ของตัวเอง ไม่อ้างอิง state.table ที่อาจถูกเปลี่ยน)
      var info = dt.page.info();
      dt.column(1, { search: 'applied', order: 'applied', page: 'current' }).nodes().each(function (cell, i) {
        cell.textContent = info.start + i + 1;
      });
    });
    dt.draw();
  }

  /* ---------- รายละเอียดคดี ---------- */
  function showDetail(idx) {
    var r = state.rows[idx];
    if (!r) return;
    var rows = [
      ['สถานะ', pill(r.ev.status), true],
      ['ผลการประเมิน', r.ev.note],
      ['เลขคดีดำ', r.black], ['เลขคดีแดง', r.red || '-'],
      ['อักษรย่อคดี', r.prefix],
      ['ประเภทการจัดการคดี', catPill(r.ev.category), true],
      ['เหตุผลการจัดประเภท', r.ev.basis],
      ['เกณฑ์ระยะเวลา', r.ev.windowLabel + (r.ev.overridden ? ' (ปรับโดยเจ้าหน้าที่)' : '')],
      ['เกณฑ์อัตโนมัติตามอักษรย่อ', r.ev.autoWindow ? P.RULES.WINDOW[r.ev.autoWindow].label : '-'],
      ['การปรับเกณฑ์โดยเจ้าหน้าที่', state.caseRules[r.key] ? 'ปรับเมื่อ ' + fmtDateTime(state.caseRules[r.key].at) : 'ไม่มี'],
      ['วันที่รับฟ้อง', r.filingDate ? P.thaiDate(r.filingDate) + ' (ต้นฉบับ: ' + r.filingDateRaw + ')' : (r.filingDateRaw || 'ไม่พบในไฟล์ใด')],
      ['แหล่งอ้างอิงวันที่รับฟ้อง', r.filingDateFrom || '-'],
      ['วันที่รับฟ้องที่ต่างกันในไฟล์อื่น', (r.filingDateAlt || []).map(function (a) { return P.thaiDate(a.date) + ' (' + a.from + ')'; }).join('\n') || '-'],
      ['วันที่ใช้นับระยะเวลา', r.ev.refDate ? P.thaiDate(r.ev.refDate) + (r.ev.refSource === 'writ' ? ' — วันออกหมายครั้งแรก (ไม่พบวันที่รับฟ้อง)' : ' — วันที่รับฟ้อง') : '-'],
      ['หมายระหว่างพิจารณา', (r.writRefs || []).map(function (w) {
        return (w.issueDate ? P.thaiDate(w.issueDate) : w.issueDateRaw) + ' · หมายเลขที่ ' + (w.writNo || '-') + (w.name ? ' · ' + w.name : '') + (w.penalty && w.penalty !== '-' ? ' · ' + w.penalty : '');
      }).join('\n') || 'ไม่พบ'],
      ['ระยะเวลา ณ วันนี้', r.ev.ageText || '-'],
      ['วันนัดต่อไป', r.nextApptRaw || '-'],
      ['ระยะเวลา ณ วันนัดต่อไป', r.ev.apptAgeText || '-'],
      ['จำนวนวันถึงวันนัดต่อไป (ณ วันนี้)', r.ev.daysToAppt == null ? '-' : (r.ev.daysToAppt > 0 ? 'อีก ' + r.ev.daysToAppt + ' วัน' : r.ev.daysToAppt === 0 ? 'นัดวันนี้' : 'ผ่านมาแล้ว ' + (-r.ev.daysToAppt) + ' วัน')],
      ['วันเริ่มเฝ้าระวัง / วันครบกำหนด', r.ev.limitDate ? P.thaiDate(r.ev.warnDate) + ' / ' + P.thaiDate(r.ev.limitDate) : '-'],
      ['เหลือเวลาก่อนเกินกำหนด (ณ วันนี้)', r.ev.status === 'done' ? '-' : remainText(r.ev.daysToLimit)],
      ['โจทก์ / ผู้ร้อง', r.plaintiff || '-'], ['จำเลย', r.defendant || '-'], ['ข้อหา', r.charge || '-'],
      ['เหตุที่ค้าง', r.pendingReason || '-'], ['เจ้าของสำนวน', r.owner || '-'], ['ผู้พิพากษา', r.judge || '-'],
      ['ประเภทคดี (ตามไฟล์)', r.caseType || '-'], ['กลุ่มคดี', r.group || '-'], ['ชื่อรายงาน', r.reportTitle || '-']
    ];
    Object.keys(r.extra || {}).forEach(function (k) { rows.push([k, r.extra[k]]); });
    rows.push(['แหล่งข้อมูล', r.sources.map(function (s) { return s.file + ' › ' + s.sheet; }).join('\n')]);
    var html = '<table class="detail-table">' + rows.map(function (x) {
      return '<tr><th>' + esc(x[0]) + '</th><td>' + (x[2] ? x[1] : esc(x[1])) + '</td></tr>';
    }).join('') + '</table>';
    swal({ title: 'คดีหมายเลขดำที่ ' + esc(r.black), html: html, width: 760 });
  }

  /* ---------- ส่งออก Excel ---------- */
  function exportExcel() {
    var rows = state.table ? state.table.rows({ search: 'applied', order: 'applied' }).data().toArray() : filteredRows();
    if (!rows.length) { swal({ icon: 'info', title: 'ไม่มีข้อมูลสำหรับส่งออก' }); return; }
    var out = rows.map(function (r, i) {
      return {
        'ลำดับ': i + 1, 'สถานะ': STATUS_LABEL[r.ev.status], 'เลขคดีดำ': r.black, 'เลขคดีแดง': r.red,
        'ประเภทการจัดการ': CAT_LABEL[r.ev.category], 'เกณฑ์': r.ev.windowLabel, 'ปรับเกณฑ์โดยเจ้าหน้าที่': r.ev.overridden ? 'ใช่' : '',
        'วันที่รับฟ้อง': r.filingDate ? P.thaiDate(r.filingDate) : r.filingDateRaw, 'ระยะเวลา ณ วันนี้': r.ev.ageText,
        'วันครบกำหนด': r.ev.limitDate ? P.thaiDate(r.ev.limitDate) : '', 'เหลือเวลาก่อนเกินกำหนด (ณ วันนี้)': r.ev.status === 'done' ? '' : remainText(r.ev.daysToLimit),
        'วันนัดต่อไป': r.nextApptRaw, 'ระยะเวลา ณ วันนัด': r.ev.apptAgeText,
        'จำนวนวันถึงวันนัด (ณ วันนี้)': r.ev.daysToAppt == null ? '' : r.ev.daysToAppt, 'โจทก์/ผู้ร้อง': r.plaintiff,
        'จำเลย': r.defendant, 'ข้อหา': r.charge, 'เหตุที่ค้าง': r.pendingReason, 'เจ้าของสำนวน': r.owner,
        'ผู้พิพากษา': r.judge, 'กลุ่มคดี': r.group,
        'แหล่งอ้างอิงวันที่รับฟ้อง': r.filingDateFrom || (r.ev.refSource === 'writ' ? 'วันออกหมายครั้งแรก' : ''),
        'จำนวนหมายระหว่างพิจารณา': (r.writRefs || []).length || '',
        'วันออกหมาย': (r.writRefs || []).map(function (w) { return w.issueDate ? P.thaiDate(w.issueDate) : w.issueDateRaw; }).join(', '),
        'ผลการประเมิน': r.ev.note
      };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), 'Monitor');
    var d = state.today;
    XLSX.writeFile(wb, 'case-monitor_' + P.toISO(d).replace(/-/g, '') + '.xlsx');
  }

  /* ---------- รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา ---------- */
  var WRIT_ROW_CLASS = { red: 'row-red', green: 'row-green', bail: 'row-done' };
  function writMonitorStatus(w) {
    var row = state.byKey[w.black];
    return row ? row.ev.status : '';
  }
  function writFlag(w) { return state.writFlags[w.uid] || null; }
  function evalWrits() {
    state.writs.forEach(function (w) {
      var row = state.byKey[w.black];            // วันที่รับฟ้องจากรายงานคดี (เลขคดีดำตรงกัน)
      w.ev = P.evaluateWrit(w, state.today, writFlag(w), writExcluded(w), row && row.filingDate ? row.filingDate : '');
    });
  }
  /** ช่อง "กำหนดโทษ" ว่างเปล่า => แยกไปตารางด้านบนเพื่อตรวจสอบก่อน */
  function isNoPenalty(w) { return !w.penalty || /^[\s\-–]*$/.test(w.penalty); }
  function writGapText(d) {
    if (d == null) return '-';
    if (d > 0) return 'ออกหมายก่อนครบ 6 เดือน ' + d + ' วัน';
    if (d === 0) return 'ออกหมายตรงวันครบ 6 เดือน';
    return 'ออกหมายหลังครบ 6 เดือน ' + (-d) + ' วัน';
  }
  function filteredWrits() {
    var f = $('wFrom').value, t = $('wTo').value, px = $('wPrefix').value, pn = $('wPenalty').value, st = $('wStatus').value;
    return state.writs.filter(function (w) {
      if (w.ev.status === 'excluded') return false;          // แยกไปตาราง "ไม่อยู่ในเกณฑ์เฝ้าระวัง"
      if (f && (!w.issueDate || w.issueDate < f)) return false;
      if (t && (!w.issueDate || w.issueDate > t)) return false;
      if (px && w.prefix !== px) return false;
      if (pn === 'has' && isNoPenalty(w)) return false;
      if (pn === 'none' && !isNoPenalty(w)) return false;
      if (st === 'watch' && w.ev.status !== 'red' && w.ev.status !== 'green') return false;
      if (st && st !== 'watch' && w.ev.status !== st) return false;
      return true;
    });
  }
  function renderWrits() {
    var has = state.writs.length > 0;
    $('writEmpty').classList.toggle('hidden', has);
    $('writBody').classList.toggle('hidden', !has);
    var reports = (state.data.writs && state.data.writs.reports) || [];
    $('writMeta').textContent = reports.map(function (r) {
      return [r.form, r.period, r.totalText, 'ไฟล์: ' + r.file].filter(Boolean).join(' · ');
    }).join(' | ');
    if (!has) return;
    var px = {};
    state.writs.forEach(function (w) { if (w.prefix) px[w.prefix] = 1; });
    var cur = $('wPrefix').value;
    $('wPrefix').innerHTML = '<option value="">ทั้งหมด</option>' + Object.keys(px).sort().map(function (p) {
      return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
    }).join('');
    $('wPrefix').value = cur;
    drawWrits();
  }
  function writCardsHtml(list) {
    var all = state.writs, c = { red: 0, green: 0, bail: 0, noissue: 0, nodate: 0, excluded: 0, nopen: 0 };
    all.forEach(function (w) { if (c[w.ev.status] !== undefined) c[w.ev.status]++; if (w.ev.status !== 'excluded' && isNoPenalty(w)) c.nopen++; });
    var uniq = function (f) { var o = {}; list.forEach(function (w) { if (w[f]) o[w[f]] = 1; }); return Object.keys(o).length; };
    var dates = list.map(function (w) { return w.issueDate; }).filter(Boolean).sort();
    var cards = [
      ['', 'จำนวนหมาย (ตามตัวกรอง)', list.length.toLocaleString('th-TH') + ' ฉบับ', '#223b63'],
      ['', 'จำนวนคดี / ผู้ต้องขัง', uniq('black').toLocaleString('th-TH') + ' คดี / ' + uniq('name').toLocaleString('th-TH') + ' คน', '#0369a1'],
      ['', 'ช่วงวันที่ออกหมาย', dates.length ? P.thaiDate(dates[0]) + ' – ' + P.thaiDate(dates[dates.length - 1]) : '-', '#64748b'],
      ['', 'กำหนดโทษว่าง (ต้องตรวจสอบ)', c.nopen + ' ฉบับ', '#b45309'],
      ['green', 'เฝ้าระวัง (รับฟ้อง→ออกหมาย 5–6 เดือน)', c.green + ' ฉบับ', '#3fa66b'],
      ['red', 'รับฟ้อง→ออกหมาย เกิน 6 เดือน', c.red + ' ฉบับ', '#d64545'],
      ['nodate', 'ไม่พบวันที่รับฟ้อง (เทียบไม่ได้)', c.nodate + ' ฉบับ', '#c48a00'],
      ['bail', 'ปล่อยชั่วคราวแล้ว', c.bail + ' ฉบับ', '#8aa1c8'],
      ['noissue', 'ไม่มีวันออกหมาย', c.noissue + ' ฉบับ', '#c48a00'],
      ['', 'ไม่อยู่ในเกณฑ์เฝ้าระวัง', c.excluded + ' ฉบับ', '#64748b']
    ];
    return cards.map(function (k) {
      var tag = k[0] ? 'button type="button" data-wcard="' + k[0] + '"' : 'div';
      return '<' + tag + ' class="stat-card lockable' + (k[0] && $('wStatus').value === k[0] ? ' selected' : '') + '" style="border-top-color:' + k[3] + '"><div class="lbl">' + esc(k[1]) +
        '</div><div class="num" style="color:' + k[3] + ';font-size:1.2rem">' + esc(k[2]) + '</div></' + (k[0] ? 'button' : 'div') + '>';
    }).join('');
  }
  function bailCell(w) {
    var f = writFlag(w);
    if (f) {
      return '<div class="clip-sm"><span class="pill pill-done">ออกหมายปล่อยชั่วคราวแล้ว</span>' +
        '<div class="text-xs text-slate-500 mt-1">' + esc(fmtDateTime(f.at)) + (f.by ? '<br>โดย ' + esc(f.by) : '') + '</div>' +
        '<button type="button" class="btn-detail lockable mt-1" data-bail="' + w.idx + '">ยกเลิก</button></div>';
    }
    return '<button type="button" class="btn-bail lockable" data-bail="' + w.idx + '">ระบุ: ปล่อยชั่วคราว</button>';
  }
  function drawWrits(keepPage) {
    drawExcluded();
    var list = filteredWrits();
    $('writCards').innerHTML = writCardsHtml(list);

    var daily = {};
    list.forEach(function (w) { var k = w.issueDate || 'ไม่ระบุ'; daily[k] = (daily[k] || 0) + 1; });
    $('writDaily').innerHTML = Object.keys(daily).sort().map(function (k) {
      return '<tr><td>' + esc(k === 'ไม่ระบุ' ? k : P.thaiDate(k)) + '</td><td>' + daily[k] + ' ฉบับ</td></tr>';
    }).join('') + '<tr><td class="font-semibold">รวม</td><td>' + list.length + ' ฉบับ</td></tr>';

    // แยก 2 ตาราง: กำหนดโทษว่าง (ด้านบน — ตรวจสอบก่อน) / มีข้อมูลกำหนดโทษ (ตารางหลัก)
    var noPen = list.filter(isNoPenalty), withPen = list.filter(function (w) { return !isNoPenalty(w); });
    $('npCount').textContent = noPen.length;
    $('mainCount').textContent = withPen.length;
    $('noPenWrap').classList.toggle('hidden', !noPen.length);
    state.npTable = refreshWritTable(state.npTable, '#tblNoPenalty', noPen, keepPage);
    state.writTable = refreshWritTable(state.writTable, '#tblWrits', withPen, keepPage);
  }
  function refreshWritTable(tbl, sel, data, keepPage) {
    if (tbl) {
      var pg = tbl.page();
      tbl.clear().rows.add(data).draw();
      if (keepPage === true && pg < tbl.page.info().pages) tbl.page(pg).draw(false);
      tbl.columns.adjust();
      return tbl;
    }
    return new DataTable(sel, writTableOptions(data));
  }
  function writTableOptions(data) {
    return {
      data: data, language: DT_LANG, scrollX: true, pageLength: 25, lengthMenu: [10, 25, 50, 100, 500],
      // คอลัมน์ 1–2 = ปุ่มดำเนินการ จึงเรียงตาม "สถานะ" (คอลัมน์ 4) และ "วันออกหมาย" (คอลัมน์ 6)
      order: [[3, 'desc'], [5, 'asc']], autoWidth: false,
      columns: [
        { title: 'ไม่อยู่ในเกณฑ์เฝ้าระวัง', data: null, orderable: false, searchable: false, className: 'text-center',
          render: function (d, t, w) {
            return '<label class="ex-check" title="ติ๊กเพื่อนำรายการนี้ออกจากเกณฑ์เฝ้าระวัง"><input type="checkbox" class="lockable" data-exclude="' + w.idx + '"> ไม่อยู่ในเกณฑ์</label>';
          } },
        { title: 'ขอประกันตัว / ออกหมายปล่อยชั่วคราว', data: null,
          render: function (d, t, w) { var f = writFlag(w); if (t !== 'display') return f ? 1 : 0; return bailCell(w); } },
        { title: 'ลำดับ', data: 'seq', className: 'text-center', render: function (d, t) { return t === 'sort' || t === 'type' ? (+d || 0) : esc(d); } },
        { title: 'สถานะ (5–6 เดือน)', data: 'ev.status',
          render: function (d, t) { return t === 'sort' || t === 'type' ? P.STATUS[d].rank : pill(d); } },
        { title: 'วันที่รับฟ้อง (จากรายงานคดี)', data: 'ev.filingDate',
          render: function (d, t) {
            if (t === 'sort' || t === 'type') return d || '';
            return d ? '<span class="whitespace-nowrap">' + esc(P.thaiDate(d)) + '</span>' : '<span class="text-amber-700 text-xs">ไม่พบในรายงานคดี</span>';
          } },
        { title: 'วันเดือนปีที่ออกหมาย', data: 'issueDate',
          render: function (d, t, w) {
            if (t === 'sort' || t === 'type') return d || '';
            return d ? '<span class="whitespace-nowrap">' + esc(P.thaiDate(d)) + '</span>'
              : '<span class="text-amber-700 text-xs">' + esc(w.issueDateRaw ? 'อ่านไม่ได้: ' + w.issueDateRaw : 'ไม่มีข้อมูล') + '</span>';
          } },
        { title: 'ระยะเวลา (รับฟ้อง → ออกหมาย)', data: 'ev.ageDays',
          render: function (d, t, w) { if (t === 'sort' || t === 'type') return d == null ? -1 : d; return d == null ? '-' : '<span class="whitespace-nowrap font-semibold">' + esc(w.ev.ageText) + '</span>'; } },
        { title: 'เทียบวันครบ 6 เดือน', data: 'ev.daysToLimit',
          render: function (d, t, w) {
            var na = d == null || w.ev.status === 'bail';
            if (t === 'sort' || t === 'type') return na ? 1e9 : d;
            if (na) return '-';
            var cls = d <= 0 ? 'text-red-700' : (w.ev.status === 'green' ? 'text-amber-700' : 'text-slate-700');
            return '<span class="clip-sm font-semibold ' + cls + '">' + esc(writGapText(d)) + '</span><span class="text-xs text-slate-500 whitespace-nowrap">ครบ 6 เดือน ' + esc(P.thaiDate(w.ev.limitDate)) + '</span>';
          } },
        { title: 'เลขที่หมายอ้างอิง', data: 'refNo', render: function (d) { return esc(d || '-'); } },
        { title: 'เลขที่หมาย', data: 'writNo', render: function (d) { return '<span class="whitespace-nowrap">' + esc(d || '-') + '</span>'; } },
        { title: 'หมายเลขดำที่', data: 'black', render: function (d) { return '<b class="whitespace-nowrap">' + esc(d || '-') + '</b>'; } },
        { title: 'ชื่อและนามสกุลผู้ต้องขัง', data: 'name', render: function (d) { return '<span class="clip-sm">' + esc(d || '-') + '</span>'; } },
        { title: 'ข้อหา', data: 'charge', render: function (d) { return '<span class="clip">' + esc(d || '-') + '</span>'; } },
        { title: 'กำหนดโทษ', data: 'penalty',
          render: function (d, t, w) { return isNoPenalty(w) ? '<span class="pill pill-nodate">ว่างเปล่า</span>' : '<span class="clip-sm">' + esc(d) + '</span>'; } },
        { title: 'สถานะคดีในระบบติดตาม', data: null,
          render: function (d, t, w) { var st = writMonitorStatus(w); if (t === 'sort' || t === 'type') return st ? P.STATUS[st].rank : -1; return st ? pill(st) : '<span class="text-slate-400">ไม่พบในรายงานคดีค้าง</span>'; } },
        { title: '', data: null, orderable: false, searchable: false,
          render: function (d, t, w) { return '<button type="button" class="btn-detail lockable" data-writ="' + w.idx + '">รายละเอียด</button>'; } }
      ],
      createdRow: function (tr, w) {
        var cls = WRIT_ROW_CLASS[w.ev.status];
        if (cls) tr.classList.add(cls);
      }
    };
  }
  function showWritDetail(idx) {
    var w = state.writs[idx]; if (!w) return;
    var st = writMonitorStatus(w), row = state.byKey[w.black], f = writFlag(w);
    var rows = [
      ['สถานะเฝ้าระวัง (5–6 เดือน)', pill(w.ev.status), true],
      ['ผลการประเมิน', w.ev.note],
      ['ลำดับ (ตามรายงาน)', w.seq], ['วันเดือนปีที่ออกหมาย', w.issueDate ? P.thaiDate(w.issueDate) + ' (ต้นฉบับ: ' + w.issueDateRaw + ')' : (w.issueDateRaw || 'ไม่มีข้อมูล')],
      ['วันที่รับฟ้อง (จากรายงานคดี)', w.ev.filingDate ? P.thaiDate(w.ev.filingDate) : 'ไม่พบในรายงานคดีที่นำเข้า'],
      ['ระยะเวลา (รับฟ้อง → ออกหมาย)', w.ev.ageText || '-'],
      ['เทียบวันครบ 6 เดือน', w.ev.limitDate && w.issueDate ? writGapText(w.ev.daysToLimit) + ' (ครบ 6 เดือน ' + P.thaiDate(w.ev.limitDate) + ')' : '-'],
      ['เลขที่หมายอ้างอิง', w.refNo || '-'], ['เลขที่หมาย', w.writNo || '-'], ['หมายเลขดำที่', w.black || '-'],
      ['ชื่อและนามสกุลผู้ต้องขัง', w.name || '-'], ['ข้อหา', w.charge || '-'], ['กำหนดโทษ', w.penalty || '-'],
      ['การขอประกันตัว / หมายปล่อยชั่วคราว', f ? 'บันทึกแล้วเมื่อ ' + fmtDateTime(f.at) + (f.by ? ' โดย ' + f.by : '') + (f.note ? '\nหมายเหตุ: ' + f.note : '') : 'ยังไม่มีการบันทึก']
    ];
    Object.keys(w.extra || {}).forEach(function (k) { rows.push([k, w.extra[k]]); });
    rows.push(['แหล่งข้อมูล', w.source.file + ' › ' + w.source.sheet]);
    var html = '<table class="detail-table">' + rows.map(function (x) { return '<tr><th>' + esc(x[0]) + '</th><td>' + (x[2] ? x[1] : esc(x[1])) + '</td></tr>'; }).join('') +
      '<tr><th>สถานะคดีในระบบติดตาม</th><td>' + (st ? pill(st) + '<br>' + esc(row.ev.note) : 'ไม่พบเลขคดีนี้ในรายงานคดีค้างที่นำเข้า') + '</td></tr></table>';
    swal({ title: 'หมายเลขที่ ' + esc(w.writNo || '-'), html: html, width: 720 });
  }

  /** เจ้าหน้าที่ระบุ / ยกเลิก "มีการขอประกันตัว และออกหมายปล่อยชั่วคราวระหว่างพิจารณา" */
  function toggleBail(idx) {
    var w = state.writs[idx]; if (!w) return;
    var f = writFlag(w);
    var info = '<table class="detail-table mb-3">' +
      '<tr><th>หมายเลขดำที่</th><td>' + esc(w.black || '-') + '</td></tr>' +
      '<tr><th>เลขที่หมาย</th><td>' + esc(w.writNo || '-') + '</td></tr>' +
      '<tr><th>ผู้ต้องขัง</th><td>' + esc(w.name || '-') + '</td></tr>' +
      '<tr><th>วันเดือนปีที่ออกหมาย</th><td>' + esc(w.issueDate ? P.thaiDate(w.issueDate) : (w.issueDateRaw || 'ไม่มีข้อมูล')) + '</td></tr>' +
      '<tr><th>ข้อหา</th><td>' + esc(w.charge || '-') + '</td></tr></table>';
    var opts = f ? {
      icon: 'warning',
      title: 'ยกเลิกการบันทึกปล่อยชั่วคราว?',
      html: info + '<p class="text-sm text-left">รายการนี้บันทึกไว้เมื่อ ' + esc(fmtDateTime(f.at)) + (f.by ? ' โดย ' + esc(f.by) : '') +
        '<br>เมื่อยกเลิก รายการจะกลับมาอยู่ในการเฝ้าระวังกรอบ 5–6 เดือนตามวันออกหมาย</p>',
      confirmButtonText: 'ยืนยันยกเลิก', confirmButtonColor: '#b42318'
    } : {
      icon: 'question',
      title: 'ยืนยัน: คดีนี้มีการออกหมายปล่อยระหว่างพิจารณา',
      html: info +
        '<p class="text-sm text-left mb-2">ยืนยันว่าคดีนี้มีการ<b>ขอประกันตัว</b> และศาลได้<b>ออกหมายปล่อยตัวชั่วคราวระหว่างพิจารณา</b>แล้ว ' +
        'รายการนี้จะไม่ถูกนับในการเฝ้าระวัง 5–6 เดือน</p>' +
        '<input id="bailBy" class="swal2-input !m-0 !w-full !text-sm" maxlength="100" placeholder="ชื่อเจ้าหน้าที่ผู้บันทึก (ไม่บังคับ)">' +
        '<textarea id="bailNote" class="swal2-textarea !mx-0 !mt-2 !w-full !text-sm" maxlength="500" placeholder="หมายเหตุ เช่น เลขที่หมายปล่อย / วันที่อนุญาตประกัน (ไม่บังคับ)"></textarea>',
      confirmButtonText: 'ยืนยันบันทึก'
    };
    swal(Object.assign({
      width: 640, showCancelButton: true, cancelButtonText: 'ปิด', reverseButtons: true, focusConfirm: false,
      showLoaderOnConfirm: true,
      preConfirm: function () {
        var value = f ? null : { bail: true, black: w.black || '', writNo: w.writNo || '',
          by: ($('bailBy') || {}).value || '', note: ($('bailNote') || {}).value || '' };
        return storeSet('writ_flags', w.uid, value).catch(function (err) { Swal.showValidationMessage(err.message); return false; });
      }
    }, opts)).then(function (res) {
      if (!res.isConfirmed || !res.value) return;
      if (res.value.item) state.writFlags[w.uid] = res.value.item; else delete state.writFlags[w.uid];
      evalWrits();
      drawWrits(true);
      swal({ icon: 'success', title: f ? 'ยกเลิกการบันทึกแล้ว' : 'บันทึกการออกหมายปล่อยชั่วคราวแล้ว',
        text: 'หมายเลขดำที่ ' + (w.black || '-') + ' · เลขที่หมาย ' + (w.writNo || '-') });
    });
  }

  function writRowsForOutput() {
    var get = function (t) { return t ? t.rows({ search: 'applied', order: 'applied' }).data().toArray() : []; };
    return state.writTable || state.npTable ? get(state.npTable).concat(get(state.writTable)) : filteredWrits();
  }
  function exportWrits() {
    var list = writRowsForOutput();
    if (!list.length) { swal({ icon: 'info', title: 'ไม่มีข้อมูลสำหรับส่งออก' }); return; }
    var out = list.map(function (w, i) {
      var st = writMonitorStatus(w), f = writFlag(w);
      return { 'ลำดับ': i + 1, 'สถานะ (5–6 เดือน)': STATUS_LABEL[w.ev.status], 'วันเดือนปีที่ออกหมาย': w.issueDate ? P.thaiDate(w.issueDate) : (w.issueDateRaw || 'ไม่มีข้อมูล'),
        'วันที่รับฟ้อง (จากรายงานคดี)': w.ev.filingDate ? P.thaiDate(w.ev.filingDate) : '', 'ระยะเวลา (รับฟ้อง → ออกหมาย)': w.ev.ageText, 'เทียบวันครบ 6 เดือน': w.ev.daysToLimit == null ? '' : writGapText(w.ev.daysToLimit), 'เลขที่หมายอ้างอิง': w.refNo,
        'เลขที่หมาย': w.writNo, 'หมายเลขดำที่': w.black, 'ชื่อและนามสกุลผู้ต้องขัง': w.name, 'ข้อหา': w.charge,
        'กำหนดโทษ': w.penalty || '-',
        'ออกหมายปล่อยชั่วคราว': f ? 'ใช่ (' + fmtDateTime(f.at) + (f.by ? ' โดย ' + f.by : '') + ')' : '',
        'หมายเหตุการปล่อยชั่วคราว': f ? f.note || '' : '',
        'สถานะคดีในระบบติดตาม': st ? STATUS_LABEL[st] : '' };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(out), 'หมายระหว่างพิจารณา');
    XLSX.writeFile(wb, 'writ-report_' + P.toISO(state.today).replace(/-/g, '') + '.xlsx');
  }
  function printWrits() {
    var list = writRowsForOutput();
    if (!list.length) { swal({ icon: 'info', title: 'ไม่มีข้อมูลสำหรับพิมพ์' }); return; }
    var reports = (state.data.writs && state.data.writs.reports) || [];
    var f = $('wFrom').value, t = $('wTo').value;
    var period = (f || t) ? 'ออกหมายระหว่างวันที่ ' + (f ? P.thaiDate(f) : '-') + ' ถึง ' + (t ? P.thaiDate(t) : '-')
      : reports.map(function (r) { return r.period; }).filter(Boolean).join(' / ');
    var html = '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><title>รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600&display=swap" rel="stylesheet">' +
      '<style>body{font-family:Sarabun,sans-serif;font-size:12px;margin:16px;color:#000}h1{font-size:18px;text-align:center;margin:0}' +
      '.sub{text-align:center;margin:4px 0 12px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #444;padding:4px 6px;vertical-align:top}' +
      'th{background:#eee}.c{text-align:center}tr.red td{background:#fdeeee}tr.green td{background:#ecf8f1}' +
      '@page{size:A4 landscape;margin:12mm}@media print{tr.red td,tr.green td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>' +
      '<h1>รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา</h1><div class="sub">' + esc(period) + '<br>รวมทั้งสิ้น ' + list.length + ' ฉบับ' +
      (reports[0] && reports[0].form ? ' (' + esc(reports[0].form) + ')' : '') + '</div><table><thead><tr>' +
      '<th>ลำดับ</th><th>สถานะ (5–6 เดือน)</th><th>วันเดือนปีที่ออกหมาย</th><th>ระยะเวลา</th><th>เลขที่หมาย</th><th>หมายเลขดำที่</th><th>ชื่อและนามสกุลผู้ต้องขัง</th><th>ข้อหา</th><th>กำหนดโทษ</th><th>ปล่อยชั่วคราว</th>' +
      '</tr></thead><tbody>' + list.map(function (w, i) {
        return '<tr class="' + esc(w.ev.status) + '"><td class="c">' + (i + 1) + '</td><td class="c">' + esc(STATUS_LABEL[w.ev.status]) + '</td><td class="c">' +
          esc(w.issueDate ? P.thaiDate(w.issueDate) : (w.issueDateRaw || 'ไม่มีข้อมูล')) + '</td><td>' + esc(w.ev.ageText || '-') +
          '</td><td>' + esc(w.writNo) + '</td><td>' + esc(w.black) + '</td><td>' + esc(w.name) + '</td><td>' + esc(w.charge) + '</td><td>' + esc(w.penalty || '-') +
          '</td><td class="c">' + (writFlag(w) ? 'ใช่' : '-') + '</td></tr>';
      }).join('') + '</tbody></table><p style="margin-top:12px;font-size:11px">พิมพ์เมื่อ ' + esc(fmtDateTime(new Date().toISOString())) + '</p>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script></body></html>';
    var win = window.open('', '_blank');
    if (!win) { swal({ icon: 'warning', title: 'เบราว์เซอร์บล็อกหน้าต่างใหม่', text: 'กรุณาอนุญาต Pop-up สำหรับเว็บไซต์นี้แล้วลองอีกครั้ง' }); return; }
    win.document.open(); win.document.write(html); win.document.close();
  }

  /* ---------- ข้อมูลตามไฟล์ต้นฉบับ ---------- */
  function renderFiles() {
    var files = state.data.meta.files || [];
    $('fileSummary').innerHTML = files.map(function (f) {
      return '<div class="bg-white border border-slate-200 rounded-lg p-3 text-sm">' +
        '<div class="font-semibold text-gov-800 truncate" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
        '<div class="text-slate-500 text-xs mb-2">' + fmtBytes(f.size || 0) +
        (f.type === 'writ' ? ' · <span class="text-gov-700 font-semibold">รายงานหมายระหว่างพิจารณา (อาญา)</span>' : ' · รายงานคดี') + '</div>' +
        f.sheets.map(function (s) {
          return '<div class="flex justify-between gap-2 border-t border-slate-100 py-1"><span class="truncate">' + esc(s.sheet) +
            (s.group ? ' <span class="text-slate-400">(' + esc(s.group) + ')</span>' : '') + '</span>' +
            '<span class="' + (s.ok ? 'text-slate-700' : 'text-amber-700') + ' whitespace-nowrap">' + esc(s.message) + '</span></div>';
        }).join('') + '</div>';
    }).join('');

    var sel = $('fSheet');
    var sheets = state.data.sheets || [];
    var prev = sel.value;
    sel.innerHTML = sheets.map(function (s, i) {
      return '<option value="' + i + '">' + esc(s.file + ' › ' + s.sheet + (s.group ? ' — ' + s.group : '') + ' (' + s.rows.length + ' แถว)') + '</option>';
    }).join('');
    if (prev && sheets[prev]) sel.value = prev;
    renderSheetTable();
  }

  function renderSheetTable() {
    var s = (state.data.sheets || [])[+$('fSheet').value || 0];
    if (state.sheetTable) { state.sheetTable.destroy(); state.sheetTable = null; }
    $('sheetTableWrap').innerHTML = '';
    if (!s) { $('sheetMeta').textContent = 'ไม่มีข้อมูล'; return; }
    $('sheetMeta').innerHTML = [s.title, s.group, s.period].filter(Boolean).map(esc).join(' · ');
    var table = document.createElement('table');
    table.className = 'row-border hover w-full text-sm';
    table.style.width = '100%';
    $('sheetTableWrap').appendChild(table);
    var data = s.rows.map(function (cells, i) { return { cells: cells, key: s.keys[i] }; });
    var cols = [{ title: 'สถานะ (ประเมิน)', data: null, render: function (d, t, r) {
      var row = state.byKey[r.key];
      if (!row) return '-';
      return t === 'display' ? pill(row.ev.status) : P.STATUS[row.ev.status].rank;
    } }];
    s.headers.forEach(function (h, ci) {
      cols.push({ title: esc(h), data: null, render: function (d, t, r) {
        var v = r.cells[ci] == null ? '' : String(r.cells[ci]);
        return t === 'display' ? '<span class="clip">' + esc(v).replace(/\n/g, '<br>') + '</span>' : v;
      } });
    });
    state.sheetTable = new DataTable(table, {
      data: data, columns: cols, language: DT_LANG, scrollX: true, pageLength: 25,
      lengthMenu: [10, 25, 50, 100, 500], order: [],
      createdRow: function (tr, r) {
        var row = state.byKey[r.key];
        if (!row) return;
        if (row.ev.status === 'red') tr.classList.add('row-red');
        else if (row.ev.status === 'green') tr.classList.add('row-green');
        else if (row.ev.status === 'done') tr.classList.add('row-done');
      }
    });
  }

  /* ================================================================
   * หน้าต่างอัปโหลดไฟล์ (SweetAlert)
   * ================================================================ */
  function openUpload() {
    if (state.processing) return;
    var selected = [];
    var html =
      '<div class="text-left space-y-3">' +
      '  <div id="upDrop" class="dropzone">' +
      '    <svg class="w-10 h-10 mx-auto text-slate-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M12 16V4m0 0l-4 4m4-4l4 4M4 20h16"/></svg>' +
      '    <div class="mt-2 font-medium">คลิกเพื่อเลือกไฟล์ หรือลากไฟล์มาวางที่นี่</div>' +
      '    <div class="text-xs text-slate-500 mt-1">รองรับเฉพาะไฟล์ Excel (.xls, .xlsx) เลือกได้มากกว่า 1 ไฟล์</div>' +
      '    <input id="upInput" type="file" class="hidden" multiple accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">' +
      '  </div>' +
      '  <div id="upError" class="hidden text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2"></div>' +
      '  <div class="flex items-center justify-between text-sm">' +
      '    <span>ไฟล์ที่เลือก: <b id="upCount">0</b> ไฟล์ (<span id="upSize">0 B</span>)</span>' +
      '    <button type="button" id="upClear" class="text-red-700 border border-red-200 rounded px-2 py-1 text-xs hover:bg-red-50 disabled:opacity-40" disabled>ลบทั้งหมด</button>' +
      '  </div>' +
      '  <div id="upList" class="file-list"><div class="p-4 text-center text-sm text-slate-400">ยังไม่ได้เลือกไฟล์</div></div>' +
      '  <div class="text-xs text-slate-500">ข้อมูลชุดเดิมจะถูกแทนที่ด้วยผลการประมวลผลชุดใหม่ — ไฟล์ Excel ถูกอ่านในเบราว์เซอร์เท่านั้น ไม่ถูกส่งหรือจัดเก็บบนเซิร์ฟเวอร์</div>' +
      '</div>';

    function refresh() {
      var list = $('upList');
      $('upCount').textContent = selected.length;
      $('upSize').textContent = fmtBytes(selected.reduce(function (a, f) { return a + f.size; }, 0));
      $('upClear').disabled = !selected.length;
      if (!selected.length) { list.innerHTML = '<div class="p-4 text-center text-sm text-slate-400">ยังไม่ได้เลือกไฟล์</div>'; }
      else {
        list.innerHTML = selected.map(function (f, i) {
          return '<div class="file-item">' +
            '<span class="text-emerald-700 font-semibold text-xs border border-emerald-200 bg-emerald-50 rounded px-1">' + esc(f.name.split('.').pop().toUpperCase()) + '</span>' +
            '<span class="name" title="' + esc(f.name) + '">' + (i + 1) + '. ' + esc(f.name) + '</span>' +
            '<span class="text-xs text-slate-500 whitespace-nowrap">' + fmtBytes(f.size) + '</span>' +
            '<button type="button" class="remove" data-remove="' + i + '">ลบ</button></div>';
        }).join('');
      }
      var btn = Swal.getConfirmButton();
      if (btn) btn.disabled = !selected.length;
    }
    function addFiles(fileList) {
      var rejected = [], dup = 0;
      Array.prototype.forEach.call(fileList, function (f) {
        var ext = (f.name.split('.').pop() || '').toLowerCase();
        if (ext !== 'xls' && ext !== 'xlsx') { rejected.push(f.name); return; }
        if (selected.some(function (x) { return x.name === f.name && x.size === f.size && x.lastModified === f.lastModified; })) { dup++; return; }
        selected.push(f);
      });
      var msg = [];
      if (rejected.length) msg.push('ไม่รับไฟล์ที่ไม่ใช่ Excel: ' + rejected.join(', '));
      if (dup) msg.push('ข้ามไฟล์ที่เลือกซ้ำ ' + dup + ' ไฟล์');
      var box = $('upError');
      box.textContent = msg.join(' · ');
      box.classList.toggle('hidden', !msg.length);
      refresh();
    }

    swal({
      title: 'นำเข้าไฟล์ Excel เพื่อประมวลผล',
      html: html,
      width: 680,
      showCancelButton: true,
      confirmButtonText: 'ยืนยันประมวลผลข้อมูล',
      cancelButtonText: 'ปิด',
      reverseButtons: true,
      focusConfirm: false,
      didOpen: function () {
        var drop = $('upDrop'), input = $('upInput');
        drop.addEventListener('click', function () { input.click(); });
        input.addEventListener('change', function () { addFiles(input.files); input.value = ''; });
        ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); }); });
        ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); }); });
        drop.addEventListener('drop', function (e) { addFiles(e.dataTransfer.files); });
        $('upList').addEventListener('click', function (e) {
          var b = e.target.closest('[data-remove]');
          if (!b) return;
          selected.splice(+b.getAttribute('data-remove'), 1);
          refresh();
        });
        $('upClear').addEventListener('click', function () { selected = []; $('upError').classList.add('hidden'); refresh(); });
        refresh();
      },
      preConfirm: function () {
        if (!selected.length) { Swal.showValidationMessage('กรุณาเลือกไฟล์ Excel อย่างน้อย 1 ไฟล์'); return false; }
        return selected.slice();
      }
    }).then(function (res) {
      if (res.isConfirmed && res.value && res.value.length) runProcessing(res.value);
    });
  }

  /* ================================================================
   * การประมวลผล + Progress
   * ================================================================ */
  var STEPS = [
    { id: 'validate', label: 'ตรวจสอบไฟล์ที่เลือก', from: 0, to: 4 },
    { id: 'upload',   label: 'โหลดไฟล์ Excel เข้าหน่วยความจำของเบราว์เซอร์ (ไม่ส่งไฟล์ขึ้นเซิร์ฟเวอร์)', from: 4, to: 18 },
    { id: 'read',     label: 'อ่านไฟล์ Excel / ตรวจหาหัวตารางและคอลัมน์', from: 18, to: 45 },
    { id: 'writ',     label: 'แยกรายงานหมายระหว่างพิจารณา / ตรวจวันออกหมาย (กรอบ 5–6 เดือน)', from: 45, to: 48 },
    { id: 'merge',    label: 'รวมคดีซ้ำ / อ้างอิงวันที่รับฟ้องและวันออกหมายข้ามไฟล์', from: 48, to: 50 },
    { id: 'classify', label: 'จัดประเภทคดีตามอักษรย่อ (พิเศษ / ทั่วไป / อักษรย่ออื่น)', from: 50, to: 65 },
    { id: 'evaluate', label: 'นับระยะเวลาจากวันที่รับฟ้อง และตรวจวันนัดต่อไปเทียบกรอบ 11–12 เดือน', from: 65, to: 85 },
    { id: 'save',     label: 'บีบอัดและบันทึกผลประมวลผลลงฐานข้อมูล', from: 85, to: 95 },
    { id: 'cleanup',  label: 'ล้างไฟล์ Excel ออกจากหน่วยความจำ (ไม่มีการจัดเก็บไฟล์ Excel)', from: 95, to: 100 }
  ];

  function lockSystem(on) {
    state.processing = on;
    $('systemLock').classList.toggle('hidden', !on);
    document.body.classList.toggle('locked', on);
    $('app').inert = on;
    $('app').setAttribute('aria-hidden', on ? 'true' : 'false');
    document.querySelectorAll('.lockable, #app button, #app select, #app input').forEach(function (el) {
      if (on) { el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = true; }
      else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === '1'; delete el.dataset.wasDisabled; }
    });
    window.onbeforeunload = on ? function (e) { e.preventDefault(); e.returnValue = 'ระบบกำลังประมวลผล กรุณาอย่าปิดหน้าต่างนี้'; return e.returnValue; } : null;
  }

  function openProgressModal(fileCount) {
    var html =
      '<div class="space-y-3">' +
      '  <div class="proc-warning"><b>⚠ ห้ามปิดหน้าต่างนี้หรือรีเฟรชหน้าเว็บโดยเด็ดขาด</b><br>ระบบกำลังประมวลผลไฟล์ ' + fileCount +
      ' ไฟล์ และปิดการใช้งานทุกส่วนชั่วคราว จนกว่าการประมวลผลจะเสร็จสิ้น</div>' +
      '  <div class="flex justify-between items-end text-sm"><span id="pgStep" class="font-semibold text-gov-800 text-left">กำลังเริ่มต้น...</span><span id="pgPct" class="text-2xl font-bold text-gov-800">0%</span></div>' +
      '  <div class="proc-bar"><div id="pgBar"></div></div>' +
      '  <div id="pgDetail" class="text-sm text-slate-600 text-left min-h-[1.25rem]"></div>' +
      '  <div class="proc-steps border-t border-slate-100 pt-2">' + STEPS.map(function (s, i) {
        return '<div class="proc-step" id="ps-' + s.id + '"><span class="ico"></span><span>ขั้นตอนที่ ' + (i + 1) + '/' + STEPS.length + ': ' + esc(s.label) + '</span></div>';
      }).join('') + '</div>' +
      '  <div id="pgLog" class="proc-log"></div>' +
      '</div>';
    Swal.fire({
      title: 'กำลังประมวลผลข้อมูล',
      html: html,
      width: 640,
      allowOutsideClick: false,
      allowEscapeKey: false,
      allowEnterKey: false,
      showConfirmButton: false,
      showCancelButton: false,
      showCloseButton: false
    });
  }

  var progress = {
    stepIdx: -1,
    begin: function (id, detail) {
      var i = STEPS.findIndex(function (s) { return s.id === id; });
      for (var k = 0; k < i; k++) this.mark(STEPS[k].id, 'done');
      this.stepIdx = i;
      this.mark(id, 'running');
      var el = $('pgStep'); if (el) el.textContent = 'ขั้นตอนที่ ' + (i + 1) + '/' + STEPS.length + ': ' + STEPS[i].label;
      this.set(0, detail);
    },
    /** frac 0..1 ภายในขั้นตอนปัจจุบัน */
    set: function (frac, detail) {
      var s = STEPS[this.stepIdx]; if (!s) return;
      var pct = Math.min(100, Math.round((s.from + (s.to - s.from) * Math.max(0, Math.min(1, frac))) * 10) / 10);
      var bar = $('pgBar'), p = $('pgPct');
      if (bar) bar.style.width = pct + '%';
      if (p) p.textContent = (pct % 1 ? pct.toFixed(1) : pct) + '%';
      if (detail !== undefined) { var d = $('pgDetail'); if (d) d.textContent = detail; }
    },
    done: function (id) { this.mark(id, 'done'); this.set(1); },
    mark: function (id, cls) {
      var el = $('ps-' + id); if (!el) return;
      el.classList.remove('running', 'done', 'error'); el.classList.add(cls);
      el.querySelector('.ico').textContent = cls === 'done' ? '✓' : (cls === 'error' ? '!' : '');
    },
    log: function (msg) {
      var el = $('pgLog'); if (!el) return;
      var t = new Date(), pad = function (x) { return (x < 10 ? '0' : '') + x; };
      el.insertAdjacentHTML('beforeend', '<div>[' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) + '] ' + esc(msg) + '</div>');
      el.scrollTop = el.scrollHeight;
    }
  };

  /** อ่านไฟล์ Excel ในเบราว์เซอร์ (ไม่ส่งขึ้นเซิร์ฟเวอร์) */
  async function loadFilesLocally(files) {
    var out = [], total = files.reduce(function (t, f) { return t + f.size; }, 0), done = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      progress.set(done / total, 'กำลังโหลดไฟล์ ' + (i + 1) + '/' + files.length + ': ' + f.name + ' (' + fmtBytes(f.size) + ')');
      var buf;
      try { buf = await f.arrayBuffer(); } catch (e) { throw new Error('ไม่สามารถอ่านไฟล์ "' + f.name + '" ได้ (' + e.message + ')'); }
      // ตรวจลายเซ็นไฟล์จริง: .xls = OLE2 (D0 CF 11 E0), .xlsx = ZIP (50 4B 03 04)
      var sig = new Uint8Array(buf.slice(0, 4));
      var isOle = sig[0] === 0xD0 && sig[1] === 0xCF && sig[2] === 0x11 && sig[3] === 0xE0;
      var isZip = sig[0] === 0x50 && sig[1] === 0x4B && sig[2] === 0x03 && sig[3] === 0x04;
      if (!isOle && !isZip) throw new Error('ไฟล์ "' + f.name + '" ไม่ใช่ไฟล์ Excel ที่ถูกต้อง');
      done += f.size;
      out.push({ name: f.name, size: f.size, buf: buf });
      progress.set(done / total, 'โหลดแล้ว ' + fmtBytes(done) + ' จาก ' + fmtBytes(total));
      await tick();
    }
    return out;
  }

  async function runProcessing(files) {
    lockSystem(true);
    openProgressModal(files.length);
    await sleep(150);
    var loaded = [];
    var fileCount = files.length;
    var started = new Date();
    try {
      /* ---- 1. ตรวจสอบไฟล์ ---- */
      progress.begin('validate', 'ตรวจสอบนามสกุลและขนาดไฟล์');
      for (var i = 0; i < files.length; i++) {
        var ext = files[i].name.split('.').pop().toLowerCase();
        if (ext !== 'xls' && ext !== 'xlsx') throw new Error('ไฟล์ "' + files[i].name + '" ไม่ใช่ไฟล์ Excel');
        if (!files[i].size) throw new Error('ไฟล์ "' + files[i].name + '" ไม่มีข้อมูล (0 ไบต์)');
        progress.set((i + 1) / files.length, 'ตรวจสอบไฟล์ ' + (i + 1) + '/' + files.length + ': ' + files[i].name);
        await sleep(60);
      }
      progress.log('ตรวจสอบไฟล์ผ่าน ' + files.length + ' ไฟล์');
      progress.done('validate');

      /* ---- 2. อัปโหลด ---- */
      progress.begin('upload', 'กำลังโหลดไฟล์เข้าหน่วยความจำของเบราว์เซอร์...');
      loaded = await loadFilesLocally(files);
      progress.log('โหลดไฟล์ Excel ' + loaded.length + ' ไฟล์เข้าหน่วยความจำแล้ว (ไม่มีการส่งไฟล์ขึ้นเซิร์ฟเวอร์)');
      progress.done('upload');

      /* ---- 3. อ่านไฟล์ ---- */
      progress.begin('read', 'เริ่มอ่านไฟล์ Excel');
      var allRecords = [], sheetsOut = [], filesMeta = [], writRecords = [], writReports = [];
      for (var fi = 0; fi < loaded.length; fi++) {
        var uf = loaded[fi];
        var label = 'ไฟล์ ' + (fi + 1) + '/' + loaded.length + ': ' + uf.name;
        progress.set(fi / loaded.length, 'กำลังอ่าน' + label);
        var buf = uf.buf;
        await tick();
        var wb;
        try { wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: false }); }
        catch (e) { throw new Error('ไฟล์ "' + uf.name + '" เปิดไม่ได้หรือไฟล์เสียหาย (' + e.message + ')'); }
        var fmeta = { name: uf.name, size: uf.size, type: 'case', sheets: [] };
        var sheetRows = wb.SheetNames.map(function (sn) {
          return XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '', blankrows: true });
        });
        // ไฟล์ที่มีคอลัมน์ "วันเดือนปีที่ออกหมาย" = รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา (แยกรายงานต่างหาก)
        var isWrit = sheetRows.some(function (rows) { return P.isWritSheet(rows); });
        if (isWrit) {
          fmeta.type = 'writ';
          progress.log(uf.name + ': พบคอลัมน์ "วันเดือนปีที่ออกหมาย" → จัดเป็นรายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา');
        }
        for (var si = 0; si < wb.SheetNames.length; si++) {
          var sn = wb.SheetNames[si];
          progress.set((fi + (si + 0.5) / wb.SheetNames.length) / loaded.length, label + ' › ชีต "' + sn + '" — ' +
            (isWrit ? 'อ่านรายงานการออกหมาย' : 'ตรวจหาหัวตารางและจับคู่คอลัมน์'));
          var res = isWrit ? P.parseWritSheet(uf.name, sn, sheetRows[si]) : P.parseSheet(uf.name, sn, sheetRows[si]);
          await tick();
          fmeta.sheets.push({ sheet: sn, type: isWrit ? 'writ' : 'case', ok: res.ok, message: res.message, rows: res.records.length,
            group: res.meta ? res.meta.group : '', title: res.meta ? res.meta.title : '', period: res.meta ? res.meta.period : '' });
          progress.log(uf.name + ' › ' + sn + ': ' + res.message);
          if (res.ok) {
            if (isWrit) {
              writRecords = writRecords.concat(res.records);
              writReports.push({ file: uf.name, sheet: sn, form: res.meta.form, period: res.meta.period, totalText: res.meta.totalText, count: res.records.length });
            } else {
              allRecords = allRecords.concat(res.records);
            }
            sheetsOut.push({ type: isWrit ? 'writ' : 'case', file: uf.name, sheet: sn, title: res.meta.title, group: res.meta.group, period: res.meta.period,
              headers: res.headers, rows: res.rawRows, keys: res.rawKeys });
          }
        }
        filesMeta.push(fmeta);
        uf.buf = null; wb = null;              // คืนหน่วยความจำของไฟล์ที่อ่านเสร็จแล้ว
      }
      if (!allRecords.length && !writRecords.length) throw new Error('ไม่พบข้อมูลคดีในไฟล์ที่นำเข้า (ไม่พบคอลัมน์เลขคดีดำ หรือไม่มีแถวข้อมูล)');
      progress.log('อ่านข้อมูลคดีได้ ' + allRecords.length.toLocaleString('th-TH') + ' แถว');
      progress.done('read');

      /* ---- แยกรายงานหมายระหว่างพิจารณา ---- */
      progress.begin('writ', writRecords.length ? 'จัดเรียงรายการหมายตามวันที่ออกหมาย' : 'ไม่พบไฟล์รายงานการออกหมาย');
      await sleep(120);
      writRecords.sort(function (a, b) {
        return (a.issueDate || '').localeCompare(b.issueDate || '') || ((+a.seq || 0) - (+b.seq || 0));
      });
      var noIssue = writRecords.filter(function (w) { return !w.issueDate; }).length;
      var wsc = { red: 0, green: 0 };
      writRecords.forEach(function (w) { var st = P.evaluateWrit(w, P.todayUTC(), null).status; if (wsc[st] !== undefined) wsc[st]++; });
      if (writRecords.length) progress.log('ตรวจวันเดือนปีที่ออกหมาย (กรอบ 5–6 เดือน): เฝ้าระวัง ' + wsc.green + ' · เกิน 6 เดือน ' + wsc.red +
        ' · ไม่มีวันออกหมาย ' + noIssue + ' ฉบับ');
      progress.log(writRecords.length
        ? 'แยกรายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา ' + writRecords.length.toLocaleString('th-TH') + ' ฉบับ (ไม่นำไปนับระยะเวลาคดี)'
        : 'ไม่พบไฟล์รายงานคดีอาญาที่มีการออกหมายระหว่างพิจารณา');
      progress.done('writ');

      /* ---- 4. รวมรายการซ้ำ ---- */
      progress.begin('merge', 'ตรวจหาคดีที่ปรากฏซ้ำหลายไฟล์/หลายชีต');
      await sleep(120);
      var merged = P.mergeRecords(allRecords);
      progress.log('คดีไม่ซ้ำ ' + merged.records.length.toLocaleString('th-TH') + ' คดี (รวมรายการซ้ำ ' + merged.duplicates + ' รายการ)');
      progress.log('อ้างอิงวันที่รับฟ้องข้ามไฟล์ (เลขคดีดำตรงกัน): เติมวันที่รับฟ้องให้ ' + merged.filingFilled + ' คดี');
      var lk = P.linkWrits(merged.records, writRecords);
      progress.log('เชื่อมโยงวันเดือนปีที่ออกหมายกับคดี ' + lk.linkedCases + ' คดี' +
        (lk.filledFromWrit ? ' (ใช้วันออกหมายแทนวันที่รับฟ้อง ' + lk.filledFromWrit + ' คดี)' : '') +
        ' · หมายที่ไม่พบคดีในรายงานคดีค้าง ' + lk.writOnly.length + ' คดี (แสดงในรายงานหมายเท่านั้น)');
      progress.done('merge');

      /* ---- 5. จัดประเภท ---- */
      progress.begin('classify', 'ตรวจอักษรย่อ / ช่องจำเลย (พ, พE, รส) / ข้อหาจัดการมรดก');
      var recs = merged.records, n = recs.length, CH = 150;
      if (!n) progress.set(1, 'ไม่มีข้อมูลคดีสำหรับจัดประเภท');
      var cnt = { special: 0, general: 0, other: 0 };
      for (var a = 0; a < n; a += CH) {
        for (var b = a; b < Math.min(n, a + CH); b++) {
          var c = P.classify(recs[b]);
          recs[b].category = c.category; recs[b].window = c.window; recs[b].basis = c.basis;
          cnt[c.category]++;
        }
        progress.set(n ? Math.min(n, a + CH) / n : 1, 'จัดประเภทแล้ว ' + Math.min(n, a + CH).toLocaleString('th-TH') + '/' + n.toLocaleString('th-TH') + ' คดี (พิเศษ ' + cnt.special + ' · ทั่วไป ' + cnt.general + ' · อักษรย่ออื่น ' + cnt.other + ')');
        await tick();
      }
      progress.log('จัดประเภท: คดีจัดการพิเศษ ' + cnt.special + ' / คดีจัดการทั่วไป ' + cnt.general + ' / อักษรย่ออื่น ' + cnt.other);
      progress.done('classify');

      /* ---- 6. ประเมินระยะเวลา ---- */
      progress.begin('evaluate', 'นับระยะเวลาตั้งแต่วันที่รับฟ้อง');
      var today = P.todayUTC();
      var sc = { red: 0, green: 0, normal: 0, done: 0, out: 0, nodate: 0 };
      for (var x = 0; x < n; x += CH) {
        for (var y = x; y < Math.min(n, x + CH); y++) {
          var ev = P.evaluate(recs[y], today);
          recs[y].statusAtProcess = ev.status;
          sc[ev.status]++;
        }
        progress.set(n ? Math.min(n, x + CH) / n : 1, 'ประเมินแล้ว ' + Math.min(n, x + CH).toLocaleString('th-TH') + '/' + n.toLocaleString('th-TH') + ' คดี (เฝ้าระวัง ' + sc.green + ' · เกินกำหนด ' + sc.red + ' · เสร็จสิ้น ' + sc.done + ')');
        await tick();
      }
      progress.log('ผลประเมิน: เกินกำหนด ' + sc.red + ' / เฝ้าระวัง ' + sc.green + ' / ปกติ ' + sc.normal + ' / เสร็จสิ้น ' + sc.done + ' / ไม่มีวันรับฟ้อง ' + sc.nodate);
      progress.done('evaluate');

      /* ---- 7. บันทึก + 8. ลบไฟล์ ---- */
      progress.begin('save', 'กำลังบันทึกไฟล์ข้อมูลบนเซิร์ฟเวอร์');
      var payload = {
        version: 1,
        meta: {
          processedAt: new Date().toISOString(),
          processedDate: P.toISO(today),
          durationMs: new Date() - started,
          files: filesMeta,
          totals: { rows: allRecords.length, cases: n, duplicates: merged.duplicates, category: cnt, status: sc, writs: writRecords.length }
        },
        records: recs,
        writs: { reports: writReports, records: writRecords },
        sheets: sheetsOut
      };
      progress.set(0.2, 'กำลังบีบอัดข้อมูล (gzip)...');
      var packed = await gzipJSON(payload);
      progress.log('บีบอัดข้อมูลแล้ว เหลือ ' + fmtBytes(packed.length));
      if (packed.length > MAX_SAVE_CHARS) throw new Error('ข้อมูลหลังบีบอัดมีขนาด ' + fmtBytes(packed.length) + ' เกินขีดจำกัด 4.3 MB ของเซิร์ฟเวอร์ กรุณาแบ่งนำเข้าไฟล์น้อยลง');
      progress.set(0.5, 'กำลังบันทึกลงฐานข้อมูล...');
      var saved = await postJSON('/data', { data: packed, meta: { processedAt: payload.meta.processedAt, cases: n, writs: writRecords.length, files: filesMeta.length } });
      progress.log('บันทึกผลประมวลผลลงฐานข้อมูลสำเร็จ (' + fmtBytes(saved.bytes) + ')');
      progress.done('save');
      progress.begin('cleanup', 'ล้างไฟล์ Excel ออกจากหน่วยความจำของเบราว์เซอร์');
      loaded.forEach(function (x) { x.buf = null; });
      loaded = [];
      files.length = 0;
      await sleep(150);
      progress.log('ล้างไฟล์ Excel ออกจากหน่วยความจำแล้ว — ไม่มีไฟล์ Excel ถูกจัดเก็บบนเซิร์ฟเวอร์');
      progress.done('cleanup');
      await sleep(400);

      lockSystem(false);
      state.data = payload;
      await loadStaffData();               // การบันทึกของเจ้าหน้าที่ (ปล่อยชั่วคราว / ปรับเกณฑ์ / นำออกจากเกณฑ์) คงอยู่ข้ามการนำเข้า
      buildRows();
      // ตารางเดิมใช้ต่อได้ (clear + add ข้อมูลใหม่) ไม่ต้องทำลายแล้วสร้างใหม่
      if (location.hash !== '#dashboard') location.hash = '#dashboard'; else render();

      swal({
        icon: 'success',
        title: 'ประมวลผลข้อมูลเสร็จสิ้น',
        width: 560,
        html: '<table class="detail-table">' +
          '<tr><th>ไฟล์ที่นำเข้า</th><td>' + fileCount + ' ไฟล์</td></tr>' +
          '<tr><th>แถวข้อมูลที่อ่านได้</th><td>' + allRecords.length.toLocaleString('th-TH') + ' แถว</td></tr>' +
          '<tr><th>คดี (ไม่ซ้ำ)</th><td>' + n.toLocaleString('th-TH') + ' คดี</td></tr>' +
          '<tr><th>คดีจัดการพิเศษ / ทั่วไป / อักษรย่ออื่น</th><td>' + cnt.special + ' / ' + cnt.general + ' / ' + cnt.other + '</td></tr>' +
          '<tr><th>เกินกำหนด</th><td>' + pill('red') + ' ' + sc.red + ' คดี</td></tr>' +
          '<tr><th>เฝ้าระวัง</th><td>' + pill('green') + ' ' + sc.green + ' คดี</td></tr>' +
          '<tr><th>รายงานหมายระหว่างพิจารณา (อาญา)</th><td>' + (writRecords.length ? writRecords.length.toLocaleString('th-TH') + ' ฉบับ (แยกรายงานต่างหาก)' : 'ไม่พบ') + '</td></tr>' +
          '<tr><th>ไฟล์ Excel</th><td>ไม่ถูกจัดเก็บบนเซิร์ฟเวอร์ (ล้างออกจากหน่วยความจำแล้ว)</td></tr>' +
          '</table>',
        confirmButtonText: 'ดูผลการประมวลผล'
      }).then(function () { return maybeShowAlerts(false); });
    } catch (err) {
      var cur = STEPS[progress.stepIdx];
      if (cur) progress.mark(cur.id, 'error');
      progress.log('ผิดพลาด: ' + err.message);
      loaded.forEach(function (x) { x.buf = null; }); loaded = [];
      lockSystem(false);
      swal({
        icon: 'error',
        title: 'ประมวลผลไม่สำเร็จ',
        html: '<div class="text-left text-sm">' + (cur ? '<p>หยุดที่ขั้นตอน: <b>' + esc(cur.label) + '</b></p>' : '') +
          '<p class="mt-2 text-red-700">' + esc(err.message) + '</p>' +
          '<p class="mt-2 text-slate-500">ข้อมูลชุดเดิมยังคงแสดงผลตามปกติ และไฟล์ Excel ไม่ได้ถูกจัดเก็บไว้ที่ใด</p></div>'
      });
    }
  }

  /* ================================================================
   * ปรับเกณฑ์เฝ้าระวังรายคดี (เจ้าหน้าที่)
   * ================================================================ */
  var WINDOW_CHOICES = [
    ['6M', 'เฝ้าระวัง 5 - 6 เดือน'],
    ['12M', 'เฝ้าระวัง 11 - 12 เดือน'],
    ['18M', 'เฝ้าระวัง เกิน 1 ปี แต่ไม่เกิน 1 ปี 6 เดือน']
  ];
  var WINDOW_SHORT = { '6M': '5–6 เดือน', '12M': '11–12 เดือน', '18M': '1 ปี – 1 ปี 6 เดือน' };
  function changeRule(idx) {
    var r = state.rows[idx]; if (!r || state.processing) return;
    var cur = r.ev.window, auto = r.ev.autoWindow;
    var html = '<table class="detail-table mb-3">' +
      '<tr><th>เลขคดีดำ</th><td>' + esc(r.black) + '</td></tr>' +
      '<tr><th>ประเภท</th><td>' + esc(CAT_LABEL[r.ev.category] || '-') + '</td></tr>' +
      '<tr><th>วันที่รับฟ้อง</th><td>' + esc(r.ev.refDate ? P.thaiDate(r.ev.refDate) : 'ไม่มีข้อมูล') + (r.ev.ageText ? ' (' + esc(r.ev.ageText) + ')' : '') + '</td></tr>' +
      '<tr><th>สถานะปัจจุบัน</th><td>' + pill(r.ev.status) + '</td></tr></table>' +
      '<div class="text-left text-sm font-semibold text-gov-800 mb-1">เลือกเกณฑ์เฝ้าระวัง</div><div class="rule-options">' +
      WINDOW_CHOICES.map(function (c) {
        var isCur = c[0] === cur;
        return '<label class="rule-opt' + (isCur ? ' current' : '') + '"><input type="radio" name="ruleWin" value="' + c[0] + '"' +
          (isCur ? ' checked disabled' : '') + '><span>' + esc(c[1]) + '</span>' +
          (isCur ? '<span class="pill pill-cat-general ml-auto">เกณฑ์ปัจจุบัน</span>' : '') +
          (c[0] === auto ? '<span class="text-xs text-slate-500' + (isCur ? '' : ' ml-auto') + '">(เกณฑ์อัตโนมัติ)</span>' : '') + '</label>';
      }).join('') + '</div>' +
      '<div id="rulePreview" class="text-sm text-left mt-3 text-slate-600">เลือกเกณฑ์ใหม่เพื่อดูผลการคำนวณ</div>' +
      (r.ev.status === 'done' ? '<p class="text-xs text-left text-slate-500 mt-2">คดีนี้มีเลขคดีแดง (เสร็จสิ้น) สถานะจะยังคงเป็น "เสร็จสิ้น"</p>' : '');
    var picked = null;
    swal({
      title: 'ปรับเกณฑ์การเฝ้าระวัง', html: html, width: 620,
      showCancelButton: true, cancelButtonText: 'ปิด', confirmButtonText: 'ยืนยันปรับเกณฑ์', reverseButtons: true, focusConfirm: false,
      showLoaderOnConfirm: true,
      didOpen: function () {
        Swal.getConfirmButton().disabled = true;
        document.querySelectorAll('input[name="ruleWin"]').forEach(function (el) {
          el.addEventListener('change', function () {
            picked = el.value;
            Swal.getConfirmButton().disabled = false;
            var ev = P.evaluate(r, state.today, picked === auto ? null : { window: picked });
            $('rulePreview').innerHTML = 'ผลการคำนวณใหม่: ' + pill(ev.status) + ' · ' + esc(ev.windowLabel) +
              (ev.limitDate && ev.status !== 'done' ? '<br>ครบกำหนด ' + esc(P.thaiDate(ev.limitDate)) + ' (' + esc(remainText(ev.daysToLimit)) + ')' : '');
          });
        });
      },
      preConfirm: function () {
        if (!picked) { Swal.showValidationMessage('กรุณาเลือกเกณฑ์ใหม่'); return false; }
        var value = picked === auto ? null : { window: picked, black: r.black, from: auto };
        return storeSet('case_rules', r.key, value)
          .catch(function (err) { Swal.showValidationMessage(err.message); return false; });
      }
    }).then(function (res) {
      if (!res.isConfirmed || !res.value) return;
      if (res.value.item) state.caseRules[r.key] = res.value.item; else delete state.caseRules[r.key];
      buildRows();
      renderMonitor();
      updateBell();
      var nr = state.byKey[r.key];
      var hl = { red: 'ไฮไลต์สีแดง (เกินกำหนด)', green: 'ไฮไลต์สีเขียว (เฝ้าระวัง)', done: 'ไฮไลต์สีฟ้า (เสร็จสิ้น)' }[nr.ev.status] || 'ไม่มีไฮไลต์ (' + STATUS_LABEL[nr.ev.status] + ')';
      swal({ icon: 'success', title: 'ปรับเกณฑ์เรียบร้อย',
        html: '<table class="detail-table"><tr><th>เลขคดีดำ</th><td>' + esc(nr.black) + '</td></tr>' +
          '<tr><th>เกณฑ์</th><td>' + esc(nr.ev.windowLabel) + (nr.ev.overridden ? ' (ปรับโดยเจ้าหน้าที่)' : ' (เกณฑ์อัตโนมัติ)') + '</td></tr>' +
          '<tr><th>สถานะ</th><td>' + pill(nr.ev.status) + '</td></tr><tr><th>ระดับไฮไลต์</th><td>' + esc(hl) + '</td></tr>' +
          (nr.ev.limitDate && nr.ev.status !== 'done' ? '<tr><th>ครบกำหนด</th><td>' + esc(P.thaiDate(nr.ev.limitDate)) + ' (' + esc(remainText(nr.ev.daysToLimit)) + ')</td></tr>' : '') +
          '</table>' + (!state.showAll && nr.ev.status !== 'red' && nr.ev.status !== 'green' ? '<p class="text-xs text-slate-500 mt-2 text-left">คดีนี้ไม่อยู่ในกลุ่มเฝ้าระวังแล้ว จึงไม่แสดงในมุมมองเริ่มต้น — ดูได้ที่ "แสดงผลทั้งหมด"</p>' : '') });
    });
  }

  /* ================================================================
   * หมาย: นำออก / นำกลับ เกณฑ์เฝ้าระวัง
   * ================================================================ */
  function writExcluded(w) { return state.writExclude[w.uid] || null; }
  function writInfoTable(w) {
    return '<table class="detail-table mb-3">' +
      '<tr><th>หมายเลขดำที่</th><td>' + esc(w.black || '-') + '</td></tr>' +
      '<tr><th>เลขที่หมาย</th><td>' + esc(w.writNo || '-') + '</td></tr>' +
      '<tr><th>ผู้ต้องขัง</th><td>' + esc(w.name || '-') + '</td></tr>' +
      '<tr><th>วันเดือนปีที่ออกหมาย</th><td>' + esc(w.issueDate ? P.thaiDate(w.issueDate) : (w.issueDateRaw || 'ไม่มีข้อมูล')) + '</td></tr>' +
      '<tr><th>ข้อหา</th><td>' + esc(w.charge || '-') + '</td></tr></table>';
  }
  function toggleExclude(idx, el) {
    var w = state.writs[idx]; if (!w || state.processing) return;
    if (el && el.type === 'checkbox') el.checked = false;    // ยังไม่ติ๊กจนกว่าจะยืนยัน
    var ex = writExcluded(w);
    swal({
      icon: ex ? 'question' : 'warning',
      title: ex ? 'ยืนยันนำกลับเข้าเกณฑ์เฝ้าระวังหรือไม่ ?' : 'ยืนยันนำออกจากเกณฑ์เฝ้าระวังหรือไม่ ?',
      html: writInfoTable(w) + (ex
        ? '<p class="text-sm text-left">รายการนี้จะกลับไปอยู่ในตารางเฝ้าระวังกรอบ 5–6 เดือน</p>'
        : '<p class="text-sm text-left mb-2">รายการนี้จะถูกแยกไปแสดงในตาราง <b>"ไม่อยู่ในเกณฑ์เฝ้าระวัง"</b> ด้านล่าง และไม่ถูกนับในการแจ้งเตือน</p>' +
          '<input id="exBy" class="swal2-input !m-0 !w-full !text-sm" maxlength="100" placeholder="ชื่อเจ้าหน้าที่ผู้บันทึก (ไม่บังคับ)">' +
          '<textarea id="exNote" class="swal2-textarea !mx-0 !mt-2 !w-full !text-sm" maxlength="500" placeholder="เหตุผล / หมายเหตุ (ไม่บังคับ)"></textarea>'),
      width: 620, showCancelButton: true, cancelButtonText: 'ปิด', reverseButtons: true, focusConfirm: false,
      confirmButtonText: ex ? 'ยืนยันนำกลับ' : 'ยืนยันนำออก', confirmButtonColor: ex ? '#223b63' : '#b42318',
      showLoaderOnConfirm: true,
      preConfirm: function () {
        var value = ex ? null : { by: ($('exBy') || {}).value || '', note: ($('exNote') || {}).value || '', black: w.black || '', writNo: w.writNo || '' };
        return storeSet('writ_exclude', w.uid, value)
          .catch(function (err) { Swal.showValidationMessage(err.message); return false; });
      }
    }).then(function (res) {
      if (!res.isConfirmed || !res.value) return;
      if (res.value.item) state.writExclude[w.uid] = res.value.item; else delete state.writExclude[w.uid];
      evalWrits();
      drawWrits(true);
      updateBell();
      swal({ icon: 'success', title: ex ? 'นำกลับเข้าเกณฑ์เฝ้าระวังแล้ว' : 'นำออกจากเกณฑ์เฝ้าระวังแล้ว',
        text: 'หมายเลขดำที่ ' + (w.black || '-') + ' · เลขที่หมาย ' + (w.writNo || '-') });
    });
  }
  function drawExcluded() {
    var list = state.writs.filter(function (w) { return w.ev.status === 'excluded'; });
    $('exCount').textContent = list.length;
    $('excludedWrap').classList.toggle('hidden', !list.length);
    if (state.exTable) { state.exTable.clear().rows.add(list).draw(); return; }
    if (!list.length) return;
    state.exTable = new DataTable('#tblExcluded', {
      data: list, language: DT_LANG, scrollX: true, pageLength: 10, lengthMenu: [10, 25, 50, 100], order: [[1, 'asc']], autoWidth: false,
      columns: [
        { title: 'ลำดับ', data: 'seq', className: 'text-center', render: function (d, t) { return t === 'sort' || t === 'type' ? (+d || 0) : esc(d); } },
        { title: 'วันเดือนปีที่ออกหมาย', data: 'issueDate', render: function (d, t, w) { if (t === 'sort' || t === 'type') return d || ''; return esc(d ? P.thaiDate(d) : (w.issueDateRaw || '-')); } },
        { title: 'เลขที่หมาย', data: 'writNo', render: function (d) { return '<span class="whitespace-nowrap">' + esc(d || '-') + '</span>'; } },
        { title: 'หมายเลขดำที่', data: 'black', render: function (d) { return '<b class="whitespace-nowrap">' + esc(d || '-') + '</b>'; } },
        { title: 'ชื่อและนามสกุลผู้ต้องขัง', data: 'name', render: function (d) { return '<span class="clip-sm">' + esc(d || '-') + '</span>'; } },
        { title: 'ข้อหา', data: 'charge', render: function (d) { return '<span class="clip">' + esc(d || '-') + '</span>'; } },
        { title: 'นำออกเมื่อ / โดย', data: null, render: function (d, t, w) { var x = writExcluded(w) || {}; return '<span class="clip-sm">' + esc(fmtDateTime(x.at)) + (x.by ? '<br>โดย ' + esc(x.by) : '') + '</span>'; } },
        { title: 'หมายเหตุ', data: null, render: function (d, t, w) { var x = writExcluded(w) || {}; return '<span class="clip">' + esc(x.note || '-') + '</span>'; } },
        { title: '', data: null, orderable: false, searchable: false,
          render: function (d, t, w) { return '<button type="button" class="btn-detail lockable" data-exclude="' + w.idx + '">นำกลับเข้าเกณฑ์</button>'; } }
      ]
    });
  }

  /* ================================================================
   * การแจ้งเตือนรายวัน (ใกล้เกินกำหนด ≤ 1 เดือน / เกินกำหนด)
   *  - แจ้งทุกครั้งที่เปิดหน้า จนกว่าผู้ใช้จะติ๊ก "ไม่ต้องแจ้งเตือนอีกวันนี้"
   *  - จำค่าไว้ในเบราว์เซอร์เครื่องนั้น (localStorage) เฉพาะวันนั้น และข้อมูลชุดนั้น
   * ================================================================ */
  var ALERT_KEY = 'caseMonitor.alertMuted.';
  function alertStamp() {
    return P.toISO(state.today) + '|' + ((state.data && state.data.meta && state.data.meta.processedAt) || '');
  }
  function isMuted(type) {
    try { return localStorage.getItem(ALERT_KEY + type) === alertStamp(); } catch (e) { return false; }
  }
  function setMuted(type) {
    try { localStorage.setItem(ALERT_KEY + type, alertStamp()); } catch (e) { /* เบราว์เซอร์ไม่อนุญาตให้บันทึก */ }
  }
  function remainText(days) {
    if (days == null) return '-';
    if (days > 0) return 'เหลือ ' + days + ' วัน';
    if (days === 0) return 'ครบกำหนดวันนี้';
    return 'เกินมาแล้ว ' + (-days) + ' วัน';
  }
  /** เหลือเวลาไม่เกิน 1 เดือนก่อนวันครบกำหนด */
  function isSoon(ev) { return !ev.soonDate || P.toISO(state.today) >= ev.soonDate; }
  function alertItems() {
    var near = { cases: [], writs: [] }, red = { cases: [], writs: [] };
    state.rows.forEach(function (r) {
      if (r.ev.nowStatus === 'green' && r.ev.daysToLimit > 0 && isSoon(r.ev)) near.cases.push(r);
      if (r.ev.status === 'red') red.cases.push(r);
    });
    state.writs.forEach(function (w) {
      if (w.ev.nowStatus === 'green' && w.ev.daysToLimit > 0 && isSoon(w.ev)) near.writs.push(w);
      if (w.ev.status === 'red') red.writs.push(w);
    });
    var byDays = function (a, b) { return (a.ev.daysToLimit == null ? 1e9 : a.ev.daysToLimit) - (b.ev.daysToLimit == null ? 1e9 : b.ev.daysToLimit); };
    [near, red].forEach(function (g) { g.cases.sort(byDays); g.writs.sort(byDays); });
    return { near: near, red: red };
  }
  function alertCaseTable(list) {
    if (!list.length) return '';
    return '<h3 class="alert-sub">คดีตามรายงานคดีค้าง (' + list.length + ' คดี)</h3><div class="alert-list"><table class="alert-table"><thead><tr>' +
      '<th>#</th><th>เลขคดีดำ</th><th>ประเภท</th><th>วันที่รับฟ้อง</th><th>ครบกำหนด</th><th>ณ วันนี้</th><th>วันนัดต่อไป</th></tr></thead><tbody>' +
      list.map(function (r, i) {
        var forecast = r.ev.status === 'red' && r.ev.nowStatus !== 'red';
        return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(r.black) + '</b></td><td>' + esc(CAT_LABEL[r.ev.category] || '') + '</td>' +
          '<td>' + esc(r.ev.refDate ? P.thaiDate(r.ev.refDate) : '-') + '</td><td>' + esc(r.ev.limitDate ? P.thaiDate(r.ev.limitDate) : '-') + '</td>' +
          '<td class="' + (r.ev.daysToLimit <= 0 ? 'text-red-700 font-semibold' : 'text-amber-700 font-semibold') + '">' + esc(remainText(r.ev.daysToLimit)) +
          (forecast ? '<br><span class="text-xs text-red-700">วันนัดต่อไปเกินกรอบ</span>' : '') + '</td>' +
          '<td>' + esc(r.nextApptDate ? P.thaiDate(r.nextApptDate) : '-') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function alertWritTable(list) {
    if (!list.length) return '';
    return '<h3 class="alert-sub">หมายระหว่างพิจารณา (อาญา) — เทียบวันที่รับฟ้อง → วันออกหมาย กรอบ 5–6 เดือน (' + list.length + ' ฉบับ)</h3><div class="alert-list"><table class="alert-table"><thead><tr>' +
      '<th>#</th><th>หมายเลขดำ</th><th>เลขที่หมาย</th><th>ผู้ต้องขัง</th><th>วันที่รับฟ้อง</th><th>วันออกหมาย</th><th>รับฟ้อง → ออกหมาย</th></tr></thead><tbody>' +
      list.map(function (w, i) {
        return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(w.black || '-') + '</b></td><td>' + esc(w.writNo || '-') + '</td><td>' + esc(w.name || '-') + '</td>' +
          '<td>' + esc(w.ev.filingDate ? P.thaiDate(w.ev.filingDate) : '-') + '</td><td>' + esc(w.issueDate ? P.thaiDate(w.issueDate) : '-') + '</td>' +
          '<td class="' + (w.ev.daysToLimit <= 0 ? 'text-red-700 font-semibold' : 'text-amber-700 font-semibold') + '">' + esc(w.ev.ageText) + '<br><span class="text-xs">' + esc(writGapText(w.ev.daysToLimit)) + '</span></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function showAlert(type, group, force) {
    var total = group.cases.length + group.writs.length;
    if (!total || (!force && isMuted(type))) return Promise.resolve();
    var near = type === 'near';
    var muted = false;
    return swal({
      icon: near ? 'warning' : 'error',
      title: near ? 'แจ้งเตือน: ใกล้เกินกำหนด (เหลือไม่เกิน 1 เดือน)' : 'แจ้งเตือน: เกินกำหนด',
      width: 900,
      html: '<p class="text-sm text-left mb-2">' + (near
        ? 'รายการเฝ้าระวังที่<b>เหลือระยะเวลาน้อยกว่าหรือเท่ากับ 1 เดือน</b>ก่อนจะเกินกำหนด ณ วันที่ ' + esc(P.thaiDate(state.today)) + ' รวม <b>' + total + '</b> รายการ'
        : 'รายการที่<b>เกินกำหนด</b>ตามเกณฑ์ (รวมคดีที่วันนัดต่อไปเกินกรอบระยะเวลา) ณ วันที่ ' + esc(P.thaiDate(state.today)) + ' รวม <b>' + total + '</b> รายการ') +
        '</p>' + alertCaseTable(group.cases) + alertWritTable(group.writs),
      confirmButtonText: 'รับทราบ',
      footer: '<label class="alert-mute"><input type="checkbox" id="alertMute"> ไม่ต้องแจ้งเตือนอีกวันนี้</label>',
      customClass: { footer: 'alert-footer' },
      willClose: function () { var c = $('alertMute'); muted = !!(c && c.checked); }
    }).then(function () { if (muted) setMuted(type); });
  }
  /** force = true: เปิดดูจากปุ่มกระดิ่ง (แสดงแม้ติ๊กปิดไว้แล้ว) */
  function maybeShowAlerts(force) {
    if (!state.data || state.processing) return Promise.resolve();
    var it = alertItems();
    updateBell(it);
    if (force && !(it.near.cases.length + it.near.writs.length + it.red.cases.length + it.red.writs.length)) {
      return swal({ icon: 'success', title: 'ไม่มีรายการที่ต้องแจ้งเตือน', text: 'ไม่พบรายการใกล้เกินกำหนดหรือเกินกำหนด ณ วันนี้' });
    }
    return showAlert('near', it.near, force).then(function () { return showAlert('red', it.red, force); });
  }
  function updateBell(it) {
    it = it || alertItems();
    var n = it.near.cases.length + it.near.writs.length + it.red.cases.length + it.red.writs.length;
    var b = $('bellCount');
    if (b) { b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); }
  }

  /* ================================================================
   * Events
   * ================================================================ */
  window.addEventListener('hashchange', function () { if (!state.processing && state.authed) render(); });
  $('btnImport').addEventListener('click', openUpload);
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('loginBtn'), pw = $('loginPassword');
    btn.disabled = true; btn.textContent = 'กำลังตรวจสอบ...';
    postJSON('/auth', { password: pw.value }).then(function () {
      pw.value = '';
      $('loginError').classList.add('hidden');
      setAuthedUI(true);
      loadData();
    }).catch(function (err) {
      showLogin(err.message);
    }).then(function () { btn.disabled = false; btn.textContent = 'เข้าสู่ระบบ'; });
  });
  $('btnLogout').addEventListener('click', function () {
    if (state.processing) return;
    swal({ icon: 'question', title: 'ออกจากระบบหรือไม่ ?', showCancelButton: true, cancelButtonText: 'ปิด', confirmButtonText: 'ออกจากระบบ', reverseButtons: true })
      .then(function (r) {
        if (!r.isConfirmed) return;
        apiFetch('/auth', { method: 'DELETE' }).catch(function () {}).then(function () {
          state.data = null; state.rows = []; state.writs = [];
          showLogin('');
        });
      });
  });
  $('btnBell').addEventListener('click', function () { if (!state.processing && state.authed) maybeShowAlerts(true); });
  $('emptyUpload').addEventListener('click', openUpload);
  $('btnMenu').addEventListener('click', function () { $('mobileNav').classList.toggle('hidden'); });
  ['fCategory', 'fStatus', 'fPrefix', 'fGroup'].forEach(function (id) {
    $(id).addEventListener('change', function () { state.cardFilter = ''; renderMonitor(); });
  });
  $('btnReset').addEventListener('click', function () {
    var v = VIEWS[state.view] || VIEWS.dashboard;
    $('fCategory').value = v.category; $('fPrefix').value = ''; $('fGroup').value = '';
    state.cardFilter = '';
    state.showAll = false; $('fStatus').value = 'watch';
    applyModeUI();
    if (state.table) state.table.search('');
    renderMonitor();
  });
  $('btnExport').addEventListener('click', exportExcel);
  $('modeWatch').addEventListener('click', function () { setMode(false); });
  $('modeAll').addEventListener('click', function () { setMode(true); });
  ['wFrom', 'wTo', 'wPrefix', 'wPenalty', 'wStatus'].forEach(function (id) { $(id).addEventListener('change', function () { drawWrits(); }); });
  $('writCards').addEventListener('click', function (e) {
    var b = e.target.closest('[data-wcard]'); if (!b) return;
    var k = b.getAttribute('data-wcard');
    $('wStatus').value = $('wStatus').value === k ? '' : k;
    drawWrits();
  });
  $('wReset').addEventListener('click', function () { $('wFrom').value = ''; $('wTo').value = ''; $('wPrefix').value = ''; $('wPenalty').value = ''; $('wStatus').value = ''; if (state.writTable) state.writTable.search(''); drawWrits(); });
  $('wExport').addEventListener('click', exportWrits);
  $('wPrint').addEventListener('click', printWrits);
  $('summaryCards').addEventListener('click', function (e) {
    var b = e.target.closest('[data-card]'); if (!b) return;
    var k = b.getAttribute('data-card');
    var v = VIEWS[state.view] || VIEWS.dashboard;
    if (state.cardFilter === k || !k) {
      state.cardFilter = ''; $('fCategory').value = v.category;
      if (!k) state.showAll = true;                       // การ์ด "คดีทั้งหมด" => แสดงผลทั้งหมด
      $('fStatus').value = state.showAll ? '' : 'watch';
    } else {
      state.cardFilter = k;
      var parts = k.split(':');
      if (parts[0] === 'cat') { $('fCategory').value = parts[1]; $('fStatus').value = state.showAll ? '' : 'watch'; }
      else {
        // เฝ้าระวัง/เกินกำหนด อยู่ในโหมดเริ่มต้นได้ ส่วนสถานะอื่นต้องสลับไป "แสดงผลทั้งหมด"
        if (parts[1] !== 'green' && parts[1] !== 'red') state.showAll = true;
        $('fStatus').value = parts[1] === 'other' ? 'na' : parts[1];
      }
    }
    applyModeUI();
    var keep = state.cardFilter;
    renderMonitor();
    state.cardFilter = keep;
    renderCards();
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-detail]');
    if (b) showDetail(+b.getAttribute('data-detail'));
    var w = e.target.closest('[data-writ]');
    if (w) showWritDetail(+w.getAttribute('data-writ'));
    var bl = e.target.closest('[data-bail]');
    if (bl && !state.processing) toggleBail(+bl.getAttribute('data-bail'));
    var rl = e.target.closest('[data-rule]');
    if (rl && !state.processing) changeRule(+rl.getAttribute('data-rule'));
    var ex = e.target.closest('[data-exclude]');
    if (ex && !state.processing) { if (ex.type === 'checkbox') e.preventDefault(); toggleExclude(+ex.getAttribute('data-exclude'), ex); }
  });
  $('fSheet').addEventListener('change', renderSheetTable);

  // คำนวณสถานะใหม่เมื่อข้ามวัน (กรณีเปิดหน้าทิ้งไว้)
  setInterval(function () {
    if (!state.data || state.processing) return;
    if (P.toISO(P.todayUTC()) !== P.toISO(state.today)) { buildRows(); render(); if (!Swal.isVisible()) maybeShowAlerts(false); }
  }, 60000);

  boot();
})();
