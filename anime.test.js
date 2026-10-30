// Jalankan: node --test tests/anime.test.js
// Jaringan di-mock. Menguji LOGIKA backend, bukan koneksi nyata ke AniList.
const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/anime.js');
const T = handler.__test;

let n = 0;
const req = (url, method = 'GET') => ({ method, url, headers: { 'x-forwarded-for': '10.3.0.' + (++n) }, socket: {} });
const mockRes = () => ({ headers: {}, statusCode: 200, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } });
const resp = (status, obj, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => obj });
const call = async (url) => { const r = mockRes(); await handler(req(url), r); return r; };
const old = global.fetch;
test.beforeEach(() => T.resetLimit());
test.afterEach(() => { global.fetch = old; });

const media = (id, over = {}) => ({ id, title: { romaji: 'Sousou no Frieren', english: 'Frieren', native: '葬送のフリーレン' }, coverImage: { large: 'https://s4.anilist.co/c.jpg' },
  startDate: { year: 2023 }, seasonYear: 2023, genres: ['Adventure', 'Drama', 'Fantasy', 'Slice of Life'], status: 'FINISHED', format: 'TV', episodes: 28, averageScore: 91, ...over });

test('parseList: validasi parameter', () => {
  assert.throws(() => T.parseList('/x?q=' + 'a'.repeat(101)), /panjang/);
  assert.throws(() => T.parseList('/x?genre=Hentai'), /Genre/);
  assert.throws(() => T.parseList('/x?genre=__proto__'), /Genre/);
  assert.throws(() => T.parseList('/x?status=DELETED'), /Status/);
  assert.throws(() => T.parseList('/x?year=1800'), /Tahun/);
  assert.throws(() => T.parseList('/x?year=abcd'), /Tahun/);
  assert.throws(() => T.parseList('/x?sort=hack'), /Pengurutan/);
  assert.throws(() => T.parseList('/x?sort=constructor'), /Pengurutan/);
  assert.throws(() => T.parseList('/x?page=0'), /Halaman/);
  assert.throws(() => T.parseList('/x?page=21'), /Halaman/);
  const ok = T.parseList('/x?q=%20one%20%20piece&genre=Sci-Fi&status=RELEASING&year=2020&sort=score&page=2');
  assert.deepEqual(ok, { q: 'one piece', genre: 'Sci-Fi', status: 'RELEASING', year: 2020, sort: 'SCORE_DESC', page: 2 });
  assert.equal(T.parseList('/x').sort, 'POPULARITY_DESC');            // tanpa q, relevansi -> populer
  assert.equal(T.parseList('/x?q=naruto').sort, 'SEARCH_MATCH');
});

test('parseId', () => {
  assert.equal(T.parseId('/x?q=a'), null);
  assert.equal(T.parseId('/x?id=154587'), 154587);
  for (const b of ['0', '-1', 'abc', '1e3', '123456789', '1;drop', '']) assert.throws(() => T.parseId('/x?id=' + encodeURIComponent(b)), /ID/, b);
});

test('katalog: variabel GraphQL benar, hasil dinormalisasi, isAdult disaring di query', async () => {
  let body;
  global.fetch = async (url, opt) => { assert.equal(url, 'https://graphql.anilist.co'); body = JSON.parse(opt.body);
    return resp(200, { data: { Page: { pageInfo: { hasNextPage: true }, media: [media(1), null, { title: {} }, media(2, { coverImage: { large: 'http://x.com/a.jpg' }, title: { romaji: 'Only Romaji' } })] } } }); };
  const r = await call('/api/anime?q=frieren&genre=Fantasy&year=2023&sort=popularity&page=2');
  const j = JSON.parse(r.body);
  assert.equal(r.statusCode, 200); assert.ok(j.ok);
  assert.match(body.query, /isAdult:false/); assert.match(body.query, /type:ANIME/);
  assert.deepEqual(body.variables, { page: 2, perPage: 18, sort: ['POPULARITY_DESC'], search: 'frieren', genre: 'Fantasy', year: 2023 });
  assert.equal(j.items.length, 2);
  assert.equal(j.items[0].title, 'Frieren'); assert.equal(j.items[0].year, 2023); assert.equal(j.items[0].genres.length, 3);
  assert.equal(j.items[1].title, 'Only Romaji'); assert.equal(j.items[1].cover, null);  // http ditolak
  assert.equal(j.hasNext, true); assert.equal(j.page, 2);
  assert.match(r.headers['cache-control'], /s-maxage/);
});

test('katalog kosong -> 200 items []', async () => {
  global.fetch = async () => resp(200, { data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } });
  const j = JSON.parse((await call('/api/anime?q=zzzzqqq')).body);
  assert.deepEqual(j.items, []); assert.equal(j.hasNext, false);
});

test('detail: trailer, episode, sumber, deskripsi dibersihkan, tautan tidak aman dibuang', async () => {
  const m = { ...media(154587), isAdult: false, synonyms: ['Frieren: Beyond Journey’s End', 'Frieren'], description: 'Elf &amp; penyihir.<br><br>Kisah <i>baru</i><script>x</script>',
    coverImage: { extraLarge: 'https://s4.anilist.co/xl.jpg', large: 'https://s4.anilist.co/l.jpg' }, studios: { nodes: [{ name: 'Madhouse' }] },
    trailer: { id: 'abcdefghijk', site: 'youtube' },
    streamingEpisodes: [{ title: 'Episode 1 - Tamat', site: 'Crunchyroll', url: 'https://www.crunchyroll.com/x', thumbnail: 'https://img.cr/t.jpg' },
      { title: 'Bahaya', site: 'X', url: 'javascript:alert(1)' }, { title: 'IP', site: 'X', url: 'https://127.0.0.1/a' }, { title: 'http', site: 'X', url: 'http://a.com/x' }],
    externalLinks: [{ site: 'Netflix', url: 'https://www.netflix.com/title/1', type: 'STREAMING' }, { site: 'Netflix', url: 'https://www.netflix.com/title/2', type: 'STREAMING' },
      { site: 'Twitter', url: 'https://twitter.com/x', type: 'SOCIAL' }], siteUrl: 'https://anilist.co/anime/154587' };
  let body; global.fetch = async (u, o) => { body = JSON.parse(o.body); return resp(200, { data: { Media: m } }); };
  const j = JSON.parse((await call('/api/anime?id=154587')).body);
  assert.deepEqual(body.variables, { id: 154587 });
  const a = j.anime;
  assert.equal(a.trailerId, 'abcdefghijk');
  assert.equal(a.episodeLinks.length, 1); assert.equal(a.episodeLinks[0].site, 'Crunchyroll');
  assert.deepEqual(a.sources, [{ site: 'Netflix', url: 'https://www.netflix.com/title/1' }]);
  assert.equal(a.description, 'Elf & penyihir.\n\nKisah baru');
  assert.ok(a.altTitles.includes('Sousou no Frieren')); assert.ok(!a.altTitles.includes('Frieren'));
  assert.equal(a.studios[0], 'Madhouse'); assert.equal(a.cover, 'https://s4.anilist.co/xl.jpg');
});

test('detail: trailer non-YouTube / id aneh ditolak; episode & sumber kosong -> array kosong', async () => {
  for (const tr of [{ id: 'abc', site: 'youtube' }, { id: 'abcdefghijk', site: 'dailymotion' }, { id: '"><script>', site: 'youtube' }, null]) {
    global.fetch = async () => resp(200, { data: { Media: { ...media(5), isAdult: false, trailer: tr } } });
    const a = JSON.parse((await call('/api/anime?id=5')).body).anime;
    assert.equal(a.trailerId, null); assert.deepEqual(a.episodeLinks, []); assert.deepEqual(a.sources, []);
  }
});

test('detail: tidak ditemukan / dewasa -> 404', async () => {
  global.fetch = async () => resp(404, { errors: [{ message: 'Not Found.', status: 404 }], data: { Media: null } });
  assert.equal((await call('/api/anime?id=99999999')).statusCode, 404);
  global.fetch = async () => resp(200, { data: { Media: { ...media(7), isAdult: true } } });
  assert.equal((await call('/api/anime?id=7')).statusCode, 404);
  global.fetch = async () => resp(200, { data: { Media: null } });
  assert.equal((await call('/api/anime?id=8')).statusCode, 404);
});

test('error upstream: 429 (+retry-after), 403, 500, jaringan, respons rusak', async () => {
  global.fetch = async () => resp(429, {}, { 'retry-after': '60' });
  let r = await call('/api/anime?q=a'); assert.equal(r.statusCode, 429); assert.equal(r.headers['retry-after'], '60');
  global.fetch = async () => resp(403, { errors: [{ message: 'disabled' }] });
  r = await call('/api/anime?q=a'); assert.equal(r.statusCode, 503);
  global.fetch = async () => resp(500, {});
  r = await call('/api/anime?q=a'); assert.equal(r.statusCode, 502);
  global.fetch = async () => { throw new Error('net'); };
  r = await call('/api/anime?q=a'); assert.equal(r.statusCode, 502);
  global.fetch = async () => resp(200, { foo: 1 });
  r = await call('/api/anime?q=a'); assert.equal(r.statusCode, 502);
});

test('input buruk ditolak sebelum memanggil AniList', async () => {
  global.fetch = async () => { throw new Error('tidak boleh dipanggil'); };
  for (const u of ['/api/anime?genre=x', '/api/anime?id=abc', '/api/anime?year=2999', '/api/anime?q=' + 'a'.repeat(200)])
    assert.equal((await call(u)).statusCode, 400, u);
});

test('POST 405; rate limit 31 request -> 429', async () => {
  const r = mockRes(); await handler(req('/api/anime', 'POST'), r); assert.equal(r.statusCode, 405);
  const same = { method: 'GET', url: '/api/anime?genre=bad', headers: { 'x-forwarded-for': '5.5.5.5' }, socket: {} };
  let last; for (let i = 0; i < 31; i++) { last = mockRes(); await handler(same, last); }
  assert.equal(last.statusCode, 429);
});
