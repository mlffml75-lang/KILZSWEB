/**
 * KilzsWeb - Nonton Anime backend (Vercel Function, Node runtime, CommonJS)
 *
 *   Katalog : GET /api/anime?[q=][&genre=][&status=][&year=][&sort=relevance|popularity|score][&page=1]
 *   Detail  : GET /api/anime?id=<AniList media id>
 *
 * Sumber data: AniList GraphQL API v2 (https://graphql.anilist.co), data publik tanpa API key.
 * Tidak ada Environment Variable yang diperlukan.
 *
 * PENTING:
 *  - AniList hanya menyediakan METADATA (poster, sinopsis, genre, dll). Ia TIDAK menyediakan video episode.
 *    Field streamingEpisodes/externalLinks hanya berisi TAUTAN ke situs penyedia resmi (bukan URL embed).
 *  - Satu-satunya video yang bisa disematkan dari data ini adalah trailer resmi YouTube (trailer.id).
 *  - Ketentuan AniList: gratis untuk non-komersial (pendapatan < $150/bulan), dilarang menimbun/menyimpan data.
 *    Karena itu tidak ada database; hanya cache CDN pendek (s-maxage).
 *  - Konten dewasa disaring (isAdult: false).
 */
'use strict';

const ANILIST_URL = 'https://graphql.anilist.co';
const TIMEOUT_MS = 8000;
const PER_PAGE = 18;
const MAX_PAGE = 20;
const MAX_QUERY = 100;
const MIN_YEAR = 1960;

const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Romance', 'Sci-Fi', 'Sports', 'Supernatural'];
const STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED'];
const SORTS = { relevance: 'SEARCH_MATCH', popularity: 'POPULARITY_DESC', score: 'SCORE_DESC' };

const LIST_QUERY = `query($page:Int,$perPage:Int,$search:String,$genre:String,$status:MediaStatus,$year:Int,$sort:[MediaSort]){
  Page(page:$page,perPage:$perPage){
    pageInfo{hasNextPage currentPage}
    media(type:ANIME,isAdult:false,search:$search,genre:$genre,status:$status,seasonYear:$year,sort:$sort){
      id title{romaji english native} coverImage{large color} startDate{year} seasonYear genres status format episodes averageScore
    }
  }
}`;

const DETAIL_QUERY = `query($id:Int){
  Media(id:$id,type:ANIME){
    id isAdult title{romaji english native} synonyms description(asHtml:false)
    coverImage{extraLarge large color} genres status format episodes duration season seasonYear
    startDate{year month day} averageScore studios(isMain:true){nodes{name}}
    trailer{id site} streamingEpisodes{title thumbnail url site} externalLinks{site url type}
    nextAiringEpisode{episode airingAt} siteUrl
  }
}`;

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

/** Deskripsi AniList berisi sedikit HTML (<br>, <i>, <b>). Jadikan teks polos. */
function cleanDescription(s) {
  if (!s || typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 2500);
}

function isPrivateHost(h) {
  h = String(h || '').toLowerCase();
  return !h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(h);
}
/** Hanya https dan host publik; dipakai untuk tautan keluar dan gambar. */
function safeHttps(u) {
  if (typeof u !== 'string' || u.length > 600) return null;
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || isPrivateHost(x.hostname)) return null;
  return x.toString();
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function mainTitle(t) {
  t = t || {};
  return str(t.english, 200) || str(t.romaji, 200) || str(t.native, 200) || '(Tanpa judul)';
}

/* ---------- validasi input ---------- */
function parseList(url) {
  let sp;
  try { sp = new URL(url, 'http://x').searchParams; } catch (e) { sp = new URLSearchParams(); }
  const q = String(sp.get('q') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length > MAX_QUERY) throw new ApiError(400, 'too_long', 'Kata kunci terlalu panjang (maksimal ' + MAX_QUERY + ' karakter).');

  const genre = sp.get('genre') || '';
  if (genre && !GENRES.includes(genre)) throw new ApiError(400, 'bad_genre', 'Genre tidak dikenal.');

  const status = sp.get('status') || '';
  if (status && !STATUSES.includes(status)) throw new ApiError(400, 'bad_status', 'Status tayang tidak dikenal.');

  let year = null;
  const y = sp.get('year');
  if (y !== null && y !== '') {
    const max = new Date().getFullYear() + 1;
    if (!/^\d{4}$/.test(y) || Number(y) < MIN_YEAR || Number(y) > max) throw new ApiError(400, 'bad_year', 'Tahun harus antara ' + MIN_YEAR + ' dan ' + max + '.');
    year = Number(y);
  }

  const sortKey = sp.get('sort') || 'relevance';
  if (!Object.prototype.hasOwnProperty.call(SORTS, sortKey)) throw new ApiError(400, 'bad_sort', 'Pengurutan tidak dikenal.');
  // SEARCH_MATCH hanya bermakna jika ada kata kunci.
  const sort = sortKey === 'relevance' && !q ? 'POPULARITY_DESC' : SORTS[sortKey];

  let page = 1;
  const p = sp.get('page');
  if (p !== null && p !== '') {
    if (!/^\d{1,2}$/.test(p) || Number(p) < 1 || Number(p) > MAX_PAGE) throw new ApiError(400, 'bad_page', 'Halaman tidak valid.');
    page = Number(p);
  }
  return { q, genre, status, year, sort, page };
}

function parseId(url) {
  let sp;
  try { sp = new URL(url, 'http://x').searchParams; } catch (e) { sp = new URLSearchParams(); }
  const id = sp.get('id');
  if (id === null) return null;
  if (!/^\d{1,8}$/.test(id) || Number(id) < 1) throw new ApiError(400, 'bad_id', 'ID anime tidak valid.');
  return Number(id);
}

/* ---------- panggilan AniList ---------- */
async function anilist(query, variables) {
  let r;
  try {
    r = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ApiError(502, 'anilist_down', 'Tidak bisa menghubungi layanan katalog anime. Coba lagi nanti.');
  }
  if (r.status === 429) {
    const ra = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0;
    throw new ApiError(429, 'anilist_limit', 'Layanan katalog sedang dibatasi. Coba lagi sebentar lagi.', { retryAfter: ra });
  }
  let j = null;
  try { j = await r.json(); } catch (e) { /* ditangani di bawah */ }
  if (r.status === 404) throw new ApiError(404, 'not_found', 'Anime tidak ditemukan.');
  if (r.status === 403) throw new ApiError(503, 'anilist_off', 'Layanan katalog anime sedang tidak tersedia. Coba lagi nanti.');
  if (!r.ok) throw new ApiError(502, 'anilist_http', 'Layanan katalog bermasalah (' + r.status + '). Coba lagi nanti.');
  if (!j || j.errors || !j.data) {
    const st = j && Array.isArray(j.errors) && j.errors[0] && j.errors[0].status;
    if (st === 404) throw new ApiError(404, 'not_found', 'Anime tidak ditemukan.');
    throw new ApiError(502, 'anilist_format', 'Respons layanan katalog tidak valid.');
  }
  return j.data;
}

/* ---------- normalisasi ---------- */
function normalizeCard(m) {
  if (!m || !Number.isInteger(m.id)) return null;
  return {
    id: m.id,
    title: mainTitle(m.title),
    cover: safeHttps(m.coverImage && m.coverImage.large),
    year: numOrNull(m.seasonYear) || numOrNull(m.startDate && m.startDate.year),
    genres: Array.isArray(m.genres) ? m.genres.filter((x) => typeof x === 'string').slice(0, 3) : [],
    status: str(m.status, 30) || null,
    format: str(m.format, 30) || null,
    episodes: numOrNull(m.episodes),
    score: numOrNull(m.averageScore),
  };
}

const VID = /^[A-Za-z0-9_-]{11}$/;
function normalizeDetail(m) {
  const main = mainTitle(m.title);
  const alt = [];
  const t = m.title || {};
  [t.romaji, t.english, t.native].concat(Array.isArray(m.synonyms) ? m.synonyms : []).forEach((x) => {
    if (typeof x === 'string' && x && x !== main && !alt.includes(x) && alt.length < 5) alt.push(x.slice(0, 200));
  });

  const eps = [];
  (Array.isArray(m.streamingEpisodes) ? m.streamingEpisodes : []).forEach((e) => {
    const url = safeHttps(e && e.url);
    if (!url || eps.length >= 200) return;
    eps.push({ title: str(e.title, 200) || 'Episode', site: str(e.site, 60), url, thumb: safeHttps(e.thumbnail) });
  });

  const sources = [];
  (Array.isArray(m.externalLinks) ? m.externalLinks : []).forEach((l) => {
    const url = safeHttps(l && l.url);
    if (!url || !l.site || l.type !== 'STREAMING' || sources.length >= 12) return;
    if (!sources.some((s) => s.site === l.site)) sources.push({ site: str(l.site, 60), url });
  });

  const tr = m.trailer;
  const trailerId = tr && tr.site === 'youtube' && typeof tr.id === 'string' && VID.test(tr.id) ? tr.id : null;
  const sd = m.startDate || {};
  const studios = m.studios && Array.isArray(m.studios.nodes) ? m.studios.nodes.map((n) => n && n.name).filter((x) => typeof x === 'string').slice(0, 3) : [];
  const na = m.nextAiringEpisode;

  return {
    id: m.id,
    title: main,
    altTitles: alt,
    description: cleanDescription(m.description),
    cover: safeHttps(m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)),
    genres: Array.isArray(m.genres) ? m.genres.filter((x) => typeof x === 'string').slice(0, 8) : [],
    status: str(m.status, 30) || null,
    format: str(m.format, 30) || null,
    episodes: numOrNull(m.episodes),
    duration: numOrNull(m.duration),
    year: numOrNull(m.seasonYear) || numOrNull(sd.year),
    score: numOrNull(m.averageScore),
    studios,
    nextEpisode: na && Number.isInteger(na.episode) ? { episode: na.episode, airingAt: numOrNull(na.airingAt) } : null,
    trailerId,
    episodeLinks: eps,
    sources,
    anilistUrl: safeHttps(m.siteUrl),
  };
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
    if (limited(clientIp(req), 30, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.');

    const id = parseId(req.url);
    if (id !== null) {
      const d = await anilist(DETAIL_QUERY, { id });
      const m = d.Media;
      if (!m || m.isAdult) throw new ApiError(404, 'not_found', 'Anime tidak ditemukan.');
      return send(res, 200, { ok: true, anime: normalizeDetail(m) }, 'public, s-maxage=1800, stale-while-revalidate=3600');
    }

    const f = parseList(req.url);
    const vars = { page: f.page, perPage: PER_PAGE, sort: [f.sort] };
    if (f.q) vars.search = f.q;
    if (f.genre) vars.genre = f.genre;
    if (f.status) vars.status = f.status;
    if (f.year) vars.year = f.year;
    const d = await anilist(LIST_QUERY, vars);
    const pg = d.Page;
    if (!pg || !Array.isArray(pg.media)) throw new ApiError(502, 'anilist_format', 'Respons layanan katalog tidak valid.');
    return send(res, 200, {
      ok: true,
      items: pg.media.map(normalizeCard).filter(Boolean),
      page: f.page,
      hasNext: !!(pg.pageInfo && pg.pageInfo.hasNextPage) && f.page < MAX_PAGE,
    }, 'public, s-maxage=600, stale-while-revalidate=1200');
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.extra && e.extra.retryAfter) res.setHeader('retry-after', String(e.extra.retryAfter));
      return send(res, e.status, { ok: false, code: e.code, error: e.message });
    }
    console.error('anime api error');
    return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
  }
}

module.exports = handler;
module.exports.__test = { parseList, parseId, cleanDescription, normalizeCard, normalizeDetail, safeHttps, resetLimit() { hits.clear(); } };
