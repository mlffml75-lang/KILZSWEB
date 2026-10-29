/**
 * KilzsWeb - YouTube Search backend (Vercel Function, Node runtime, CommonJS)
 *
 *   GET /api/youtube-search?q=<kata kunci>[&category=music|gaming|news|sports|education|entertainment]
 *                           [&order=relevance|date|viewCount][&pageToken=<nextPageToken>]
 *
 * Memakai YouTube Data API v3 `search.list` (type=video). Biaya kuota: 100 unit per panggilan
 * (kuota default proyek Google Cloud: 10.000 unit/hari = sekitar 100 pencarian/hari).
 * Karena itu respons sukses di-cache di CDN Vercel (s-maxage) agar pencarian yang sama tidak
 * memakan kuota lagi. Endpoint videos.list sengaja TIDAK dipakai (hemat kuota).
 *
 * Environment Variable (wajib):  YOUTUBE_API_KEY
 * API key hanya dibaca di server, tidak pernah dikirim ke browser dan tidak ditulis ke log.
 */
'use strict';

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const PAGE_SIZE = 12;
const MAX_QUERY = 100;
const TIMEOUT_MS = 8000;
const REGION = 'ID';            // bias hasil ke Indonesia; ubah/hapus bila tidak diinginkan
const LANGUAGE = 'id';

// Pemetaan kategori -> videoCategoryId YouTube (kategori yang dipilih pengunggah video, bukan klasifikasi buatan kita).
const CATEGORY = { music: '10', gaming: '20', news: '25', sports: '17', education: '27', entertainment: '24' };
const ORDERS = ['relevance', 'date', 'viewCount'];

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

/* ---------- util ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    const v = ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const VID = /^[A-Za-z0-9_-]{11}$/;
function pickThumb(th) {
  if (!th) return null;
  const t = th.medium || th.high || th.default;
  return t && typeof t.url === 'string' && t.url.startsWith('https://') ? t.url : null;
}

function normalize(it) {
  const id = it && it.id && it.id.videoId;
  if (typeof id !== 'string' || !VID.test(id)) return null;
  const sn = it.snippet || {};
  if (sn.liveBroadcastContent === 'upcoming') return null; // belum bisa diputar
  return {
    id,
    title: decodeEntities(sn.title).slice(0, 200),
    channel: decodeEntities(sn.channelTitle).slice(0, 100),
    published: typeof sn.publishedAt === 'string' ? sn.publishedAt.slice(0, 30) : null,
    thumb: pickThumb(sn.thumbnails),
    live: sn.liveBroadcastContent === 'live',
  };
}

function parseInput(url) {
  let sp;
  try { sp = new URL(url, 'http://x').searchParams; } catch (e) { sp = new URLSearchParams(); }
  const q = String(sp.get('q') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) throw new ApiError(400, 'empty', 'Ketik kata kunci dulu (judul video, nama channel, atau kata bebas).');
  if (q.length > MAX_QUERY) throw new ApiError(400, 'too_long', 'Kata kunci terlalu panjang (maksimal ' + MAX_QUERY + ' karakter).');

  const cat = sp.get('category') || '';
  if (cat && !Object.prototype.hasOwnProperty.call(CATEGORY, cat)) throw new ApiError(400, 'bad_category', 'Kategori tidak dikenal.');

  const order = sp.get('order') || 'relevance';
  if (!ORDERS.includes(order)) throw new ApiError(400, 'bad_order', 'Pengurutan tidak dikenal.');

  const pageToken = sp.get('pageToken') || '';
  if (pageToken && !/^[A-Za-z0-9_-]{1,100}$/.test(pageToken)) throw new ApiError(400, 'bad_page', 'Halaman tidak valid.');

  return { q, category: cat, order, pageToken };
}

/* ---------- panggilan YouTube ---------- */
async function search(inp) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error('youtube-search: YOUTUBE_API_KEY belum diatur');
    throw new ApiError(503, 'not_configured', 'Fitur pencarian YouTube belum dikonfigurasi di server.');
  }
  const p = new URLSearchParams({
    part: 'snippet', type: 'video', q: inp.q, maxResults: String(PAGE_SIZE), order: inp.order,
    videoEmbeddable: 'true', safeSearch: 'moderate', regionCode: REGION, relevanceLanguage: LANGUAGE,
  });
  if (inp.category) p.set('videoCategoryId', CATEGORY[inp.category]);
  if (inp.pageToken) p.set('pageToken', inp.pageToken);
  p.set('key', key);

  let r;
  try {
    r = await fetch(SEARCH_URL + '?' + p.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error('youtube-search: network error'); // sengaja tanpa detail agar URL/key tidak ikut tercatat
    throw new ApiError(502, 'youtube_down', 'Tidak bisa menghubungi YouTube. Coba lagi nanti.');
  }

  let j = null;
  try { j = await r.json(); } catch (e) { /* ditangani di bawah */ }

  if (!r.ok) {
    const err = j && j.error;
    const reason = err && Array.isArray(err.errors) && err.errors[0] && err.errors[0].reason;
    console.error('youtube-search: status', r.status, 'reason', reason || '-');
    if (r.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded'))
      throw new ApiError(503, 'quota', 'Kuota pencarian YouTube hari ini habis. Coba lagi besok, atau pakai tab "Putar lewat Link".');
    if (r.status === 400 && reason === 'invalidPageToken') throw new ApiError(400, 'bad_page', 'Halaman hasil kedaluwarsa. Cari ulang.');
    if (r.status === 400 && (reason === 'keyInvalid' || /API key/i.test((err && err.message) || '')))
      throw new ApiError(503, 'bad_key', 'API key YouTube di server tidak valid. Hubungi pemilik website.');
    if (r.status === 400) throw new ApiError(400, 'bad_request', 'Pencarian tidak bisa diproses. Coba kata kunci lain.');
    if (r.status === 403) throw new ApiError(503, 'forbidden', 'Akses ke YouTube API ditolak. Hubungi pemilik website.');
    throw new ApiError(502, 'youtube_http', 'YouTube sedang bermasalah (' + r.status + '). Coba lagi nanti.');
  }
  if (!j || !Array.isArray(j.items)) throw new ApiError(502, 'youtube_format', 'Respons YouTube tidak valid.');

  const items = j.items.map(normalize).filter(Boolean);
  const next = typeof j.nextPageToken === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(j.nextPageToken) ? j.nextPageToken : null;
  return { items, nextPageToken: next };
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

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return send(res, 405, { ok: false, code: 'method', error: 'Metode tidak diizinkan.' });
    }
    if (limited(clientIp(req), 20, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak pencarian. Tunggu sebentar lalu coba lagi.');
    const inp = parseInput(req.url);
    const out = await search(inp);
    return send(res, 200, { ok: true, q: inp.q, ...out }, 'public, s-maxage=600, stale-while-revalidate=1200');
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { ok: false, code: e.code, error: e.message });
    console.error('youtube-search error');
    return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
  }
}

module.exports = handler;
module.exports.__test = { parseInput, normalize, decodeEntities, resetLimit() { hits.clear(); } };
