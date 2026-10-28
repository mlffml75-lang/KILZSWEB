/**
 * KilzsWeb - Spotify Search backend (Vercel Function, Node runtime, CommonJS)
 *
 *   GET /api/spotify?q=<judul atau artis>[&offset=0]
 *
 * Auth: Spotify "Client Credentials" flow (data katalog publik, tanpa login pengguna).
 * Client secret HANYA dibaca di server dari Environment Variables:
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *
 * Catatan batas Spotify (per dokumen migrasi Spotify Februari 2026):
 *   - /v1/search: limit maksimum 10 (default 5) untuk app Development Mode.
 *   - Pemilik app Development Mode wajib punya Spotify Premium aktif.
 * Fitur ini tidak mengambil atau mengunduh audio; pemutaran memakai embed resmi Spotify di frontend.
 */
'use strict';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const PAGE_SIZE = 10;
const MAX_OFFSET = 90;     // total maksimal 100 hasil per pencarian
const MAX_QUERY = 100;
const TIMEOUT_MS = 8000;

/* ---------- token cache (hidup selama instance serverless masih hangat) ---------- */
let cached = null;   // { value, exp }
let pending = null;  // Promise agar request bersamaan hanya minta 1 token

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

function cfg() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) {
    console.error('spotify: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET belum diatur');
    throw new ApiError(503, 'not_configured', 'Fitur Spotify belum dikonfigurasi di server.');
  }
  return { id, secret };
}

async function requestToken() {
  const { id, secret } = cfg();
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ApiError(502, 'spotify_down', 'Tidak bisa menghubungi Spotify. Coba lagi nanti.');
  }
  if (r.status === 429) throw new ApiError(429, 'spotify_limit', 'Spotify sedang membatasi permintaan. Coba lagi sebentar lagi.');
  if (r.status === 400 || r.status === 401) {
    console.error('spotify: kredensial ditolak (' + r.status + ')');
    throw new ApiError(503, 'bad_credentials', 'Kredensial Spotify di server salah. Hubungi pemilik website.');
  }
  if (!r.ok) throw new ApiError(502, 'spotify_http', 'Spotify error (' + r.status + ').');
  let j;
  try { j = await r.json(); } catch (e) { throw new ApiError(502, 'spotify_format', 'Respons Spotify tidak bisa dibaca.'); }
  if (!j || typeof j.access_token !== 'string') throw new ApiError(502, 'spotify_format', 'Respons Spotify tidak valid.');
  const ttl = Math.max(60, Number(j.expires_in) || 3600);
  cached = { value: j.access_token, exp: Date.now() + (ttl - 60) * 1000 };
  return cached.value;
}

async function getToken(force) {
  if (!force && cached && cached.exp > Date.now()) return cached.value;
  if (!pending) pending = requestToken().finally(() => { pending = null; });
  return pending;
}

/* ---------- pencarian ---------- */
const SP_ID = /^[A-Za-z0-9]{22}$/;

function pickCover(images) {
  if (!Array.isArray(images) || !images.length) return null;
  // Spotify mengurutkan dari yang terbesar; ambil ukuran sedang (~300px) bila ada.
  const im = images[1] || images[0];
  return im && typeof im.url === 'string' && im.url.startsWith('https://') ? im.url : null;
}

function normalize(item) {
  if (!item || typeof item.id !== 'string' || !SP_ID.test(item.id)) return null;
  const artists = Array.isArray(item.artists) ? item.artists.map((a) => a && a.name).filter(Boolean) : [];
  const ext = item.external_urls && item.external_urls.spotify;
  return {
    id: item.id,
    name: String(item.name || '').slice(0, 200),
    artists: artists.join(', ').slice(0, 200),
    album: String((item.album && item.album.name) || '').slice(0, 200),
    cover: pickCover(item.album && item.album.images),
    url: typeof ext === 'string' && ext.startsWith('https://open.spotify.com/') ? ext : 'https://open.spotify.com/track/' + item.id,
    durationMs: Number(item.duration_ms) || 0,
    explicit: !!item.explicit,
  };
}

async function search(q, offset, retried) {
  const token = await getToken(!!retried);
  const url = SEARCH_URL + '?' + new URLSearchParams({ q, type: 'track', limit: String(PAGE_SIZE), offset: String(offset) });
  let r;
  try {
    r = await fetch(url, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ApiError(502, 'spotify_down', 'Tidak bisa menghubungi Spotify. Coba lagi nanti.');
  }
  if (r.status === 401 && !retried) { cached = null; return search(q, offset, true); }
  if (r.status === 429) {
    const ra = Number(r.headers.get('retry-after')) || 0;
    throw new ApiError(429, 'spotify_limit', 'Spotify sedang membatasi permintaan. Coba lagi sebentar lagi.', { retryAfter: ra });
  }
  if (r.status === 403) {
    console.error('spotify: 403 dari /search (cek Premium pemilik app / mode Development)');
    throw new ApiError(503, 'forbidden', 'Akses Spotify ditolak. Hubungi pemilik website.');
  }
  if (r.status === 400) throw new ApiError(400, 'bad_query', 'Kata kunci tidak bisa diproses. Coba kata lain.');
  if (!r.ok) throw new ApiError(502, 'spotify_http', 'Spotify error (' + r.status + ').');
  let j;
  try { j = await r.json(); } catch (e) { throw new ApiError(502, 'spotify_format', 'Respons Spotify tidak bisa dibaca.'); }
  const t = j && j.tracks;
  if (!t || !Array.isArray(t.items)) throw new ApiError(502, 'spotify_format', 'Respons Spotify tidak valid.');
  const tracks = t.items.map(normalize).filter(Boolean);
  const total = Number(t.total) || 0;
  const next = offset + t.items.length;
  return { tracks, total, hasMore: next < total && next <= MAX_OFFSET, nextOffset: next };
}

/* ---------- rate limit sederhana (best effort per instance) ---------- */
const hits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  let h = hits.get(ip);
  if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
  h.n++;
  hits.set(ip, h);
  return h.n > max;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ---------- handler ---------- */
function send(res, status, obj, cache) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache || 'no-store');
  res.end(JSON.stringify(obj));
}

function parseInput(url) {
  let sp;
  try { sp = new URL(url, 'http://x').searchParams; } catch (e) { sp = new URLSearchParams(); }
  const q = String(sp.get('q') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) throw new ApiError(400, 'empty', 'Ketik judul lagu atau nama artis dulu.');
  if (q.length > MAX_QUERY) throw new ApiError(400, 'too_long', 'Kata kunci terlalu panjang (maksimal ' + MAX_QUERY + ' karakter).');
  const o = sp.get('offset');
  let offset = 0;
  if (o !== null && o !== '') {
    if (!/^\d{1,3}$/.test(o) || Number(o) > MAX_OFFSET) throw new ApiError(400, 'bad_offset', 'Halaman tidak valid.');
    offset = Number(o);
  }
  return { q, offset };
}

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return send(res, 405, { ok: false, code: 'method', error: 'Metode tidak diizinkan.' });
    }
    if (limited(clientIp(req), 20, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak pencarian. Tunggu sebentar lalu coba lagi.');
    const { q, offset } = parseInput(req.url);
    const out = await search(q, offset, false);
    return send(res, 200, { ok: true, q, ...out }, 'public, s-maxage=300, stale-while-revalidate=600');
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.extra && e.extra.retryAfter) res.setHeader('retry-after', String(e.extra.retryAfter));
      return send(res, e.status, { ok: false, code: e.code, error: e.message });
    }
    console.error('spotify api error:', e && e.message);
    return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
  }
}

module.exports = handler;
module.exports.__test = { parseInput, normalize, pickCover, resetToken() { cached = null; pending = null; hits.clear(); } };
