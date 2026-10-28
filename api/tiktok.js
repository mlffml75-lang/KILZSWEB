/**
 * KilzsWeb - TikTok Downloader backend (Vercel Function, Node runtime, CommonJS)
 *
 * Dua mode dalam satu file:
 *   1) GET /api/tiktok?url=<link tiktok>  -> JSON info video + link unduhan bertanda tangan
 *   2) GET /api/tiktok?t=<token>[&dl=1]   -> stream file video (hanya untuk URL yang ditandatangani server ini)
 *
 * Environment Variables (Vercel > Project > Settings > Environment Variables):
 *   SIGNING_SECRET   (WAJIB untuk stream/preview/unduh)  string acak panjang, min 32 karakter
 *   TIKTOK_API_URL   (opsional) endpoint provider, default https://www.tikwm.com/api/
 *
 * CATATAN: provider default (tikwm.com) adalah layanan pihak ketiga tidak resmi.
 * Format responsnya mengikuti yang tercatat di library publik, belum diuji dari sini.
 * Kalau mau ganti provider, ubah fungsi fetchProvider() di bawah.
 */
'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const PROVIDER_URL = process.env.TIKTOK_API_URL || 'https://www.tikwm.com/api/';
const SECRET = process.env.SIGNING_SECRET || '';

const TIMEOUT_PROVIDER_MS = 10000;
const TIMEOUT_RESOLVE_MS = 4000;
const TIMEOUT_MEDIA_MS = 12000;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB
const TOKEN_TTL_S = 15 * 60;
const MAX_REDIRECTS = 3;

// Hanya domain TikTok yang boleh diproses dari input pengguna.
const TT_HOSTS = /^(www\.|m\.|vm\.|vt\.)?tiktok\.com$/i;
const TT_SHORT_HOSTS = /^(vm|vt)\.tiktok\.com$/i;

/* ---------- rate limit sederhana (best effort per instance serverless) ---------- */
const hits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }
  const key = ip + '|' + max;
  let h = hits.get(key);
  if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
  h.n++;
  hits.set(key, h);
  return h.n > max;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------- util URL ---------- */
function isPrivateHost(h) {
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 literal
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true; // IPv4 literal
  return !h.includes('.');
}

/** Validasi URL media: wajib https dan bukan host internal / IP literal. */
function safeMediaUrl(u) {
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  if (x.protocol !== 'https:') return null;
  if (x.username || x.password) return null;
  if (isPrivateHost(x.hostname)) return null;
  if (x.port && x.port !== '443') return null;
  return x;
}

/** Validasi link TikTok dari pengguna. Mengembalikan URL object atau null. */
function parseTikTokUrl(raw) {
  raw = String(raw || '').trim();
  if (!raw || raw.length > 500) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let x;
  try { x = new URL(raw); } catch (e) { return null; }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
  if (x.username || x.password) return null;
  if (!TT_HOSTS.test(x.hostname)) return null;
  x.protocol = 'https:';
  x.port = '';
  const p = x.pathname;
  const ok =
    /^\/@[^/]+\/video\/\d{8,25}\/?$/.test(p) ||   // link lengkap
    /^\/@[^/]+\/photo\/\d{8,25}\/?$/.test(p) ||   // dikenali agar pesan errornya jelas
    /^\/t\/[A-Za-z0-9]+\/?$/.test(p) ||           // tiktok.com/t/xxxx
    /^\/v\/\d{8,25}(\.html)?$/.test(p) ||         // format lama
    (TT_SHORT_HOSTS.test(x.hostname) && /^\/[A-Za-z0-9_-]{4,}\/?$/.test(p)); // vm./vt.
  return ok ? x : null;
}

/** Ikuti redirect link pendek secara manual; tiap hop wajib domain TikTok. */
async function resolveShort(u) {
  const needs = TT_SHORT_HOSTS.test(u.hostname) || /^\/t\//.test(u.pathname);
  if (!needs) return u;
  let cur = u;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    let r;
    try {
      r = await fetch(cur.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_RESOLVE_MS),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; KilzsWeb/1.0)' },
      });
    } catch (e) { return u; }
    try { if (r.body) await r.body.cancel(); } catch (e) { /* abaikan */ }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return u;
      let nx;
      try { nx = new URL(loc, cur); } catch (e) { return u; }
      if (nx.protocol !== 'https:' || !TT_HOSTS.test(nx.hostname)) return u; // tolak hop di luar TikTok
      nx.search = ''; // buang parameter tracking
      nx.hash = '';
      cur = nx;
      if (/^\/@[^/]+\/(video|photo)\/\d+/.test(cur.pathname)) return cur;
    } else {
      return cur;
    }
  }
  return cur;
}

/* ---------- token bertanda tangan ---------- */
const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  if (!SECRET || typeof token !== 'string' || token.length > 4000) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.u !== 'string' || typeof p.e !== 'number' || p.e < Math.floor(Date.now() / 1000)) return null;
  return p;
}

/* ---------- provider ---------- */
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Ganti fungsi ini jika memakai provider lain. Harus mengembalikan objek normal. */
async function fetchProvider(videoUrl) {
  const base = safeMediaUrl(PROVIDER_URL);
  if (!base) throw new ApiError(500, 'config', 'TIKTOK_API_URL tidak valid (harus https).');
  const body = new URLSearchParams({ url: videoUrl, hd: '1' });
  let r;
  try {
    r = await fetch(base.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_PROVIDER_MS),
    });
  } catch (e) {
    throw new ApiError(502, 'provider_down', 'Layanan sumber video tidak bisa dihubungi. Coba lagi nanti.');
  }
  if (r.status === 429) throw new ApiError(429, 'provider_limit', 'Layanan sumber sedang membatasi permintaan. Coba lagi sebentar lagi.');
  if (!r.ok) throw new ApiError(502, 'provider_http', 'Layanan sumber video error (' + r.status + ').');
  let j;
  try { j = JSON.parse((await r.text()).slice(0, 200000)); } catch (e) {
    throw new ApiError(502, 'provider_format', 'Respons layanan sumber tidak bisa dibaca.');
  }
  if (!j || j.code !== 0 || !j.data) {
    const m = String((j && j.msg) || '');
    if (/limit/i.test(m)) throw new ApiError(429, 'provider_limit', 'Layanan sumber sedang membatasi permintaan. Coba lagi sebentar lagi.');
    throw new ApiError(422, 'not_found', 'Video tidak ditemukan. Mungkin privat, dihapus, atau dibatasi wilayah.');
  }
  const d = j.data;
  const abs = (u) => {
    if (!u || typeof u !== 'string') return null;
    try { return new URL(u, base).toString(); } catch (e) { return null; }
  };
  return {
    id: String(d.id || ''),
    title: String(d.title || '').slice(0, 300),
    cover: abs(d.cover || d.origin_cover),
    duration: Number(d.duration) || 0,
    author: d.author ? { name: String(d.author.nickname || '').slice(0, 80), user: String(d.author.unique_id || '').slice(0, 60) } : null,
    stats: { plays: d.play_count, likes: d.digg_count, comments: d.comment_count, shares: d.share_count },
    isPhoto: Array.isArray(d.images) && d.images.length > 0,
    noWm: abs(d.play),
    hd: abs(d.hdplay),
  };
}

/* ---------- handler ---------- */
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}
const fail = (res, e) => {
  if (e instanceof ApiError) return send(res, e.status, { ok: false, code: e.code, error: e.message });
  console.error('tiktok api error:', e && e.message);
  return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
};
function q(req) {
  try { return new URL(req.url, 'http://x').searchParams; } catch (e) { return new URLSearchParams(); }
}

async function handleInfo(req, res, rawUrl) {
  const u = parseTikTokUrl(rawUrl);
  if (!u) throw new ApiError(400, 'bad_url', 'Link tidak valid. Tempel link video TikTok, contoh: https://www.tiktok.com/@user/video/123...');
  if (/\/photo\//.test(u.pathname)) throw new ApiError(422, 'photo', 'Postingan foto/slideshow belum didukung. Hanya video.');
  const target = await resolveShort(u);
  const v = await fetchProvider(target.toString());
  if (v.isPhoto) throw new ApiError(422, 'photo', 'Postingan foto/slideshow belum didukung. Hanya video.');
  if (!v.noWm && !v.hd) throw new ApiError(422, 'no_source', 'Sumber unduhan untuk video ini tidak tersedia.');

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const name = 'tiktok-' + (v.id || Date.now());
  const mk = (url, tag) => (SECRET && safeMediaUrl(url) ? sign({ u: url, e: exp, n: name + (tag || '') }) : null);

  const main = v.noWm || v.hd;
  send(res, 200, {
    ok: true,
    video: {
      id: v.id, title: v.title, cover: v.cover, duration: v.duration, author: v.author, stats: v.stats,
    },
    // token = lewat proxy bertanda tangan (preview + unduh). direct = cadangan jika SIGNING_SECRET belum diset.
    sd: v.noWm ? { token: mk(v.noWm, ''), direct: v.noWm } : null,
    hd: v.hd ? { token: mk(v.hd, '-hd'), direct: v.hd } : null,
    previewToken: mk(main, ''),
    proxy: !!SECRET,
  });
}

async function handleStream(req, res, token, asDownload) {
  if (!SECRET) throw new ApiError(503, 'no_secret', 'SIGNING_SECRET belum diatur di server.');
  const p = verify(token);
  if (!p) throw new ApiError(403, 'bad_token', 'Link unduhan kedaluwarsa. Proses ulang link TikTok-nya.');

  let cur = safeMediaUrl(p.u);
  if (!cur) throw new ApiError(400, 'bad_media', 'Sumber media tidak valid.');

  const headers = { 'user-agent': 'Mozilla/5.0 (compatible; KilzsWeb/1.0)', referer: 'https://www.tiktok.com/' };
  if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) headers.range = req.headers.range;

  let up;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    try {
      up = await fetch(cur.toString(), { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MEDIA_MS) });
    } catch (e) { throw new ApiError(502, 'media_down', 'Gagal mengambil file video dari sumber.'); }
    if (up.status >= 300 && up.status < 400) {
      try { if (up.body) await up.body.cancel(); } catch (e) { /* abaikan */ }
      const loc = up.headers.get('location');
      const nx = loc && safeMediaUrl(new URL(loc, cur).toString());
      if (!nx) throw new ApiError(502, 'media_redirect', 'Sumber media mengalihkan ke alamat yang tidak diizinkan.');
      cur = nx;
      up = null;
      continue;
    }
    break;
  }
  if (!up) throw new ApiError(502, 'media_redirect', 'Terlalu banyak pengalihan.');
  if (!(up.status === 200 || up.status === 206)) {
    try { if (up.body) await up.body.cancel(); } catch (e) { /* abaikan */ }
    throw new ApiError(502, 'media_http', 'Sumber media menolak permintaan (' + up.status + ').');
  }
  const ct = (up.headers.get('content-type') || '').toLowerCase();
  if (!(ct.startsWith('video/') || ct.startsWith('application/octet-stream'))) {
    try { if (up.body) await up.body.cancel(); } catch (e) { /* abaikan */ }
    throw new ApiError(502, 'media_type', 'Sumber bukan file video.');
  }
  const len = Number(up.headers.get('content-length') || 0);
  if (len > MAX_MEDIA_BYTES) {
    try { if (up.body) await up.body.cancel(); } catch (e) { /* abaikan */ }
    throw new ApiError(413, 'too_big', 'File terlalu besar.');
  }

  res.statusCode = up.status;
  res.setHeader('content-type', ct.startsWith('video/') ? ct.split(';')[0] : 'video/mp4');
  res.setHeader('cache-control', 'private, max-age=600');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('accept-ranges', 'bytes');
  if (len) res.setHeader('content-length', String(len));
  const cr = up.headers.get('content-range');
  if (cr) res.setHeader('content-range', cr);
  const safeName = String(p.n || 'tiktok').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  res.setHeader('content-disposition', (asDownload ? 'attachment' : 'inline') + '; filename="' + safeName + '.mp4"');

  let sent = 0;
  const src = Readable.fromWeb(up.body);
  src.on('data', (c) => {
    sent += c.length;
    if (sent > MAX_MEDIA_BYTES) src.destroy(new Error('too big'));
  });
  src.on('error', () => { try { res.destroy(); } catch (e) { /* abaikan */ } });
  res.on('close', () => { try { src.destroy(); } catch (e) { /* abaikan */ } });
  src.pipe(res);
}

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return send(res, 405, { ok: false, code: 'method', error: 'Metode tidak diizinkan.' });
    }
    const sp = q(req);
    const ip = clientIp(req);
    if (sp.has('t')) {
      if (limited(ip, 40, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak permintaan. Tunggu sebentar.');
      return await handleStream(req, res, sp.get('t'), sp.get('dl') === '1');
    }
    if (limited(ip, 12, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak permintaan. Tunggu semenit lalu coba lagi.');
    return await handleInfo(req, res, sp.get('url'));
  } catch (e) {
    if (res.headersSent) { try { res.destroy(); } catch (x) { /* abaikan */ } return; }
    return fail(res, e);
  }
}

module.exports = handler;
module.exports.__test = { parseTikTokUrl, safeMediaUrl, resolveShort, sign, verify, isPrivateHost };
