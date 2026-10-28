// Jalankan: node --test tests/spotify.test.js
// Jaringan di-mock. Ini menguji LOGIKA backend, bukan koneksi nyata ke Spotify.
process.env.SPOTIFY_CLIENT_ID = 'test-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/spotify.js');
const T = handler.__test;

let ipN = 0;
const req = (url, method = 'GET') => ({ method, url, headers: { 'x-forwarded-for': '10.1.0.' + (++ipN) }, socket: {} });
const mockRes = () => ({ headers: {}, statusCode: 200, body: '',
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } });
const resp = (status, obj, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => obj });
const ID = 'a'.repeat(22);
const track = (over = {}) => ({ id: ID, name: 'Lagu', artists: [{ name: 'A' }, { name: 'B' }], duration_ms: 185000, explicit: false,
  album: { name: 'Album', images: [{ url: 'https://i.scdn.co/640' }, { url: 'https://i.scdn.co/300' }, { url: 'https://i.scdn.co/64' }] },
  external_urls: { spotify: 'https://open.spotify.com/track/' + ID }, ...over });
const call = async (url) => { const r = mockRes(); await handler(req(url), r); return r; };
const old = global.fetch;
test.beforeEach(() => T.resetToken());
test.afterEach(() => { global.fetch = old; });

test('parseInput: kosong, terlalu panjang, offset salah', () => {
  assert.throws(() => T.parseInput('/api/spotify'), /Ketik/);
  assert.throws(() => T.parseInput('/api/spotify?q=%20%20'), /Ketik/);
  assert.throws(() => T.parseInput('/api/spotify?q=' + 'a'.repeat(101)), /panjang/);
  assert.throws(() => T.parseInput('/api/spotify?q=a&offset=-1'), /tidak valid/);
  assert.throws(() => T.parseInput('/api/spotify?q=a&offset=91'), /tidak valid/);
  assert.deepEqual(T.parseInput('/api/spotify?q=%20hello%20%20world%0A&offset=20'), { q: 'hello world', offset: 20 });
});

test('sukses: token diminta sekali, hasil dinormalisasi, limit=10', async () => {
  let tokenCalls = 0, searchUrl = '', auth = '';
  global.fetch = async (url, opt) => {
    if (url.startsWith('https://accounts.spotify.com/api/token')) {
      tokenCalls++; assert.match(opt.headers.authorization, /^Basic /);
      assert.equal(Buffer.from(opt.headers.authorization.slice(6), 'base64').toString(), 'test-id:test-secret');
      assert.equal(opt.body, 'grant_type=client_credentials');
      return resp(200, { access_token: 'TOK', expires_in: 3600 });
    }
    searchUrl = url; auth = opt.headers.authorization;
    return resp(200, { tracks: { total: 25, items: [track(), null, track({ id: 'bad' })] } });
  };
  let r = await call('/api/spotify?q=sheila');
  const j = JSON.parse(r.body);
  assert.equal(r.statusCode, 200); assert.ok(j.ok);
  assert.equal(j.tracks.length, 1);
  assert.equal(j.tracks[0].artists, 'A, B');
  assert.equal(j.tracks[0].cover, 'https://i.scdn.co/300');
  assert.match(searchUrl, /type=track/); assert.match(searchUrl, /limit=10/); assert.match(searchUrl, /q=sheila/);
  assert.equal(auth, 'Bearer TOK');
  assert.match(r.headers['cache-control'], /s-maxage/);
  await call('/api/spotify?q=sheila2');
  assert.equal(tokenCalls, 1, 'token harus di-cache');
});

test('hasMore dan nextOffset', async () => {
  global.fetch = async (url) => url.includes('/token') ? resp(200, { access_token: 'T', expires_in: 3600 })
    : resp(200, { tracks: { total: 25, items: Array.from({ length: 10 }, () => track()) } });
  const j = JSON.parse((await call('/api/spotify?q=x&offset=10')).body);
  assert.equal(j.nextOffset, 20); assert.equal(j.hasMore, true);
});

test('hasil kosong -> 200 dengan tracks []', async () => {
  global.fetch = async (url) => url.includes('/token') ? resp(200, { access_token: 'T', expires_in: 3600 }) : resp(200, { tracks: { total: 0, items: [] } });
  const r = await call('/api/spotify?q=zzzzzz');
  assert.equal(r.statusCode, 200); assert.deepEqual(JSON.parse(r.body).tracks, []);
});

test('401 saat search -> token diperbarui lalu coba lagi sekali', async () => {
  let tokens = 0, searches = 0;
  global.fetch = async (url) => {
    if (url.includes('/token')) { tokens++; return resp(200, { access_token: 'T' + tokens, expires_in: 3600 }); }
    searches++; return searches === 1 ? resp(401, {}) : resp(200, { tracks: { total: 1, items: [track()] } });
  };
  const r = await call('/api/spotify?q=x');
  assert.equal(r.statusCode, 200); assert.equal(tokens, 2); assert.equal(searches, 2);
});

test('429 dari Spotify -> 429 + retry-after', async () => {
  global.fetch = async (url) => url.includes('/token') ? resp(200, { access_token: 'T', expires_in: 3600 }) : resp(429, {}, { 'retry-after': '7' });
  const r = await call('/api/spotify?q=x');
  assert.equal(r.statusCode, 429); assert.equal(r.headers['retry-after'], '7');
});

test('403 dari Spotify -> 503 pesan aman', async () => {
  global.fetch = async (url) => url.includes('/token') ? resp(200, { access_token: 'T', expires_in: 3600 }) : resp(403, {});
  const r = await call('/api/spotify?q=x');
  assert.equal(r.statusCode, 503); assert.doesNotMatch(r.body, /secret|premium/i);
});

test('kredensial salah (token 401) -> 503 tanpa membocorkan detail', async () => {
  global.fetch = async () => resp(401, { error: 'invalid_client' });
  const r = await call('/api/spotify?q=x');
  assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.body).code, 'bad_credentials');
});

test('jaringan putus / respons rusak -> 502', async () => {
  global.fetch = async () => { throw new Error('net'); };
  assert.equal((await call('/api/spotify?q=x')).statusCode, 502);
  T.resetToken();
  global.fetch = async (url) => url.includes('/token') ? resp(200, { access_token: 'T', expires_in: 3600 }) : resp(200, { foo: 1 });
  assert.equal((await call('/api/spotify?q=x')).statusCode, 502);
});

test('env belum diset -> 503 not_configured', async () => {
  const a = process.env.SPOTIFY_CLIENT_ID; delete process.env.SPOTIFY_CLIENT_ID;
  global.fetch = async () => { throw new Error('tidak boleh dipanggil'); };
  const r = await call('/api/spotify?q=x');
  process.env.SPOTIFY_CLIENT_ID = a;
  assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.body).code, 'not_configured');
});

test('metode non-GET -> 405; input kosong -> 400', async () => {
  let r = mockRes(); await handler(req('/api/spotify?q=x', 'POST'), r); assert.equal(r.statusCode, 405);
  r = await call('/api/spotify?q='); assert.equal(r.statusCode, 400);
});

test('rate limit: permintaan ke-21 dari IP sama -> 429', async () => {
  const same = { method: 'GET', url: '/api/spotify?q=', headers: { 'x-forwarded-for': '8.8.8.8' }, socket: {} };
  let last; for (let i = 0; i < 21; i++) { last = mockRes(); await handler(same, last); }
  assert.equal(last.statusCode, 429); assert.equal(JSON.parse(last.body).code, 'rate');
});

test('secret tidak pernah muncul di respons', async () => {
  global.fetch = async (url) => url.includes('/token') ? resp(200, { access_token: 'T', expires_in: 3600 }) : resp(200, { tracks: { total: 1, items: [track()] } });
  const r = await call('/api/spotify?q=x');
  assert.doesNotMatch(r.body, /test-secret|Bearer|access_token/);
});
