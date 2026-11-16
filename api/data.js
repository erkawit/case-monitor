/**
 * /api/data — ผลการประมวลผลล่าสุด (data text file เดิม)
 *   GET   คืนข้อมูลแบบบีบอัด { exists, encoding: 'gzip-base64', data }
 *   POST  { data: '<gzip-base64>', meta: {...} } บันทึกทับชุดเดิม
 *
 * ไฟล์ Excel ไม่ถูกส่งมาที่เซิร์ฟเวอร์เลย — เบราว์เซอร์อ่านและประมวลผลเอง แล้วส่งเฉพาะผลลัพธ์ที่บีบอัดแล้ว
 */
'use strict';
const L = require('./_lib');
const KEY = L.PREFIX + 'data';
const META = L.PREFIX + 'data:meta';

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!L.guard(req, res, false)) return;
      const data = await L.redis(['GET', KEY]);
      if (!data) return L.send(res, 200, { ok: true, exists: false });
      let meta = null;
      try { meta = JSON.parse((await L.redis(['GET', META])) || 'null'); } catch (e) { meta = null; }
      return L.send(res, 200, { ok: true, exists: true, encoding: 'gzip-base64', meta: meta, data: data });
    }

    if (req.method === 'POST') {
      if (!L.guard(req, res, true)) return;
      const b = await L.body(req);
      if (!b || typeof b.data !== 'string' || !b.data) return L.fail(res, 400, 'ไม่พบข้อมูลผลการประมวลผล');
      if (b.data.length > L.MAX_DATA_CHARS) return L.fail(res, 413, 'ข้อมูลมีขนาดใหญ่เกินกำหนด');
      if (!/^[A-Za-z0-9+/]+=*$/.test(b.data) || !b.data.startsWith('H4sI')) {
        return L.fail(res, 400, 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น gzip-base64)');
      }
      const m = b.meta && typeof b.meta === 'object' ? b.meta : {};
      const meta = {
        savedAt: new Date().toISOString(),
        processedAt: L.clean(m.processedAt, 40),
        cases: Number(m.cases) || 0,
        writs: Number(m.writs) || 0,
        files: Number(m.files) || 0,
        bytes: b.data.length,
        ip: L.clientIp(req)
      };
      await L.redis(['SET', KEY, b.data]);
      await L.redis(['SET', META, JSON.stringify(meta)]);
      return L.send(res, 200, { ok: true, bytes: b.data.length, savedAt: meta.savedAt });
    }

    res.setHeader('Allow', 'GET, POST');
    return L.fail(res, 405, 'Method not allowed');
  } catch (err) {
    return L.fail(res, err.status || 500, err.message || 'เกิดข้อผิดพลาด');
  }
};
