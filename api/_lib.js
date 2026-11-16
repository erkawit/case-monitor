/**
 * _lib.js — โค้ดใช้ร่วมของ Vercel Functions (ไฟล์ที่ขึ้นต้นด้วย _ จะไม่ถูกสร้างเป็น endpoint)
 *
 * ฐานข้อมูล: Upstash Redis ผ่าน REST API (ไม่ต้องติดตั้ง package เพิ่ม)
 *   - เชื่อมต่อจาก Vercel Marketplace จะได้ตัวแปร KV_REST_API_URL / KV_REST_API_TOKEN อัตโนมัติ
 *   - หรือกำหนดเองเป็น UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * การเข้าใช้งาน: รหัสผ่านเดียว (APP_PASSWORD) + คุกกี้ลงลายมือชื่อ HMAC (HttpOnly, SameSite=Strict)
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** หาค่าตัวแปรตามชื่อ — รองรับชื่อที่ Vercel เติมคำนำหน้าให้ (เช่น STORAGE_KV_REST_API_URL) */
function envBySuffix(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  const keys = Object.keys(process.env);
  for (const n of names) {
    const k = keys.find((x) => x.endsWith('_' + n) && process.env[x]);
    if (k) return process.env[k];
  }
  return '';
}
const KV_URL = envBySuffix(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const KV_TOKEN = envBySuffix(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);
const PREFIX = process.env.CM_KEY_PREFIX || 'cm:';
// ใช้เฉพาะตอนพัฒนาบนเครื่อง (scripts/dev-server.js ตั้งค่าให้) — บน Vercel ต้องใช้ Redis เสมอ
const LOCAL_STORE = process.env.CM_LOCAL_STORE || '';

const COOKIE = 'cm_auth';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const STORE_NAMES = ['writ_flags', 'case_rules', 'writ_exclude'];
const MAX_DATA_CHARS = 4300000; // < 4.5 MB (ขีดจำกัด request body ของ Vercel Functions)

/* ------------------------------------------------------------------ */
/* Redis                                                              */
/* ------------------------------------------------------------------ */
function storageReady() { return !!(KV_URL && KV_TOKEN) || !!LOCAL_STORE; }

async function redis(cmd) {
  if (KV_URL && KV_TOKEN) {
    const r = await fetch(KV_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd)
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok || !j || j.error) throw new Error('ฐานข้อมูลตอบกลับผิดพลาด: ' + ((j && j.error) || ('HTTP ' + r.status)));
    return j.result;
  }
  if (LOCAL_STORE) return localRedis(cmd);
  const e = new Error('ยังไม่ได้เชื่อมต่อฐานข้อมูล (KV_REST_API_URL / KV_REST_API_TOKEN)');
  e.status = 503;
  throw e;
}

/** จำลองคำสั่ง Redis ที่ระบบใช้ ลงไฟล์ JSON — สำหรับทดสอบบนเครื่องเท่านั้น */
function localRedis(cmd) {
  const file = path.join(LOCAL_STORE, 'redis.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = {}; }
  const [op, key, ...a] = cmd.map(String);
  const now = Date.now();
  if (db[key] && db[key].exp && db[key].exp < now) delete db[key];
  let out = null;
  switch (op.toUpperCase()) {
    case 'GET': out = db[key] && typeof db[key].v === 'string' ? db[key].v : null; break;
    case 'SET': db[key] = { v: a[0] }; out = 'OK'; break;
    case 'DEL': out = db[key] ? 1 : 0; delete db[key]; break;
    case 'HGETALL': out = db[key] ? Object.entries(db[key].h).flat() : []; break;
    case 'HSET': db[key] = db[key] || { h: {} }; db[key].h[a[0]] = a[1]; out = 1; break;
    case 'HDEL': out = db[key] && db[key].h[a[0]] !== undefined ? 1 : 0; if (db[key]) delete db[key].h[a[0]]; break;
    case 'INCR': db[key] = db[key] || { v: '0' }; db[key].v = String(Number(db[key].v) + 1); out = Number(db[key].v); break;
    case 'EXPIRE': if (db[key]) db[key].exp = now + Number(a[0]) * 1000; out = 1; break;
    default: throw new Error('local store: unsupported ' + op);
  }
  fs.mkdirSync(LOCAL_STORE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db));
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers (ใช้ได้ทั้งบน Vercel และ Node http ธรรมดา)                 */
/* ------------------------------------------------------------------ */
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(obj));
}
function fail(res, status, message) { send(res, status, { ok: false, message: message }); }

function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const q = {};
  new URL(req.url, 'http://localhost').searchParams.forEach((v, k) => { q[k] = v; });
  return q;
}
async function body(req) {
  let b = req.body;
  if (b === undefined) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { try { return b ? JSON.parse(b) : {}; } catch (e) { return null; } }
  return b && typeof b === 'object' ? b : {};
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}
function clean(v, n) { return String(v == null ? '' : v).replace(/<[^>]*>/g, '').trim().slice(0, n); }

/* ------------------------------------------------------------------ */
/* Auth                                                               */
/* ------------------------------------------------------------------ */
function passwordConfigured() { return !!process.env.APP_PASSWORD; }
function secret() {
  return process.env.AUTH_SECRET || crypto.createHash('sha256').update('case-monitor|' + (process.env.APP_PASSWORD || '')).digest('hex');
}
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('base64url'); }
function makeToken() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return exp + '.' + sign('v1|' + exp);
}
function readCookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
function isAuthed(req) {
  if (!passwordConfigured()) return false;
  const t = readCookie(req, COOKIE);
  const i = t.indexOf('.');
  if (i < 1) return false;
  const exp = Number(t.slice(0, i));
  if (!exp || exp < Date.now()) return false;
  const a = Buffer.from(t.slice(i + 1)), b = Buffer.from(sign('v1|' + exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPassword(pw) {
  const a = crypto.createHash('sha256').update(String(pw || '')).digest();
  const b = crypto.createHash('sha256').update(String(process.env.APP_PASSWORD || '')).digest();
  return passwordConfigured() && crypto.timingSafeEqual(a, b);
}
function isLocalHost(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(req.headers.host || '')); }
function setAuthCookie(req, res, token) {
  const secure = isLocalHost(req) ? '' : '; Secure';
  const maxAge = token ? SESSION_HOURS * 3600 : 0;
  res.setHeader('Set-Cookie', COOKIE + '=' + (token || '') + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure);
}

/**
 * ตรวจสิทธิ์ก่อนเข้าถึงข้อมูล — คืนค่า true เมื่อผ่าน (ถ้าไม่ผ่านจะตอบกลับให้เรียบร้อยแล้ว)
 * write = true: ตรวจ header ป้องกัน CSRF เพิ่ม (คำขอข้ามเว็บไซต์ตั้ง header เองไม่ได้)
 */
function guard(req, res, write) {
  if (!passwordConfigured()) { fail(res, 503, 'ยังไม่ได้ตั้งค่ารหัสผ่าน (APP_PASSWORD)'); return false; }
  if (!storageReady()) { fail(res, 503, 'ยังไม่ได้เชื่อมต่อฐานข้อมูล (KV_REST_API_URL / KV_REST_API_TOKEN)'); return false; }
  if (!isAuthed(req)) { fail(res, 401, 'กรุณาเข้าสู่ระบบ'); return false; }
  if (write && req.headers['x-cm-request'] !== '1') { fail(res, 403, 'คำขอไม่ถูกต้อง'); return false; }
  return true;
}

module.exports = {
  PREFIX, STORE_NAMES, MAX_DATA_CHARS,
  redis, storageReady, send, fail, query, body, clientIp, clean,
  passwordConfigured, isAuthed, checkPassword, makeToken, setAuthCookie, guard
};
