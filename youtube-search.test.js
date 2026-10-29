// Jalankan: node --test tests/youtube-search.test.js
// Jaringan di-mock. Menguji LOGIKA backend, bukan koneksi nyata ke YouTube.
process.env.YOUTUBE_API_KEY = 'SECRET-KEY-123';
const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/youtube-search.js');
const T = handler.__test;

let n = 0;
const req = (url, method = 'GET') => ({ method, url, headers: { 'x-forwarded-for': '10.2.0.' + (++n) }, socket: {} });
const mockRes = () => ({ headers: {}, statusCode: 200, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ''; } });
const resp = (status, obj) => ({ ok: status < 400, status, json: async () => obj });
const call = async (url) => { const r = mockRes(); await handler(req(url), r); return r; };
const item = (id, over = {}) => ({ id: { videoId: id }, snippet: { title: 'Judul &amp; Lagu &#39;X&#39;', channelTitle: 'Chan', publishedAt: '2025-03-12T10:00:00Z',
  liveBroadcastContent: 'none', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg' } }, ...over } });
const V1 = 'abcdefghijk', V2 = 'ABCDEFGHIJK';
const old = global.fetch;
test.beforeEach(() => T.resetLimit());
test.afterEach(() => { global.fetch = old; });

test('parseInput: validasi', () => {
  assert.throws(() => T.parseInput('/x'), /Ketik/);
  assert.throws(() => T.parseInput('/x?q=' + 'a'.repeat(101)), /panjang/);
  assert.throws(() => T.parseInput('/x?q=a&category=hack'), /Kategori/);
  assert.throws(() => T.parseInput('/x?q=a&category=__proto__'), /Kategori/);
  assert.throws(() => T.parseInput('/x?q=a&order=rating'), /Pengurutan/);
  assert.throws(() => T.parseInput('/x?q=a&pageToken=' + encodeURIComponent('a b&key=1')), /Halaman/);
  assert.deepEqual(T.parseInput('/x?q=%20a%20%20b&category=music&order=date&pageToken=CAoQAA'), { q: 'a b', category: 'music', order: 'date', pageToken: 'CAoQAA' });
});

test('decodeEntities', () => {
  assert.equal(T.decodeEntities('A &amp; B &quot;c&quot; &#39;d&#39; &#x41; &unknown;'), 'A & B "c" \'d\' A &unknown;');
});

test('sukses: parameter ke YouTube benar & hasil dinormalisasi', async () => {
  let url = '';
  global.fetch = async (u) => { url = u; return resp(200, { nextPageToken: 'CAwQAA', items: [item(V1), item(V2, { liveBroadcastContent: 'live' }),
    item('upcomingXXX', { liveBroadcastContent: 'upcoming' }), { id: { channelId: 'x' }, snippet: {} }, item('bad') ] }); };
  const r = await call('/api/youtube-search?q=sheila%20on%207&category=music&order=viewCount&pageToken=CAoQAA');
  const j = JSON.parse(r.body);
  assert.equal(r.statusCode, 200); assert.ok(j.ok);
  const p = new URL(url).searchParams;
  assert.equal(p.get('part'), 'snippet'); assert.equal(p.get('type'), 'video'); assert.equal(p.get('q'), 'sheila on 7');
  assert.equal(p.get('videoCategoryId'), '10'); assert.equal(p.get('order'), 'viewCount'); assert.equal(p.get('maxResults'), '12');
  assert.equal(p.get('videoEmbeddable'), 'true'); assert.equal(p.get('pageToken'), 'CAoQAA');
  assert.equal(new URL(url).origin + new URL(url).pathname, 'https://www.googleapis.com/youtube/v3/search');
  assert.deepEqual(j.items.map((i) => i.id), [V1, V2]);   // hanya video valid, bukan channel / upcoming / id salah
  assert.equal(j.items[0].title, "Judul & Lagu 'X'");
  assert.equal(j.items[0].thumb, 'https://i.ytimg.com/vi/' + V1 + '/mqdefault.jpg');
  assert.equal(j.items[1].live, true);
  assert.equal(j.nextPageToken, 'CAwQAA');
  assert.match(r.headers['cache-control'], /s-maxage/);
});

test('API key tidak bocor di respons (sukses maupun error)', async () => {
  global.fetch = async () => resp(200, { items: [item(V1)] });
  assert.doesNotMatch((await call('/api/youtube-search?q=a')).body, /SECRET-KEY-123|key=/);
  global.fetch = async () => resp(400, { error: { message: 'API key not valid. SECRET-KEY-123', errors: [{ reason: 'keyInvalid' }] } });
  const r = await call('/api/youtube-search?q=b');
  assert.equal(r.statusCode, 503); assert.doesNotMatch(r.body, /SECRET-KEY-123/);
});

test('API key tidak masuk log', async () => {
  const logs = []; const oe = console.error; console.error = (...a) => logs.push(a.join(' '));
  global.fetch = async () => { throw new Error('fetch failed https://x?key=SECRET-KEY-123'); };
  await call('/api/youtube-search?q=c');
  global.fetch = async () => resp(403, { error: { message: 'x SECRET-KEY-123', errors: [{ reason: 'quotaExceeded' }] } });
  await call('/api/youtube-search?q=d');
  console.error = oe;
  assert.ok(logs.length >= 2); assert.doesNotMatch(logs.join('\n'), /SECRET-KEY-123/);
});

test('kuota habis -> 503 quota; invalidPageToken -> 400; 5xx -> 502; network -> 502', async () => {
  global.fetch = async () => resp(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
  let r = await call('/api/youtube-search?q=a'); assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.body).code, 'quota');
  global.fetch = async () => resp(400, { error: { errors: [{ reason: 'invalidPageToken' }] } });
  r = await call('/api/youtube-search?q=a&pageToken=abc'); assert.equal(r.statusCode, 400);
  global.fetch = async () => resp(500, {});
  r = await call('/api/youtube-search?q=a'); assert.equal(r.statusCode, 502);
  global.fetch = async () => { throw new Error('net'); };
  r = await call('/api/youtube-search?q=a'); assert.equal(r.statusCode, 502);
});

test('hasil kosong & respons rusak', async () => {
  global.fetch = async () => resp(200, { items: [] });
  let r = await call('/api/youtube-search?q=zzz'); assert.deepEqual(JSON.parse(r.body).items, []); assert.equal(JSON.parse(r.body).nextPageToken, null);
  global.fetch = async () => resp(200, { foo: 1 });
  r = await call('/api/youtube-search?q=zzz'); assert.equal(r.statusCode, 502);
});

test('env belum diset -> 503 not_configured, fetch tidak dipanggil', async () => {
  const k = process.env.YOUTUBE_API_KEY; delete process.env.YOUTUBE_API_KEY;
  global.fetch = async () => { throw new Error('tidak boleh dipanggil'); };
  const oe = console.error; console.error = () => {};
  const r = await call('/api/youtube-search?q=a');
  console.error = oe; process.env.YOUTUBE_API_KEY = k;
  assert.equal(r.statusCode, 503); assert.equal(JSON.parse(r.body).code, 'not_configured');
});

test('input kosong 400, POST 405, rate limit 429', async () => {
  let r = await call('/api/youtube-search?q='); assert.equal(r.statusCode, 400);
  r = mockRes(); await handler(req('/api/youtube-search?q=a', 'POST'), r); assert.equal(r.statusCode, 405);
  const same = { method: 'GET', url: '/api/youtube-search?q=', headers: { 'x-forwarded-for': '6.6.6.6' }, socket: {} };
  let last; for (let i = 0; i < 21; i++) { last = mockRes(); await handler(same, last); }
  assert.equal(last.statusCode, 429);
});
