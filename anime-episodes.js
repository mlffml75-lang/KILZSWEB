/**
 * KilzsWeb - Episode resmi anime dari kanal YouTube resmi (Vercel Function, Node runtime, CommonJS)
 *
 *   GET /api/anime-episodes?id=<ID anime di AniList>
 *
 * Alur:
 *   1. Ambil judul anime dari AniList berdasarkan ID (klien TIDAK bisa mengirim kata kunci bebas,
 *      jadi endpoint ini tidak bisa dipakai sebagai pencarian YouTube umum dengan API key kamu).
 *   2. Verifikasi identitas kanal resmi lewat channels.list?forHandle (1 unit/kanal, di-cache):
 *      customUrl harus sama dengan handle, nama harus cocok, subscriber >= batas minimum.
 *   3. search.list (100 unit) dibatasi ke channelId kanal terverifikasi, lalu videos.list (1 unit)
 *      untuk memastikan tiap video: kanalnya sama, publik, boleh di-embed, tidak dibatasi wilayah.
 *   4. Pencocokan judul video -> episode dibuat KETAT. Video tanpa judul anime / nomor episode /
 *      musim yang cocok TIDAK ditampilkan. Tidak ada episode yang dibuat-buat.
 *
 * Environment Variable (sudah ada): YOUTUBE_API_KEY. Key hanya dipakai di server, tidak masuk log/respons.
 *
 * Kuota (per anime yang belum ter-cache): ~2 unit verifikasi kanal (cache) + 100 unit per kanal yang dicari
 * + 1 unit videos.list. Kanal kedua hanya dicari bila kanal pertama tidak menemukan apa pun.
 */
'use strict';

const YT_URL = 'https://www.googleapis.com/youtube/v3';
const ANILIST_URL = 'https://graphql.anilist.co';
const TIMEOUT_MS = 8000;
const AUDIENCE_REGION = 'ID';       // video yang dibatasi untuk wilayah ini tidak ditampilkan
const MIN_DURATION_S = 180;         // buang klip sangat pendek
const MAX_RESULTS = 50;

// Kanal resmi yang diizinkan. Handle terverifikasi dari sumber publik (Social Blade, siaran pers Medialink).
// Bila ingin menambah kanal (mis. Ani-One Indonesia), tambahkan entri di sini SETELAH handle-nya kamu verifikasi.
const CHANNELS = [
  { key: 'muse-id', handle: 'museindonesia', label: 'Muse Indonesia', name: /muse\s*indonesia/i, minSubs: 1000000 },
  { key: 'anione-asia', handle: 'anioneasia', label: 'Ani-One Asia', name: /ani-?\s*one\s*asia/i, minSubs: 1000000 },
];

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* ---------- util teks ---------- */
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
function norm(s) {
  return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const WORD_NUM = { second: 2, third: 3, fourth: 4, fifth: 5 };

/** Nomor musim yang tertulis di sebuah judul (anime atau video); null bila tidak ada. */
function seasonOf(raw) {
  const r = String(raw || '');
  let m = r.match(/\bS(\d{1,2})\s*E\d{1,3}\b/i);
  if (m) return Number(m[1]);
  const s = norm(r);
  if ((m = s.match(/\b(\d{1,2})(?:st|nd|rd|th) season\b/))) return Number(m[1]);
  if ((m = s.match(/\bseason (\d{1,2})\b/))) return Number(m[1]);
  if ((m = s.match(/\b(second|third|fourth|fifth) season\b/))) return WORD_NUM[m[1]];
  if ((m = s.match(/\bs(\d{1,2})\b/))) return Number(m[1]);
  return null;
}
/** Buang penanda musim agar tersisa judul dasar. */
function baseOf(raw) {
  return norm(raw)
    .replace(/\b\d{1,2}(?:st|nd|rd|th) season\b/g, ' ')
    .replace(/\b(?:second|third|fourth|fifth) season\b/g, ' ')
    .replace(/\bseason \d{1,2}\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const REJECT = /\b(trailer|pv|teaser|preview|recap|summary|opening|ending|clip|amv|reaction|review|behind the scenes|announcement|promo|cm)\b/;

/** Nomor episode dari judul video; null bila tidak terbaca dengan pasti. */
function parseEpisode(raw) {
  const r = String(raw || '');
  let m = r.match(/\bS\d{1,2}\s*E(\d{1,3})\b/i);
  if (m) return Number(m[1]);
  m = r.match(/\b(?:episode|episod|eps|ep)\.?\s*#?\s*(\d{1,3})\b/i);
  if (m) return Number(m[1]);
  m = r.match(/第\s*(\d{1,3})\s*話/);
  if (m) return Number(m[1]);
  m = r.match(/[#＃]\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  return null;
}

/** Konteks pencocokan dari data AniList. */
function buildContext(media) {
  const t = media.title || {};
  const names = [t.english, t.romaji].concat(Array.isArray(media.synonyms) ? media.synonyms.slice(0, 5) : []).filter((x) => typeof x === 'string' && x);
  const keys = [];
  names.forEach((n) => { const b = baseOf(n); if (b.length >= 4 && !keys.includes(b)) keys.push(b); });
  let season = null;
  [t.english, t.romaji].concat(media.synonyms || []).forEach((n) => { const s = seasonOf(n); if (s && (!season || s > season)) season = s; });
  const query = (names.length ? baseOf(names[0]) : '') || keys[0] || '';
  return { keys, season, query, episodes: Number.isInteger(media.episodes) ? media.episodes : null };
}

/** Kembalikan nomor episode bila judul video cocok dengan anime; selain itu null. */
function matchVideo(title, ctx) {
  const nt = norm(title);
  if (!nt || REJECT.test(nt)) return null;
  const padded = ' ' + nt + ' ';
  if (!ctx.keys.some((k) => padded.includes(' ' + k + ' '))) return null;
  const vs = seasonOf(title);
  if (ctx.season && ctx.season >= 2) { if (vs !== ctx.season) return null; }
  else if (vs !== null && vs !== 1) return null;
  const n = parseEpisode(title);
  if (n === null || n < 1) return null;
  if (ctx.episodes && n > ctx.episodes) return null;
  if (n > 1100) return null;
  return n;
}

function isoSeconds(d) {
  const m = String(d || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}
const VID = /^[A-Za-z0-9_-]{11}$/;
const CHID = /^UC[A-Za-z0-9_-]{22}$/;
const safeThumb = (th) => {
  const t = th && (th.medium || th.high || th.default);
  return t && typeof t.url === 'string' && t.url.startsWith('https://') ? t.url : null;
};

/* ---------- panggilan eksternal ---------- */
async function yt(path, params) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    console.error('anime-episodes: YOUTUBE_API_KEY belum diatur');
    throw new ApiError(503, 'not_configured', 'Fitur episode resmi belum dikonfigurasi di server.');
  }
  const p = new URLSearchParams(Object.assign({}, params, { key }));
  let r;
  try {
    r = await fetch(YT_URL + path + '?' + p.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error('anime-episodes: network error'); // tanpa detail agar URL/key tidak tercatat
    throw new ApiError(502, 'youtube_down', 'Tidak bisa menghubungi YouTube. Coba lagi nanti.');
  }
  let j = null;
  try { j = await r.json(); } catch (e) { /* ditangani di bawah */ }
  if (!r.ok) {
    const err = j && j.error;
    const reason = err && Array.isArray(err.errors) && err.errors[0] && err.errors[0].reason;
    console.error('anime-episodes: youtube status', r.status, 'reason', reason || '-');
    if (r.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded'))
      throw new ApiError(503, 'quota', 'Kuota YouTube hari ini habis, jadi episode resmi belum bisa dicari. Coba lagi besok.');
    if (r.status === 400 || r.status === 403) throw new ApiError(503, 'bad_key', 'Akses ke YouTube API bermasalah. Hubungi pemilik website.');
    throw new ApiError(502, 'youtube_http', 'YouTube sedang bermasalah (' + r.status + '). Coba lagi nanti.');
  }
  if (!j || typeof j !== 'object') throw new ApiError(502, 'youtube_format', 'Respons YouTube tidak valid.');
  return j;
}

async function anilistMedia(id) {
  let r;
  try {
    r = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query: 'query($id:Int){Media(id:$id,type:ANIME){id isAdult status format episodes seasonYear title{romaji english native} synonyms}}',
        variables: { id },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) { throw new ApiError(502, 'anilist_down', 'Tidak bisa menghubungi layanan katalog anime. Coba lagi nanti.'); }
  if (r.status === 429) throw new ApiError(429, 'anilist_limit', 'Layanan katalog sedang dibatasi. Coba lagi sebentar lagi.');
  let j = null;
  try { j = await r.json(); } catch (e) { /* ditangani di bawah */ }
  if (r.status === 404) throw new ApiError(404, 'not_found', 'Anime tidak ditemukan.');
  if (!r.ok) throw new ApiError(502, 'anilist_http', 'Layanan katalog bermasalah (' + r.status + ').');
  const m = j && j.data && j.data.Media;
  if (!m || m.isAdult) throw new ApiError(404, 'not_found', 'Anime tidak ditemukan.');
  return m;
}

/* ---------- verifikasi kanal (cache memori per instance) ---------- */
const chCache = new Map(); // key -> { exp, ok, id, label }
async function verifyChannel(ch) {
  const c = chCache.get(ch.key);
  if (c && c.exp > Date.now()) return c.ok ? c : null;
  const j = await yt('/channels', { part: 'snippet,statistics', forHandle: '@' + ch.handle });
  const it = Array.isArray(j.items) ? j.items[0] : null;
  const sn = (it && it.snippet) || {};
  const subs = Number(it && it.statistics && it.statistics.subscriberCount);
  const ok = !!(it && typeof it.id === 'string' && CHID.test(it.id)
    && String(sn.customUrl || '').toLowerCase() === '@' + ch.handle
    && ch.name.test(String(sn.title || ''))
    && !(it.statistics && it.statistics.hiddenSubscriberCount)
    && isFinite(subs) && subs >= ch.minSubs);
  const rec = { exp: Date.now() + (ok ? 24 * 3600e3 : 30 * 60e3), ok, id: ok ? it.id : null, label: ch.label, key: ch.key };
  chCache.set(ch.key, rec);
  if (!ok) console.error('anime-episodes: kanal gagal verifikasi:', ch.key);
  return ok ? rec : null;
}

/* ---------- pencarian episode ---------- */
function regionBlocked(cd) {
  const rr = cd && cd.regionRestriction;
  if (!rr) return false;
  if (Array.isArray(rr.blocked) && rr.blocked.includes(AUDIENCE_REGION)) return true;
  if (Array.isArray(rr.allowed) && !rr.allowed.includes(AUDIENCE_REGION)) return true;
  return false;
}

async function searchChannel(ch, ctx) {
  const s = await yt('/search', {
    part: 'snippet', type: 'video', channelId: ch.id, q: ctx.query, maxResults: String(MAX_RESULTS),
    videoEmbeddable: 'true', order: 'relevance',
  });
  const pre = [];
  (Array.isArray(s.items) ? s.items : []).forEach((it) => {
    const id = it && it.id && it.id.videoId;
    const sn = (it && it.snippet) || {};
    if (typeof id !== 'string' || !VID.test(id) || sn.channelId !== ch.id) return;
    if (matchVideo(decodeEntities(sn.title), ctx) !== null) pre.push(id);
  });
  if (!pre.length) return [];

  const v = await yt('/videos', { part: 'snippet,status,contentDetails', id: pre.slice(0, 50).join(',') });
  const out = [];
  (Array.isArray(v.items) ? v.items : []).forEach((it) => {
    const sn = it.snippet || {}, stt = it.status || {}, cd = it.contentDetails || {};
    if (typeof it.id !== 'string' || !VID.test(it.id)) return;
    if (sn.channelId !== ch.id) return;                                   // keaslian: harus dari kanal terverifikasi
    if (stt.privacyStatus !== 'public' || stt.embeddable !== true) return; // hanya publik & boleh disematkan
    if (stt.uploadStatus && stt.uploadStatus !== 'processed') return;
    if (sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none') return;
    if (regionBlocked(cd)) return;                                        // tidak mengakali pembatasan wilayah
    const dur = isoSeconds(cd.duration);
    if (dur < MIN_DURATION_S) return;
    const title = decodeEntities(sn.title);
    const n = matchVideo(title, ctx);
    if (n === null) return;
    out.push({ n, title: title.slice(0, 160), videoId: it.id, channel: ch.label, published: typeof sn.publishedAt === 'string' ? sn.publishedAt.slice(0, 30) : null, thumb: safeThumb(sn.thumbnails), duration: dur });
  });
  return out;
}

function dedupeSort(list) {
  const best = new Map();
  list.forEach((e) => {
    const cur = best.get(e.n);
    if (!cur || (e.published && cur.published && e.published < cur.published)) best.set(e.n, e); // pilih unggahan paling awal
  });
  return [...best.values()].sort((a, b) => a.n - b.n);
}

async function findEpisodes(id) {
  const media = await anilistMedia(id);
  if (media.status === 'NOT_YET_RELEASED') return { found: false, reason: 'not_yet_released', episodes: [], checked: [] };
  const ctx = buildContext(media);
  if (!ctx.keys.length || !ctx.query) return { found: false, reason: 'no_title', episodes: [], checked: [] };

  const verified = (await Promise.all(CHANNELS.map(verifyChannel))).filter(Boolean);
  if (!verified.length) throw new ApiError(503, 'unverified', 'Kanal resmi belum bisa diverifikasi saat ini. Coba lagi nanti.');

  const checked = [];
  for (const ch of verified) {             // berurutan; berhenti di kanal pertama yang menemukan episode
    checked.push(ch.label);
    const eps = dedupeSort(await searchChannel(ch, ctx));
    if (eps.length) return { found: true, reason: null, episodes: eps, checked };
  }
  return { found: false, reason: 'no_match', episodes: [], checked };
}

/* ---------- cache memori + dedupe request ---------- */
const memo = new Map();   // id -> { exp, data }
const inflight = new Map();
async function cached(id) {
  const m = memo.get(id);
  if (m && m.exp > Date.now()) return m.data;
  if (inflight.has(id)) return inflight.get(id);
  const p = findEpisodes(id).then((d) => {
    memo.set(id, { exp: Date.now() + (d.found ? 6 * 3600e3 : 1 * 3600e3), data: d });
    if (memo.size > 300) memo.delete(memo.keys().next().value);
    return d;
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/* ---------- rate limit sederhana ---------- */
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
function parseId(url) {
  let sp;
  try { sp = new URL(url, 'http://x').searchParams; } catch (e) { sp = new URLSearchParams(); }
  const id = sp.get('id');
  if (id === null || !/^\d{1,8}$/.test(id) || Number(id) < 1) throw new ApiError(400, 'bad_id', 'ID anime tidak valid.');
  return Number(id);
}

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return send(res, 405, { ok: false, code: 'method', error: 'Metode tidak diizinkan.' });
    }
    if (limited(clientIp(req), 15, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.');
    const id = parseId(req.url);
    const d = await cached(id);
    return send(res, 200, { ok: true, id, found: d.found, reason: d.reason, episodes: d.episodes, checked: d.checked },
      d.found ? 'public, s-maxage=86400, stale-while-revalidate=86400' : 'public, s-maxage=21600, stale-while-revalidate=21600');
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { ok: false, code: e.code, error: e.message });
    console.error('anime-episodes error');
    return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
  }
}

module.exports = handler;
module.exports.__test = {
  norm, seasonOf, baseOf, parseEpisode, buildContext, matchVideo, isoSeconds, dedupeSort, parseId, CHANNELS,
  reset() { chCache.clear(); memo.clear(); inflight.clear(); hits.clear(); },
};
