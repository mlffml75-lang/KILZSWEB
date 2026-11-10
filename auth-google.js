/**
 * KilzsWeb - Login dengan Google (OAuth 2.0 resmi, Authorization Code + PKCE + state)
 *
 *   GET /api/auth-google                       -> mulai: redirect ke Google   (?remember=1 untuk "Keep me signed in")
 *   GET /api/auth-google?code=..&state=..      -> callback dari Google
 *
 * Redirect URI yang harus didaftarkan di Google Cloud Console (persis):
 *   https://<domain-kamu>/api/auth-google
 *
 * Client secret hanya dibaca di server (GOOGLE_CLIENT_SECRET). Browser hanya menerima redirect.
 *
 * Kebijakan penautan akun (anti pengambilalihan):
 *  - Akun sudah tertaut Google (sub sama)            -> langsung masuk.
 *  - Email sama dengan akun yang emailnya TERVERIFIKASI -> tautkan Google, masuk.
 *  - Email sama dengan akun password yang emailnya BELUM terverifikasi (pendaftaran biasa tidak
 *    memverifikasi email) -> Google membuktikan pemilik email, jadi akun ditautkan, password lama
 *    DINONAKTIFKAN dan semua sesi lama dicabut (mencegah orang lain yang lebih dulu mendaftar dengan
 *    email itu tetap memegang akses).
 */
'use strict';

const A = require('../lib/authcore.js');
const { ApiError } = A;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const TIMEOUT_MS = 8000;

const oaName = (req) => (A.isSecure(req) ? '__Host-kz_oa' : 'kz_oa');
const redirectUri = (req) => A.baseUrl(req) + '/api/auth-google';
const back = (res, code) => A.redirect(res, '/#auth=' + code);

function oaCookie(res, req, value, maxAge) {
  const p = [oaName(req) + '=' + value, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + maxAge];
  if (A.isSecure(req)) p.push('Secure');
  A.addCookie(res, p.join('; '));
}

async function start(req, res, sp) {
  const e = A.env();
  if (!A.googleReady()) return back(res, 'err_config');
  try { await A.hit('google-ip', A.clientIp(req), 30, 900); } catch (x) { return back(res, x.code === 'rate_limited' ? 'err_rate' : 'err_server'); }

  const state = A.rand(24);
  const verifier = A.rand(48);                                   // 64 karakter (43–128 sesuai RFC 7636)
  const challenge = A.b64u(require('crypto').createHash('sha256').update(verifier).digest());
  await A.cmd('SET', A.K.oa(state), JSON.stringify({ v: verifier, rem: sp.get('remember') === '1' }), 'EX', 600);
  oaCookie(res, req, state, 600);

  const q = new URLSearchParams({
    client_id: e.gid, redirect_uri: redirectUri(req), response_type: 'code', scope: 'openid email profile',
    state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  });
  return A.redirect(res, AUTH_URL + '?' + q.toString());
}

async function exchange(req, code, verifier) {
  const e = A.env();
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code, client_id: e.gid, client_secret: e.gsecret, redirect_uri: redirectUri(req), grant_type: 'authorization_code', code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (x) { console.error('auth-google: token network error'); throw new ApiError(502, 'google_down', 'x'); }
  let j = null;
  try { j = await r.json(); } catch (x) { /* ditangani */ }
  if (!r.ok || !j || typeof j.access_token !== 'string') { console.error('auth-google: token exchange gagal', r.status, j && j.error); throw new ApiError(502, 'google_token', 'x'); }
  return j.access_token;
}

async function userinfo(accessToken) {
  let r;
  try { r = await fetch(USERINFO_URL, { headers: { authorization: 'Bearer ' + accessToken, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (x) { console.error('auth-google: userinfo network error'); throw new ApiError(502, 'google_down', 'x'); }
  let j = null;
  try { j = await r.json(); } catch (x) { /* ditangani */ }
  if (!r.ok || !j || typeof j.sub !== 'string') { console.error('auth-google: userinfo gagal', r.status); throw new ApiError(502, 'google_userinfo', 'x'); }
  return j;
}

function baseUsername(email, name) {
  let b = String(email || '').split('@')[0].replace(/[^A-Za-z0-9_.]/g, '');
  if (b.length < 3) b = String(name || '').replace(/[^A-Za-z0-9_.]/g, '');
  if (b.length < 3) b = 'user' + b;
  b = b.replace(/^[^A-Za-z0-9]+/, '').slice(0, 14);
  if (A.RESERVED.includes(b.toLowerCase())) b += '1';
  return b.length >= 3 ? b : 'user' + A.rand(3).replace(/[^A-Za-z0-9]/g, 'x').slice(0, 4);
}

/** Cari/buat akun untuk identitas Google. Mengembalikan {user, linkedNote}. */
async function resolveUser(g) {
  const sub = g.sub, email = A.normEmail(g.email);
  const name = String(g.name || '').slice(0, 60);

  const byGoogle = await A.cmd('GET', A.K.g(sub));
  if (byGoogle) { const u = await A.getUser(byGoogle); if (u) return { user: u, note: null }; }

  const byEmail = await A.cmd('GET', A.K.em(email));
  if (byEmail) {
    const u = await A.getUser(byEmail);
    if (u) {
      let note = 'linked';
      if (u.pwHash && !u.emailVerified) {         // email belum terbukti milik pendaftar -> cabut password & sesi lama
        u.pwHash = null;
        await A.destroyAllSessions(u.id);
        note = 'linked_pw_off';
      }
      u.googleSub = sub; u.emailVerified = true;
      if (!u.name) u.name = name || u.username;
      await A.saveUser(u);
      await A.cmd('SET', A.K.g(sub), u.id);
      return { user: u, note };
    }
  }

  const base = baseUsername(email, name);
  for (let i = 0; i < 6; i++) {
    const username = i === 0 ? base : base.slice(0, 14) + String(Math.floor(1000 + Math.random() * 9000));
    try {
      const u = await A.createUser({ username, name: name || username, email, googleSub: sub, emailVerified: true, pwHash: null });
      return { user: u, note: null };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'username_taken') continue;
      throw e;
    }
  }
  throw new ApiError(500, 'username_exhausted', 'x');
}

async function callback(req, res, sp) {
  const cookieState = A.parseCookies(req)[oaName(req)] || '';
  oaCookie(res, req, '', 0);                                      // cookie sekali pakai
  if (sp.get('error')) return back(res, sp.get('error') === 'access_denied' ? 'err_denied' : 'err_google');

  const state = sp.get('state') || '', code = sp.get('code') || '';
  if (!state || !code || !cookieState || !A.safeEqual(state, cookieState) || state.length > 100 || code.length > 2000) return back(res, 'err_state');

  const raw = await A.cmd('GET', A.K.oa(state));
  await A.cmd('DEL', A.K.oa(state));
  if (!raw) return back(res, 'err_state');
  let rec;
  try { rec = JSON.parse(raw); } catch (e) { return back(res, 'err_state'); }

  const token = await exchange(req, code, rec.v);
  const g = await userinfo(token);
  if (g.email_verified !== true || typeof g.email !== 'string' || A.checkEmail(g.email)) return back(res, 'err_email');

  const { user, note } = await resolveUser(g);
  const sess = await A.createSession(user.id, !!rec.rem);
  A.setSessionCookie(res, req, sess.token, sess.remember);
  return back(res, note === 'linked_pw_off' ? 'ok_linked' : 'ok');
}

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); throw new ApiError(405, 'method', 'Metode tidak diizinkan.'); }
    const sp = new URL(req.url, 'http://x').searchParams;
    if (sp.has('code') || sp.has('error') || sp.has('state')) return await callback(req, res, sp);
    return await start(req, res, sp);
  } catch (e) {
    if (e instanceof ApiError && e.status === 405) return A.failJson(res, e);
    if (e instanceof ApiError && (e.code === 'not_configured' || e.code === 'db_unavailable')) return back(res, 'err_server');
    if (e instanceof ApiError && String(e.code).startsWith('google_')) return back(res, 'err_google');
    console.error('auth-google error:', e && e.message ? String(e.message).slice(0, 100) : 'unknown');
    return back(res, 'err_server');
  }
}

module.exports = handler;
