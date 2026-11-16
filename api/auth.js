/**
 * /api/auth
 *   GET    สถานะการตั้งค่าระบบและการเข้าสู่ระบบ
 *   POST   { password }  เข้าสู่ระบบ (จำกัด 10 ครั้ง / 15 นาที ต่อ IP)
 *   DELETE ออกจากระบบ
 */
'use strict';
const L = require('./_lib');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return L.send(res, 200, {
        ok: true,
        configured: { password: L.passwordConfigured(), storage: L.storageReady() },
        authenticated: L.isAuthed(req)
      });
    }

    if (req.method === 'DELETE') {
      L.setAuthCookie(req, res, '');
      return L.send(res, 200, { ok: true });
    }

    if (req.method === 'POST') {
      if (!L.passwordConfigured()) return L.fail(res, 503, 'ยังไม่ได้ตั้งค่ารหัสผ่าน (APP_PASSWORD)');
      const b = await L.body(req);
      if (!b) return L.fail(res, 400, 'ข้อมูลไม่ถูกต้อง');

      // จำกัดการเดารหัสผ่าน
      const rk = L.PREFIX + 'login:' + L.clientIp(req);
      let tries = 0;
      if (L.storageReady()) {
        tries = Number(await L.redis(['INCR', rk])) || 0;
        if (tries === 1) await L.redis(['EXPIRE', rk, '900']);
        if (tries > 10) return L.fail(res, 429, 'พยายามเข้าสู่ระบบเกินกำหนด กรุณารอ 15 นาทีแล้วลองใหม่');
      }
      if (!L.checkPassword(b.password)) {
        await new Promise((r) => setTimeout(r, 400));
        return L.fail(res, 401, 'รหัสผ่านไม่ถูกต้อง');
      }
      if (L.storageReady()) await L.redis(['DEL', rk]);
      L.setAuthCookie(req, res, L.makeToken());
      return L.send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return L.fail(res, 405, 'Method not allowed');
  } catch (err) {
    return L.fail(res, err.status || 500, err.message || 'เกิดข้อผิดพลาด');
  }
};
