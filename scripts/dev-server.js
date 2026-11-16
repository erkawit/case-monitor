/**
 * เซิร์ฟเวอร์ทดสอบบนเครื่อง (จำลอง Vercel): node scripts/dev-server.js
 *   - เสิร์ฟไฟล์หน้าเว็บ + เรียก api/*.js แบบเดียวกับ Vercel Functions
 *   - ถ้าไม่ได้ตั้ง KV_REST_API_URL จะเก็บข้อมูลในโฟลเดอร์ .data/ แทน (ใช้ทดสอบเท่านั้น)
 *   - รหัสผ่านทดสอบ: APP_PASSWORD (ค่าเริ่มต้น "dev")
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) process.env.CM_LOCAL_STORE = path.join(ROOT, '.data');
if (!process.env.APP_PASSWORD) process.env.APP_PASSWORD = 'dev';
const PORT = Number(process.env.PORT || 3000);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const BLOCK = /^\/(api|scripts|\.data|\.git|node_modules)(\/|$)|\/\.|\.(xls|xlsx)$/i;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (m && !m[1].startsWith('_')) {
    const file = path.join(ROOT, 'api', m[1] + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    try { return await require(file)(req, res); }
    catch (e) { res.statusCode = 500; return res.end(String(e && e.stack || e)); }
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (BLOCK.test(p)) { res.statusCode = 404; return res.end('not found'); }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log('Case Monitor dev server: http://localhost:' + PORT + '  (รหัสผ่านทดสอบ: ' + process.env.APP_PASSWORD + ')');
  console.log(process.env.CM_LOCAL_STORE ? 'ที่เก็บข้อมูล: ' + process.env.CM_LOCAL_STORE + ' (ไฟล์ทดสอบ)' : 'ที่เก็บข้อมูล: Upstash Redis');
});
