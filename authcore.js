/**
 * KilzsWeb - inti autentikasi (dipakai oleh api/auth.js dan api/auth-google.js)
 *
 * - Penyimpanan  : Upstash Redis lewat REST (fetch biasa, tanpa dependensi npm).
 * - Password     : scrypt bawaan Node (salt acak per akun), perbandingan waktu-konstan.
 * - Sesi         : token acak 256-bit di cookie HttpOnly; server hanya menyimpan HASH SHA-256 token.
 * - CSRF         : cookie SameSite=Lax + pemeriksaan Origin/Sec-Fetch-Site pada setiap POST.
 * - Rate limit   : penghitung Redis (per IP dan per identitas) untuk login/daftar.
 *
 * Environment Variables:
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (atau KV_REST_API_URL / KV_REST_API_TOKEN)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET             (untuk Login Google)
 *   SITE_URL  mis. https://kilzsweb.vercel.app          (disarankan; dipakai untuk redirect URI & cookie Secure)
 */
'use strict';

const crypto = require('crypto');

const SESSION_REMEMBER_S = 30 * 86400;   // "Keep me signed in"
const SESSION_SHORT_S = 12 * 3600;       // tanpa centang
const COOKIE_PLAIN = 'kz_sid';
const COOKIE_SECURE = '__Host-kz_sid';
const RESERVED = ['admin', 'administrator', 'root', 'system', 'support', 'moderator', 'kilzsweb', 'owner'];

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

/* ---------- konfigurasi ---------- */
function env() {
  return {
    redisUrl: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim(),
    redisToken: (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim(),
    gid: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    gsecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    site: (process.env.SITE_URL || '').trim().replace(/\/+$/, ''),
  };
}
const dbReady = () => { const e = env(); return !!(e.redisUrl && e.redisToken); };
const googleReady = () => { const e = env(); return !!(e.gid && e.gsecret) && dbReady(); };

/* ---------- kunci Redis ---------- */
const K = {
  u: (id) => 'kz:u:' + id, un: (n) => 'kz:un:' + n, em: (e) => 'kz:em:' + e, g: (s) => 'kz:g:' + s,
  s: (h) => 'kz:s:' + h, us: (id) => 'kz:us:' + id, rl: (k, h) => 'kz:rl:' + k + ':' + h, oa: (s) => 'kz:oa:' + s,
};

/* ---------- Redis REST ---------- */
function dbErr() { return new ApiError(503, 'db_unavailable', 'Layanan akun sedang tidak tersedia. Coba lagi nanti.'); }
async function rpc(path, body) {
  const e = env();
  if (!e.redisUrl || !e.redisToken) throw new ApiError(503, 'not_configured', 'Fitur akun belum dikonfigurasi di server.');
  let r;
  try {
    r = await fetch(e.redisUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + e.redisToken, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
  } catch (x) { console.error('auth: redis network error'); throw dbErr(); }
  let j;
  try { j = await r.json(); } catch (x) { console.error('auth: redis bad json'); throw dbErr(); }
  if (!r.ok || (j && !Array.isArray(j) && j.error)) { console.error('auth: redis status', r.status); throw dbErr(); }
  return j;
}
async function cmd(...args) { return (await rpc('', args)).result; }
async function pipe(cmds) {
  const j = await rpc('/pipeline', cmds);
  return j.map((x) => { if (x && x.error) { console.error('auth: redis pipeline error'); throw dbErr(); } return x.result; });
}

/* ---------- util ---------- */
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const rand = (n) => crypto.randomBytes(n).toString('base64url');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function clientIp(req) {
  const h = req.headers || {};
  const xf = String(h['x-real-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function hostOf(req) { return String((req.headers['x-forwarded-host'] || req.headers.host || '')).split(',')[0].trim(); }
function isSecure(req) {
  const site = env().site;
  if (site) return site.startsWith('https://');
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function baseUrl(req) {
  const site = env().site;
  if (site) return site;
  return (isSecure(req) ? 'https://' : 'http://') + hostOf(req);
}

/* ---------- respons ---------- */
function send(res, status, obj, headers) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (headers) for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
  res.end(JSON.stringify(obj));
}
function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.setHeader('cache-control', 'no-store');
  res.end();
}
function failJson(res, e) {
  if (e instanceof ApiError) {
    const h = e.extra && e.extra.retryAfter ? { 'retry-after': String(e.extra.retryAfter) } : null;
    return send(res, e.status, { ok: false, code: e.code, error: e.message, field: (e.extra && e.extra.field) || undefined }, h);
  }
  console.error('auth error:', e && e.message ? String(e.message).slice(0, 120) : 'unknown');
  return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
}

/* ---------- body & CSRF ---------- */
async function readJson(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().includes('application/json')) throw new ApiError(415, 'bad_content_type', 'Permintaan tidak valid.');
  let b = req.body;
  if (b === undefined) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 10000) throw new ApiError(413, 'too_big', 'Permintaan terlalu besar.'); chunks.push(c); }
    b = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { throw new ApiError(400, 'bad_json', 'Permintaan tidak valid.'); } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'bad_json', 'Permintaan tidak valid.');
  return b;
}
function checkOrigin(req) {
  const allowed = new Set([hostOf(req)]);
  const site = env().site;
  if (site) { try { allowed.add(new URL(site).host); } catch (e) { /* abaikan */ } }
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch (e) { throw new ApiError(403, 'bad_origin', 'Permintaan ditolak.'); }
    if (!allowed.has(host)) throw new ApiError(403, 'bad_origin', 'Permintaan ditolak.');
  } else if (String(req.headers['sec-fetch-site'] || '') !== 'same-origin') {
    throw new ApiError(403, 'bad_origin', 'Permintaan ditolak.');
  }
}

/* ---------- cookie ---------- */
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function addCookie(res, line) {
  const cur = res.getHeader ? res.getHeader('set-cookie') : null;
  const list = cur ? (Array.isArray(cur) ? cur.slice() : [cur]) : [];
  list.push(line);
  res.setHeader('set-cookie', list);
}
const sidName = (req) => (isSecure(req) ? COOKIE_SECURE : COOKIE_PLAIN);
function setSessionCookie(res, req, token, remember) {
  const p = [sidName(req) + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isSecure(req)) p.push('Secure');
  if (remember) p.push('Max-Age=' + SESSION_REMEMBER_S);
  addCookie(res, p.join('; '));
}
function clearSessionCookie(res, req) {
  const p = [sidName(req) + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) p.push('Secure');
  addCookie(res, p.join('; '));
}

/* ---------- validasi ---------- */
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.]{2,19}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,189}\.[A-Za-z]{2,24}$/;
function normEmail(v) { return String(v || '').trim().toLowerCase(); }
function checkUsername(v) {
  const u = String(v == null ? '' : v).trim();
  if (!u) return 'Username wajib diisi.';
  if (!USERNAME_RE.test(u)) return 'Username 3–20 karakter: huruf, angka, titik, atau garis bawah.';
  if (RESERVED.includes(u.toLowerCase())) return 'Username ini tidak tersedia.';
  return null;
}
function checkEmail(v) {
  const e = normEmail(v);
  if (!e) return 'Email wajib diisi.';
  if (e.length > 254 || !EMAIL_RE.test(e) || e.includes('..')) return 'Format email tidak valid.';
  return null;
}
function checkPassword(v) {
  if (typeof v !== 'string' || !v) return 'Password wajib diisi.';
  if (v.length < 8) return 'Password minimal 8 karakter.';
  if (v.length > 128) return 'Password maksimal 128 karakter.';
  if (!/[A-Za-z]/.test(v) || !/\d/.test(v)) return 'Password harus berisi huruf dan angka.';
  return null;
}

/* ---------- password (scrypt) ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, len: 64 };
function scrypt(pw, salt, o) {
  return new Promise((res, rej) => crypto.scrypt(String(pw).normalize('NFKC'), salt, o.len, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const k = await scrypt(pw, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), k.toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const o = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), len: 64 };
  if (!(o.N >= 1024 && o.N <= 1 << 17 && o.r >= 1 && o.r <= 16 && o.p >= 1 && o.p <= 4)) return false;
  const salt = Buffer.from(parts[4], 'base64'), want = Buffer.from(parts[5], 'base64');
  let got;
  try { got = await scrypt(pw, salt, o); } catch (e) { return false; }
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
let dummyHash = null;
async function burnTime(pw) {            // samakan waktu respons saat akun tidak ada (anti enumerasi)
  if (!dummyHash) dummyHash = await hashPassword(rand(12));
  await verifyPassword(pw, dummyHash);
}

/* ---------- rate limit ---------- */
async function hit(kind, who, limit, windowSec) {
  const key = K.rl(kind, sha256hex(who).slice(0, 24));
  const r = await pipe([['SET', key, 0, 'EX', windowSec, 'NX'], ['INCR', key], ['TTL', key]]);
  const n = Number(r[1]), ttl = Number(r[2]);
  if (n > limit) throw new ApiError(429, 'rate_limited', 'Terlalu banyak percobaan. Coba lagi beberapa saat lagi.', { retryAfter: ttl > 0 ? ttl : windowSec });
  return n;
}

/* ---------- pengguna ---------- */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, name: u.name || u.username, email: u.email,
    providers: [u.pwHash ? 'password' : null, u.googleSub ? 'google' : null].filter(Boolean),
    emailVerified: !!u.emailVerified, role: u.role || 'user', createdAt: u.createdAt,
  };
}
async function getUser(id) {
  if (!id) return null;
  const raw = await cmd('GET', K.u(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function saveUser(u) { await cmd('SET', K.u(u.id), JSON.stringify(u)); }

/** Buat akun baru. Menjamin keunikan username & email lewat SET NX; rollback bila gagal. */
async function createUser(data) {
  const id = crypto.randomBytes(12).toString('hex');
  const user = Object.assign({ id, role: 'user', createdAt: Date.now(), emailVerified: false, pwHash: null, googleSub: null }, data);
  const ukey = K.un(user.username.toLowerCase()), ekey = K.em(user.email);
  const gotU = await cmd('SET', ukey, id, 'NX');
  if (gotU !== 'OK') throw new ApiError(409, 'username_taken', 'Username sudah dipakai.', { field: 'username' });
  let gotE;
  try { gotE = await cmd('SET', ekey, id, 'NX'); } catch (e) { await cmd('DEL', ukey).catch(() => {}); throw e; }
  if (gotE !== 'OK') {
    await cmd('DEL', ukey).catch(() => {});
    throw new ApiError(409, 'email_taken', 'Email sudah terdaftar. Coba masuk, atau pakai email lain.', { field: 'email' });
  }
  try {
    await saveUser(user);
    if (user.googleSub) await cmd('SET', K.g(user.googleSub), id);
  } catch (e) { await pipe([['DEL', ukey], ['DEL', ekey]]).catch(() => {}); throw e; }
  return user;
}

/* ---------- sesi ---------- */
async function createSession(uid, remember) {
  const token = rand(32);
  const h = sha256hex(token);
  const ttl = remember ? SESSION_REMEMBER_S : SESSION_SHORT_S;
  await pipe([
    ['SET', K.s(h), JSON.stringify({ uid, rem: !!remember, iat: Date.now() }), 'EX', ttl],
    ['SADD', K.us(uid), h],
    ['EXPIRE', K.us(uid), SESSION_REMEMBER_S],
  ]);
  return { token, remember: !!remember };
}
async function getSession(req) {
  const tok = parseCookies(req)[sidName(req)];
  if (!tok || !/^[A-Za-z0-9_-]{43}$/.test(tok)) return null;
  const hash = sha256hex(tok);
  const raw = await cmd('GET', K.s(hash));
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch (e) { return null; }
  const user = await getUser(s.uid);
  if (!user) return null;
  return { hash, uid: s.uid, remember: !!s.rem, user };
}
async function destroySession(hash, uid) { await pipe([['DEL', K.s(hash)], ['SREM', K.us(uid), hash]]); }
async function destroyAllSessions(uid) {
  const list = (await cmd('SMEMBERS', K.us(uid))) || [];
  const c = list.map((h) => ['DEL', K.s(h)]);
  c.push(['DEL', K.us(uid)]);
  await pipe(c);
}

module.exports = {
  ApiError, env, dbReady, googleReady, K, cmd, pipe, sha256hex, b64u, rand, safeEqual, clientIp, hostOf, isSecure, baseUrl,
  send, redirect, failJson, readJson, checkOrigin, parseCookies, addCookie, sidName, setSessionCookie, clearSessionCookie,
  normEmail, checkUsername, checkEmail, checkPassword, hashPassword, verifyPassword, burnTime, hit,
  publicUser, getUser, saveUser, createUser, createSession, getSession, destroySession, destroyAllSessions,
  RESERVED, USERNAME_RE,
};
