/**
 * KilzsWeb - Nonton Film & Series backend (Vercel Function, Node runtime, CommonJS)
 *
 *   GET /api/film?action=meta                       daftar genre & pengurutan (tanpa panggilan TMDB)
 *   GET /api/film?action=home                       baris poster untuk Beranda (trending, populer, di bioskop)
 *   GET /api/film?action=list&type=movie|tv|all     katalog / pencarian
 *        [&q=judul][&genre=<id>][&year=YYYY][&sort=popularity|rating|newest][&page=1]
 *   GET /api/film?action=detail&type=movie|tv&id=<id TMDB>
 *   GET /api/film?action=season&id=<id TMDB series>&season=<nomor>
 *
 * Sumber data: TMDB API v3 (https://api.themoviedb.org/3). Data tempat menonton (streaming/sewa/beli)
 * berasal dari JustWatch lewat TMDB, wajib diberi atribusi (ada di UI).
 * Ini HANYA metadata. Tidak ada video film yang diambil, diproksi, atau disediakan.
 *
 * Environment Variable (wajib): TMDB_API_KEY
 *   Boleh berisi "API Key" (v3, 32 karakter hex) ATAU "API Read Access Token" (v4, diawali eyJ...).
 *   Keduanya memberi akses setara untuk endpoint baca; kode mendeteksi jenisnya otomatis.
 *   Kunci hanya dipakai di server, tidak pernah dikirim ke browser dan tidak ditulis ke log.
 */
'use strict';

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const TIMEOUT_MS = 8000;
const LANG = 'id-ID';
const FALLBACK_LANG = 'en-US';
const REGION = 'ID';               // wilayah data tempat menonton
const MAX_PAGE = 20;
const MAX_QUERY = 100;

// Urutan = urutan chip di UI. Nama sengaja Inggris (sesuai permintaan: Action, Comedy, Horror, ...).
const MOVIE_GENRES = [[28, 'Action'], [35, 'Comedy'], [27, 'Horror'], [10749, 'Romance'], [12, 'Adventure'], [16, 'Animation'], [80, 'Crime'],
  [99, 'Documentary'], [18, 'Drama'], [10751, 'Family'], [14, 'Fantasy'], [36, 'History'], [10402, 'Music'], [9648, 'Mystery'], [878, 'Sci-Fi'],
  [53, 'Thriller'], [10752, 'War'], [37, 'Western']];
const TV_GENRES = [[10759, 'Action & Adventure'], [35, 'Comedy'], [18, 'Drama'], [80, 'Crime'], [9648, 'Mystery'], [10765, 'Sci-Fi & Fantasy'],
  [16, 'Animation'], [99, 'Documentary'], [10751, 'Family'], [10762, 'Kids'], [10764, 'Reality'], [10768, 'War & Politics'], [37, 'Western']];
const NAME = new Map(MOVIE_GENRES.concat(TV_GENRES, [[10770, 'TV Movie'], [10763, 'News'], [10766, 'Soap'], [10767, 'Talk']]));
const SORTS = ['popularity', 'rating', 'newest'];

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

/* ---------- util ---------- */
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
function img(path, size) {
  return typeof path === 'string' && /^\/[A-Za-z0-9_-]{5,60}\.(jpg|jpeg|png|webp)$/.test(path) ? IMG + size + path : null;
}
function isPrivateHost(h) {
  h = String(h || '').toLowerCase();
  return !h.includes('.') || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(h);
}
function safeHttps(u) {
  if (typeof u !== 'string' || u.length > 600) return null;
  let x;
  try { x = new URL(u); } catch (e) { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || isPrivateHost(x.hostname)) return null;
  return x.toString();
}
function tmdbLink(u, type, id) {
  const x = safeHttps(u);
  if (x) { const h = new URL(x).hostname; if (h === 'www.themoviedb.org' || h === 'themoviedb.org') return x; }
  return 'https://www.themoviedb.org/' + type + '/' + id;      // halaman TMDB judul ini
}
const year4 = (d) => (typeof d === 'string' && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);
const today = () => new Date().toISOString().slice(0, 10);
const round1 = (v) => Math.round(v * 10) / 10;

/* ---------- panggilan TMDB ---------- */
function isJwt(k) { return k.length > 40 && k.split('.').length === 3; }
async function tmdb(path, params) {
  const key = (process.env.TMDB_API_KEY || '').trim();
  if (!key) {
    console.error('film: TMDB_API_KEY belum diatur');
    throw new ApiError(503, 'not_configured', 'Fitur film & series belum dikonfigurasi di server.');
  }
  const p = new URLSearchParams(params || {});
  const headers = { accept: 'application/json' };
  if (isJwt(key)) headers.authorization = 'Bearer ' + key; else p.set('api_key', key);
  let r;
  try {
    r = await fetch(TMDB + path + '?' + p.toString(), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error('film: network error'); // tanpa detail agar URL/kunci tidak tercatat
    throw new ApiError(502, 'tmdb_down', 'Tidak bisa menghubungi layanan data film. Coba lagi nanti.');
  }
  if (r.status === 401) { console.error('film: TMDB menolak kunci (401)'); throw new ApiError(503, 'bad_key', 'Kunci TMDB di server tidak valid. Hubungi pemilik website.'); }
  if (r.status === 404) throw new ApiError(404, 'not_found', 'Data tidak ditemukan.');
  if (r.status === 429) {
    const ra = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0;
    throw new ApiError(429, 'tmdb_limit', 'Layanan data film sedang dibatasi. Coba lagi sebentar lagi.', { retryAfter: ra });
  }
  if (!r.ok) throw new ApiError(502, 'tmdb_http', 'Layanan data film bermasalah (' + r.status + '). Coba lagi nanti.');
  let j;
  try { j = await r.json(); } catch (e) { throw new ApiError(502, 'tmdb_format', 'Respons layanan data film tidak bisa dibaca.'); }
  if (!j || typeof j !== 'object') throw new ApiError(502, 'tmdb_format', 'Respons layanan data film tidak valid.');
  return j;
}

/* ---------- normalisasi ---------- */
function card(it, forced) {
  if (!it || !Number.isInteger(it.id) || it.adult === true) return null;
  const type = forced || it.media_type;
  if (type !== 'movie' && type !== 'tv') return null;
  const title = str(type === 'movie' ? it.title : it.name, 200) || str(it.original_title || it.original_name, 200);
  if (!title) return null;
  const ids = Array.isArray(it.genre_ids) ? it.genre_ids : [];
  return {
    id: it.id, type, title,
    year: year4(type === 'movie' ? it.release_date : it.first_air_date),
    rating: num(it.vote_average) !== null && Number(it.vote_count) > 0 ? round1(it.vote_average) : null,
    genres: ids.map((g) => NAME.get(g)).filter(Boolean).slice(0, 3),
    genreIds: ids.filter((g) => Number.isInteger(g)).slice(0, 8),
    poster: img(it.poster_path, 'w342'),
  };
}
const cards = (arr, forced) => (Array.isArray(arr) ? arr.map((x) => card(x, forced)).filter(Boolean) : []);

function pickTrailer(videos) {
  const list = videos && Array.isArray(videos.results) ? videos.results : [];
  const ok = list.filter((v) => v && v.site === 'YouTube' && typeof v.key === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v.key) && (v.type === 'Trailer' || v.type === 'Teaser'));
  ok.sort((a, b) => (b.official === true) - (a.official === true) || (b.type === 'Trailer') - (a.type === 'Trailer'));
  return ok.length ? ok[0].key : null;
}

function watchInfo(wp, type, id) {
  const r = wp && wp.results && wp.results[REGION];
  const prov = (arr) => (Array.isArray(arr) ? arr.map((p) => ({ name: str(p && p.provider_name, 60), logo: img(p && p.logo_path, 'w92') })).filter((p) => p.name).slice(0, 12) : []);
  const stream = prov(r && r.flatrate), free = prov((r && r.free || []).concat(r && r.ads || []));
  const rent = prov(r && r.rent), buy = prov(r && r.buy);
  const any = stream.length || free.length || rent.length || buy.length;
  return { region: REGION, available: !!any, link: tmdbLink(r && r.link, type, id), stream, free, rent, buy };
}

function normalizeDetail(d, type, wpFromAppend) {
  const isMovie = type === 'movie';
  const credits = d.credits || {};
  const cast = Array.isArray(credits.cast) ? credits.cast.map((c) => str(c && c.name, 80)).filter(Boolean).slice(0, 8) : [];
  const crew = Array.isArray(credits.crew) ? credits.crew : [];
  const directors = crew.filter((c) => c && c.job === 'Director').map((c) => str(c.name, 80)).filter(Boolean).slice(0, 3);
  const out = {
    id: d.id, type,
    title: str(isMovie ? d.title : d.name, 200) || str(d.original_title || d.original_name, 200) || '(Tanpa judul)',
    originalTitle: str(isMovie ? d.original_title : d.original_name, 200) || null,
    tagline: str(d.tagline, 200) || null,
    overview: str(d.overview, 3000),
    date: str(isMovie ? d.release_date : d.first_air_date, 10) || null,
    year: year4(isMovie ? d.release_date : d.first_air_date),
    rating: num(d.vote_average) !== null && Number(d.vote_count) > 0 ? round1(d.vote_average) : null,
    votes: Number(d.vote_count) > 0 ? Number(d.vote_count) : null,
    genres: Array.isArray(d.genres) ? d.genres.map((g) => str(g && g.name, 40)).filter(Boolean).slice(0, 8) : [],
    status: str(d.status, 40) || null,
    poster: img(d.poster_path, 'w500'),
    backdrop: img(d.backdrop_path, 'w780'),
    cast, directors,
    trailerKey: pickTrailer(d.videos),
    homepage: safeHttps(d.homepage),
    tmdbUrl: 'https://www.themoviedb.org/' + type + '/' + d.id,
    watch: watchInfo(wpFromAppend, type, d.id),
  };
  if (isMovie) {
    out.runtime = num(d.runtime) && d.runtime > 0 ? d.runtime : null;
  } else {
    out.runtime = Array.isArray(d.episode_run_time) && num(d.episode_run_time[0]) ? d.episode_run_time[0] : null;
    out.numberOfSeasons = num(d.number_of_seasons);
    out.numberOfEpisodes = num(d.number_of_episodes);
    out.networks = Array.isArray(d.networks) ? d.networks.map((n) => str(n && n.name, 60)).filter(Boolean).slice(0, 4) : [];
    out.creators = Array.isArray(d.created_by) ? d.created_by.map((c) => str(c && c.name, 80)).filter(Boolean).slice(0, 3) : [];
    out.lastAirDate = str(d.last_air_date, 10) || null;
    const ne = d.next_episode_to_air;
    out.nextEpisode = ne && Number.isInteger(ne.episode_number) ? { season: num(ne.season_number), episode: ne.episode_number, airDate: str(ne.air_date, 10) || null } : null;
    out.seasons = Array.isArray(d.seasons) ? d.seasons.filter((s) => s && Number.isInteger(s.season_number) && s.season_number >= 0).slice(0, 60).map((s) => ({
      number: s.season_number, name: str(s.name, 100) || 'Season ' + s.season_number, episodes: num(s.episode_count) || 0,
      airDate: str(s.air_date, 10) || null, poster: img(s.poster_path, 'w185'),
    })) : [];
  }
  return out;
}

/* ---------- validasi input ---------- */
function params(url) {
  try { return new URL(url, 'http://x').searchParams; } catch (e) { return new URLSearchParams(); }
}
function intIn(v, lo, hi, code, msg) {
  if (v === null || v === '' || !/^\d{1,9}$/.test(v) || Number(v) < lo || Number(v) > hi) throw new ApiError(400, code, msg);
  return Number(v);
}
function parseType(sp, allowAll) {
  const t = sp.get('type') || (allowAll ? 'all' : '');
  if (t === 'movie' || t === 'tv' || (allowAll && t === 'all')) return t;
  throw new ApiError(400, 'bad_type', 'Jenis harus movie atau tv.');
}
function parseList(sp) {
  const type = parseType(sp, true);
  const q = String(sp.get('q') || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length > MAX_QUERY) throw new ApiError(400, 'too_long', 'Kata kunci terlalu panjang (maksimal ' + MAX_QUERY + ' karakter).');
  if (type === 'all' && !q) throw new ApiError(400, 'empty', 'Ketik judul film atau series dulu.');

  let genre = null;
  const g = sp.get('genre');
  if (g !== null && g !== '') {
    if (type === 'all') throw new ApiError(400, 'bad_genre', 'Filter genre hanya untuk Film atau Series.');
    const id = intIn(g, 1, 99999, 'bad_genre', 'Genre tidak dikenal.');
    const list = type === 'movie' ? MOVIE_GENRES : TV_GENRES;
    if (!list.some((x) => x[0] === id)) throw new ApiError(400, 'bad_genre', 'Genre tidak dikenal.');
    genre = id;
  }
  let year = null;
  const y = sp.get('year');
  if (y !== null && y !== '') {
    const max = new Date().getFullYear() + 2;
    if (!/^\d{4}$/.test(y) || Number(y) < 1900 || Number(y) > max) throw new ApiError(400, 'bad_year', 'Tahun harus antara 1900 dan ' + max + '.');
    year = Number(y);
  }
  const sort = sp.get('sort') || 'popularity';
  if (!SORTS.includes(sort)) throw new ApiError(400, 'bad_sort', 'Pengurutan tidak dikenal.');
  let page = 1;
  const p = sp.get('page');
  if (p !== null && p !== '') page = intIn(p, 1, MAX_PAGE, 'bad_page', 'Halaman tidak valid.');
  return { type, q, genre, year, sort, page };
}

/* ---------- aksi ---------- */
async function actionHome() {
  const calls = [
    { key: 'trending', title: 'Trending minggu ini', forced: null, path: '/trending/all/week', p: {} },
    { key: 'movie', title: 'Film populer', forced: 'movie', path: '/movie/popular', p: {} },
    { key: 'tv', title: 'Series populer', forced: 'tv', path: '/tv/popular', p: {} },
    { key: 'cinema', title: 'Sedang tayang di bioskop', forced: 'movie', path: '/movie/now_playing', p: { region: REGION } },
  ];
  const settled = await Promise.allSettled(calls.map((c) => tmdb(c.path, Object.assign({ language: LANG, page: '1' }, c.p))));
  const rows = [];
  let firstErr = null;
  settled.forEach((s, i) => {
    if (s.status === 'rejected') { firstErr = firstErr || s.reason; return; }
    const items = cards(s.value.results, calls[i].forced).filter((x) => x.poster).slice(0, 18);
    if (items.length) rows.push({ key: calls[i].key, title: calls[i].title, items });
  });
  if (!rows.length) throw firstErr instanceof ApiError ? firstErr : new ApiError(502, 'tmdb_empty', 'Data film belum tersedia saat ini.');
  return { rows };
}

async function actionList(f) {
  const base = { language: LANG, include_adult: 'false', page: String(f.page) };
  let path, extra = {}, forced = f.type === 'all' ? null : f.type;
  if (f.q) {
    path = f.type === 'movie' ? '/search/movie' : f.type === 'tv' ? '/search/tv' : '/search/multi';
    extra.query = f.q;
    if (f.year && f.type === 'movie') extra.primary_release_year = String(f.year);
    if (f.year && f.type === 'tv') extra.first_air_date_year = String(f.year);
  } else {
    const isMovie = f.type === 'movie';
    path = isMovie ? '/discover/movie' : '/discover/tv';
    const dateField = isMovie ? 'primary_release_date' : 'first_air_date';
    if (f.sort === 'popularity') extra.sort_by = 'popularity.desc';
    else if (f.sort === 'rating') { extra.sort_by = 'vote_average.desc'; extra['vote_count.gte'] = isMovie ? '300' : '200'; }
    else { extra.sort_by = dateField + '.desc'; extra[dateField + '.lte'] = today(); extra['vote_count.gte'] = '10'; }
    if (f.genre) extra.with_genres = String(f.genre);
    if (f.year) extra[isMovie ? 'primary_release_year' : 'first_air_date_year'] = String(f.year);
  }
  const j = await tmdb(path, Object.assign(base, extra));
  let items = cards(j.results, forced);
  // Endpoint pencarian TMDB tidak punya filter genre/tahun untuk semua jenis -> saring di halaman ini.
  if (f.q && f.genre) items = items.filter((x) => x.genreIds.includes(f.genre));
  if (f.q && f.year && f.type === 'all') items = items.filter((x) => x.year === f.year);
  items.forEach((x) => { delete x.genreIds; });
  const total = num(j.total_pages) || 1;
  return { items, page: f.page, hasNext: f.page < total && f.page < MAX_PAGE, totalResults: num(j.total_results) };
}

async function actionDetail(type, id) {
  const q = { language: LANG, append_to_response: 'videos,credits,watch/providers', include_video_language: 'id,en,null' };
  const d = await tmdb('/' + type + '/' + id, q);
  if (d.adult === true) throw new ApiError(404, 'not_found', 'Data tidak ditemukan.');
  if (!d.overview) {                                     // sinopsis Indonesia kosong -> coba bahasa Inggris
    try {
      const en = await tmdb('/' + type + '/' + id, { language: FALLBACK_LANG });
      if (en.overview) d.overview = en.overview;
    } catch (e) { /* biarkan kosong */ }
  }
  return { item: normalizeDetail(d, type, d['watch/providers']) };
}

async function actionSeason(id, n) {
  const d = await tmdb('/tv/' + id + '/season/' + n, { language: LANG });
  const eps = Array.isArray(d.episodes) ? d.episodes.slice(0, 120).map((e) => ({
    number: num(e && e.episode_number), name: str(e && e.name, 160) || 'Episode ' + (e && e.episode_number),
    airDate: str(e && e.air_date, 10) || null, runtime: num(e && e.runtime) && e.runtime > 0 ? e.runtime : null,
    rating: num(e && e.vote_average) !== null && Number(e.vote_count) > 0 ? round1(e.vote_average) : null,
    overview: str(e && e.overview, 400), still: img(e && e.still_path, 'w300'),
  })).filter((e) => e.number !== null) : [];
  return { season: { number: n, name: str(d.name, 100) || 'Season ' + n, overview: str(d.overview, 600), episodes: eps } };
}

function actionMeta() {
  const mk = (l) => l.map(([id, name]) => ({ id, name }));
  return { genres: { movie: mk(MOVIE_GENRES), tv: mk(TV_GENRES) }, sorts: [{ id: 'popularity', name: 'Populer' }, { id: 'rating', name: 'Rating tertinggi' }, { id: 'newest', name: 'Terbaru' }], region: REGION };
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

async function handler(req, res) {
  try {
    res.setHeader('x-robots-tag', 'noindex');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      return send(res, 405, { ok: false, code: 'method', error: 'Metode tidak diizinkan.' });
    }
    const sp = params(req.url);
    const action = sp.get('action') || 'list';
    if (action === 'meta') return send(res, 200, Object.assign({ ok: true }, actionMeta()), 'public, s-maxage=86400, stale-while-revalidate=86400');
    if (limited(clientIp(req), 60, 60000)) throw new ApiError(429, 'rate', 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.');

    if (action === 'home') return send(res, 200, Object.assign({ ok: true }, await actionHome()), 'public, s-maxage=3600, stale-while-revalidate=3600');
    if (action === 'list') return send(res, 200, Object.assign({ ok: true }, await actionList(parseList(sp))), 'public, s-maxage=1800, stale-while-revalidate=1800');
    if (action === 'detail') {
      const type = parseType(sp, false);
      const id = intIn(sp.get('id'), 1, 999999999, 'bad_id', 'ID tidak valid.');
      return send(res, 200, Object.assign({ ok: true }, await actionDetail(type, id)), 'public, s-maxage=21600, stale-while-revalidate=21600');
    }
    if (action === 'season') {
      const id = intIn(sp.get('id'), 1, 999999999, 'bad_id', 'ID tidak valid.');
      const n = intIn(sp.get('season'), 0, 60, 'bad_season', 'Nomor season tidak valid.');
      return send(res, 200, Object.assign({ ok: true }, await actionSeason(id, n)), 'public, s-maxage=21600, stale-while-revalidate=21600');
    }
    throw new ApiError(400, 'bad_action', 'Aksi tidak dikenal.');
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.extra && e.extra.retryAfter) res.setHeader('retry-after', String(e.extra.retryAfter));
      return send(res, e.status, { ok: false, code: e.code, error: e.message });
    }
    console.error('film api error');
    return send(res, 500, { ok: false, code: 'internal', error: 'Terjadi kesalahan di server.' });
  }
}

module.exports = handler;
module.exports.__test = { parseList, card, normalizeDetail, pickTrailer, watchInfo, img, safeHttps, tmdbLink, actionMeta, isJwt, resetLimit() { hits.clear(); } };
