// Jalankan: SIGNING_SECRET=test-secret-test-secret-test-secret-123 node --test tests/
// Semua jaringan di-mock. Tes ini memeriksa LOGIKA backend, bukan keberhasilan provider nyata.
process.env.SIGNING_SECRET = process.env.SIGNING_SECRET || 'test-secret-test-secret-test-secret-123';
const test = require('node:test');
const assert = require('node:assert');
const handler = require('../api/tiktok.js');
const T = handler.__test;

function mockRes() {
  const r = { headers: {}, statusCode: 200, body: '', headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b || ''; this.done = true; },
    on() {}, destroy() {} };
  return r;
}
let ipN = 0;
const req = (url) => ({ method: 'GET', url, headers: { 'x-forwarded-for': '10.0.0.' + (++ipN) }, socket: {} });
const jsonFetch = (obj, status = 200) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(obj), headers: new Map(), body: null });

test('parseTikTokUrl menerima format valid', () => {
  for (const u of ['https://www.tiktok.com/@a.b/video/7050551461734042926', 'tiktok.com/@x/video/7050551461734042926?lang=id',
    'https://vm.tiktok.com/ZSabc123/', 'https://vt.tiktok.com/ZSabc123/', 'https://www.tiktok.com/t/ZTabc123/'])
    assert.ok(T.parseTikTokUrl(u), u);
});
test('parseTikTokUrl menolak URL salah / berbahaya', () => {
  for (const u of ['', 'halo', 'https://evil.com/@a/video/7050551461734042926', 'https://tiktok.com.evil.com/@a/video/7050551461734042926',
    'https://evil.com/?https://tiktok.com/@a/video/7050551461734042926', 'http://127.0.0.1/@a/video/7050551461734042926',
    'https://user:pw@www.tiktok.com/@a/video/7050551461734042926', 'https://www.tiktok.com/@a', 'javascript:alert(1)', 'a'.repeat(600)])
    assert.equal(T.parseTikTokUrl(u), null, u);
});
test('safeMediaUrl menolak http, IP, localhost, port aneh', () => {
  for (const u of ['http://cdn.x.com/a.mp4', 'https://127.0.0.1/a.mp4', 'https://localhost/a', 'https://169.254.169.254/latest', 'https://[::1]/a', 'https://cdn.x.com:8443/a', 'https://u:p@cdn.x.com/a'])
    assert.equal(T.safeMediaUrl(u), null, u);
  assert.ok(T.safeMediaUrl('https://v16.tiktokcdn.com/a.mp4'));
});
test('token: valid, dirusak, kedaluwarsa', () => {
  const t = T.sign({ u: 'https://a.com/x.mp4', e: Math.floor(Date.now() / 1000) + 60, n: 'x' });
  assert.ok(T.verify(t));
  assert.equal(T.verify(t.slice(0, -2) + 'xx'), null);
  assert.equal(T.verify(T.sign({ u: 'https://a.com', e: 1, n: 'x' })), null);
  assert.equal(T.verify('abc'), null);
});
test('resolveShort menolak redirect ke domain non-TikTok', async () => {
  const old = global.fetch;
  global.fetch = async () => ({ status: 302, headers: { get: () => 'https://evil.com/steal' }, body: null });
  const u = new URL('https://vm.tiktok.com/ZSabc123/');
  const r = await T.resolveShort(u);
  assert.equal(r.hostname, 'vm.tiktok.com');
  global.fetch = old;
});
test('resolveShort mengikuti redirect ke link video TikTok', async () => {
  const old = global.fetch;
  global.fetch = async () => ({ status: 301, headers: { get: () => 'https://www.tiktok.com/@a/video/7050551461734042926?utm=1' }, body: null });
  const r = await T.resolveShort(new URL('https://vm.tiktok.com/ZSabc123/'));
  assert.equal(r.pathname, '/@a/video/7050551461734042926');
  assert.equal(r.search, '');
  global.fetch = old;
});
test('handler: URL salah -> 400', async () => {
  const res = mockRes(); await handler(req('/api/tiktok?url=https://evil.com'), res);
  assert.equal(res.statusCode, 400); assert.equal(JSON.parse(res.body).code, 'bad_url');
});
test('handler: respons provider sukses (MOCK) -> 200 dengan token', async () => {
  const old = global.fetch;
  global.fetch = jsonFetch({ code: 0, data: { id: '7050551461734042926', title: 'Tes', cover: 'https://p16.tiktokcdn.com/c.jpg', duration: 12,
    play: '/video/media/play/abc.mp4', hdplay: 'https://v16.tiktokcdn.com/hd.mp4', author: { nickname: 'A', unique_id: 'a' }, play_count: 1500 } });
  const res = mockRes(); await handler(req('/api/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7050551461734042926')), res);
  global.fetch = old;
  const j = JSON.parse(res.body);
  assert.equal(res.statusCode, 200); assert.ok(j.ok); assert.ok(j.sd.token); assert.ok(j.hd.token); assert.ok(j.previewToken);
  assert.ok(j.sd.direct.startsWith('https://www.tikwm.com/'));
});
test('handler: provider code != 0 -> 422', async () => {
  const old = global.fetch; global.fetch = jsonFetch({ code: -1, msg: 'Url parsing is failed!' });
  const res = mockRes(); await handler(req('/api/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7050551461734042926')), res);
  global.fetch = old; assert.equal(res.statusCode, 422);
});
test('handler: provider down / 5xx / non-JSON / limit', async () => {
  const old = global.fetch; const link = '/api/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7050551461734042926');
  global.fetch = async () => { throw new Error('boom'); };
  let res = mockRes(); await handler(req(link), res); assert.equal(res.statusCode, 502);
  global.fetch = jsonFetch({}, 500); res = mockRes(); await handler(req(link), res); assert.equal(res.statusCode, 502);
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>', headers: new Map(), body: null });
  res = mockRes(); await handler(req(link), res); assert.equal(res.statusCode, 502);
  global.fetch = jsonFetch({}, 429); res = mockRes(); await handler(req(link), res); assert.equal(res.statusCode, 429);
  global.fetch = old;
});
test('handler: slideshow/foto ditolak', async () => {
  const old = global.fetch; global.fetch = jsonFetch({ code: 0, data: { id: '1', images: ['a'], play: 'https://x.com/m.mp3' } });
  const res = mockRes(); await handler(req('/api/tiktok?url=' + encodeURIComponent('https://www.tiktok.com/@a/video/7050551461734042926')), res);
  global.fetch = old; assert.equal(res.statusCode, 422); assert.equal(JSON.parse(res.body).code, 'photo');
});
test('handler: stream menolak token palsu / tanpa token', async () => {
  let res = mockRes(); await handler(req('/api/tiktok?t=palsu.palsu'), res); assert.equal(res.statusCode, 403);
  res = mockRes(); await handler({ ...req('/api/tiktok'), method: 'POST' }, res); assert.equal(res.statusCode, 405);
});
test('rate limit: request ke-13 dari IP sama -> 429', async () => {
  const same = { method: 'GET', url: '/api/tiktok?url=x', headers: { 'x-forwarded-for': '9.9.9.9' }, socket: {} };
  let last; for (let i = 0; i < 13; i++) { last = mockRes(); await handler(same, last); }
  assert.equal(last.statusCode, 429);
});
