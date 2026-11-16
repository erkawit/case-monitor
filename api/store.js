/**
 * /api/store — การบันทึกของเจ้าหน้าที่ (คงอยู่ข้ามการนำเข้าไฟล์ Excel ชุดใหม่)
 *   GET  ?name=writ_flags|case_rules|writ_exclude   คืน { items: { key: value } }
 *   POST { name, key, value }   value = null เพื่อลบรายการ
 *
 *   writ_flags   : หมายที่ออกหมายปล่อยชั่วคราวแล้ว  { bail: true, by, note, black, writNo }
 *   case_rules   : ปรับเกณฑ์เฝ้าระวังรายคดี         { window: '6M' | '12M' | '18M', black, from }
 *   writ_exclude : หมายที่ไม่อยู่ในเกณฑ์เฝ้าระวัง     { by, note, black, writNo }
 */
'use strict';
const L = require('./_lib');

function hashToObject(arr) {
  const out = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) {
    try { out[arr[i]] = JSON.parse(arr[i + 1]); } catch (e) { /* ข้ามรายการเสีย */ }
  }
  return out;
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!L.guard(req, res, false)) return;
      const name = String(L.query(req).name || '');
      if (!L.STORE_NAMES.includes(name)) return L.fail(res, 400, 'ไม่พบประเภทข้อมูลที่ร้องขอ');
      const items = hashToObject(await L.redis(['HGETALL', L.PREFIX + 'store:' + name]));
      return L.send(res, 200, { ok: true, items: items });
    }

    if (req.method === 'POST') {
      if (!L.guard(req, res, true)) return;
      const b = await L.body(req);
      if (!b) return L.fail(res, 400, 'ข้อมูลไม่ถูกต้อง');
      const name = String(b.name || '');
      if (!L.STORE_NAMES.includes(name)) return L.fail(res, 400, 'ไม่พบประเภทข้อมูลที่ร้องขอ');
      const key = String(b.key || '').trim();
      if (!key || key.length > 200) return L.fail(res, 400, 'รหัสรายการไม่ถูกต้อง');
      const hkey = L.PREFIX + 'store:' + name;

      if (b.value === null || b.value === undefined) {
        await L.redis(['HDEL', hkey, key]);
        return L.send(res, 200, { ok: true, key: key, item: null });
      }
      if (typeof b.value !== 'object' || Array.isArray(b.value)) return L.fail(res, 400, 'ข้อมูลที่บันทึกไม่ถูกต้อง');

      const item = {};
      Object.keys(b.value).forEach((k) => {
        const v = b.value[k];
        if (!/^[a-zA-Z]{1,30}$/.test(k)) return;
        if (typeof v === 'string') item[k] = L.clean(v, 500);
        else if (typeof v === 'number' || typeof v === 'boolean') item[k] = v;
      });
      if (name === 'case_rules' && !['6M', '12M', '18M'].includes(item.window)) return L.fail(res, 400, 'เกณฑ์ที่เลือกไม่ถูกต้อง');
      if (name === 'writ_flags') item.bail = true;
      item.at = new Date().toISOString();
      item.ip = L.clientIp(req);
      await L.redis(['HSET', hkey, key, JSON.stringify(item)]);
      return L.send(res, 200, { ok: true, key: key, item: item });
    }

    res.setHeader('Allow', 'GET, POST');
    return L.fail(res, 405, 'Method not allowed');
  } catch (err) {
    return L.fail(res, err.status || 500, err.message || 'เกิดข้อผิดพลาด');
  }
};
