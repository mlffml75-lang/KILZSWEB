/**
 * KilzsWeb - API akun (Vercel Function, Node, CommonJS)
 *
 *   GET  /api/auth?action=me         -> sesi saat ini (user atau null) + fitur yang aktif
 *   POST /api/auth?action=register   -> {username,email,password,remember}
 *   POST /api/auth?action=login      -> {identifier,password,remember}   (email ATAU username)
 *   POST /api/auth?action=logout
 *
 * Tanpa OTP. Login Google ada di api/auth-google.js. Logika bersama ada di lib/authcore.js.
 * Environment Variables: lihat komentar di lib/authcore.js.
 */
'use strict';

const A = require('../lib/authcore.js');
const { ApiError } = A;

async function me(req, res) {
  const features = { google: A.googleReady(), ready: A.dbReady() };
  if (!A.dbReady() || !A.parseCookies(req)[A.sidName(req)]) return A.send(res, 200, { ok: true, user: null, features });
  let s = null;
  try { s = await A.getSession(req); } catch (e) { return A.send(res, 200, { ok: true, user: null, features: { google: features.google, ready: false } }); }
  if (!s) A.clearSessionCookie(res, req);
  return A.send(res, 200, { ok: true, user: s ? A.publicUser(s.user) : null, features });
}

async function register(req, res) {
  A.checkOrigin(req);
  const b = await A.readJson(req);
  const username = String(b.username == null ? '' : b.username).trim();
  const email = A.normEmail(b.email);
  const password = typeof b.password === 'string' ? b.password : '';
  let m;
  if ((m = A.checkUsername(username))) throw new ApiError(400, 'invalid', m, { field: 'username' });
  if ((m = A.checkEmail(email))) throw new ApiError(400, 'invalid', m, { field: 'email' });
  if ((m = A.checkPassword(password))) throw new ApiError(400, 'invalid', m, { field: 'password' });

  await A.hit('register-ip', A.clientIp(req), 6, 3600);
  const pwHash = await A.hashPassword(password);
  const user = await A.createUser({ username, name: username, email, pwHash, emailVerified: false });
  const sess = await A.createSession(user.id, !!b.remember);
  A.setSessionCookie(res, req, sess.token, sess.remember);
  return A.send(res, 201, { ok: true, user: A.publicUser(user) });
}

async function login(req, res) {
  A.checkOrigin(req);
  const b = await A.readJson(req);
  const ident = String(b.identifier == null ? '' : b.identifier).trim();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!ident) throw new ApiError(400, 'invalid', 'Email atau username wajib diisi.', { field: 'identifier' });
  if (!password) throw new ApiError(400, 'invalid', 'Password wajib diisi.', { field: 'password' });
  const GENERIC = 'Email/username atau password salah. Jika kamu mendaftar dengan Google, gunakan tombol Google.';
  if (ident.length > 254 || password.length > 128) throw new ApiError(401, 'invalid_credentials', GENERIC);

  const ip = A.clientIp(req), low = ident.toLowerCase();
  await A.hit('login-ip', ip, 30, 900);
  await A.hit('login-id', low + '|' + ip, 8, 900);

  const key = low.includes('@') ? A.K.em(low) : A.K.un(low);
  const id = await A.cmd('GET', key);
  const user = id ? await A.getUser(id) : null;
  let ok = false;
  if (user && user.pwHash) ok = await A.verifyPassword(password, user.pwHash);
  else await A.burnTime(password);
  if (!ok) throw new ApiError(401, 'invalid_credentials', GENERIC);

  const sess = await A.createSession(user.id, !!b.remember);
  A.setSessionCookie(res, req, sess.token, sess.remember);
  return A.send(res, 200, { ok: true, user: A.publicUser(user) });
}

async function logout(req, res) {
  A.checkOrigin(req);
  if (A.dbReady()) {
    try { const s = await A.getSession(req); if (s) await A.destroySession(s.hash, s.uid); } catch (e) { /* tetap hapus cookie */ }
  }
  A.clearSessionCookie(res, req);
  return A.send(res, 200, { ok: true });
}

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    let action = '';
    try { action = new URL(req.url, 'http://x').searchParams.get('action') || ''; } catch (e) { /* kosong */ }
    if (action === 'me') {
      if (req.method !== 'GET') throw new ApiError(405, 'method', 'Metode tidak diizinkan.');
      return await me(req, res);
    }
    if (req.method !== 'POST') { res.setHeader('allow', 'GET, POST'); throw new ApiError(405, 'method', 'Metode tidak diizinkan.'); }
    if (action === 'register') return await register(req, res);
    if (action === 'login') return await login(req, res);
    if (action === 'logout') return await logout(req, res);
    throw new ApiError(400, 'bad_action', 'Aksi tidak dikenal.');
  } catch (e) { return A.failJson(res, e); }
}

module.exports = handler;
