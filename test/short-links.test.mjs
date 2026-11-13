import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { ShortLinks } from '../dist/short-links.js';
import { createResolverServer } from '../dist/server.js';
import { generateShortName } from '../public/index.js';

async function storage(t) {
  const dir = await mkdtemp(join(tmpdir(), 'short-links-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'links.json');
  return { dir, file, store: await ShortLinks.load(file) };
}

test('persistent links, export and restore preserve all names and updated destinations', async (t) => {
  const { dir, file, store } = await storage(t);
  await store.save('ABC', 'https://example.com/first', true);
  await store.save('__proto__', 'https://example.com/proto', true);
  await store.save('export', 'https://example.com/export', true);
  await store.save('ABC', 'https://example.com/new?q=1#fragment', false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await ShortLinks.load(file)).export(), store.export());
  const restored = join(dir, 'restored.json');
  await writeFile(restored, store.export());
  assert.equal((await ShortLinks.load(restored)).get('ABC'), 'https://example.com/new?q=1#fragment');
  assert.equal(JSON.parse(store.export()).links.__proto__, 'https://example.com/proto');
});

test('concurrent creates cannot overwrite an existing name; failed saves retain memory and allow retry', async (t) => {
  const { file, store } = await storage(t);
  const results = await Promise.allSettled([
    store.save('ABC', 'https://example.com/one', true),
    store.save('ABC', 'https://example.com/two', true),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.status, 409);
  await assert.rejects(store.save('missing', 'https://example.com/', false), { status: 404 });
  const saved = await readFile(file, 'utf8');
  await rm(file);
  await mkdir(file);
  await assert.rejects(store.save('ABC', 'https://example.com/new', false));
  assert.equal(store.get('ABC'), 'https://example.com/one');
  await rm(file, { recursive: true });
  await writeFile(file, saved);
  await store.save('ABC', 'https://example.com/new', false);
  assert.equal((await ShortLinks.load(file)).get('ABC'), 'https://example.com/new');
});

test('corrupt storage fails closed without rewriting the original file', async (t) => {
  const { file } = await storage(t);
  await writeFile(file, '{broken');
  await assert.rejects(ShortLinks.load(file), /Cannot load/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('short API: create/check/edit, private export, validation and public noncached redirect', async (t) => {
  const { store } = await storage(t);
  const server = createResolverServer({ accessId: 'test-secret', timeoutMs: 500, shortLinks: store });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = '/test-secret/api/short-links/';
  const get = (path) => fetch(origin + path, { redirect: 'manual' });
  const save = (name, url, method = 'POST', headers = {}) => fetch(origin + api + 'item/' + name, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ url }),
  });
  assert.deepEqual(await (await get(api + 'item/ABC')).json(), { exists: false });
  assert.equal((await save('ABC', 'https://example.com/old')).status, 201);
  assert.equal((await save('ABC', 'https://example.com/overwrite')).status, 409);
  assert.equal((await save('missing', 'https://example.com/', 'PUT')).status, 404);
  assert.equal((await save('ABC', 'https://example.com/new', 'PUT')).status, 200);
  assert.deepEqual(await (await get(api + 'item/ABC')).json(), { exists: true, url: 'https://example.com/new' });
  const redirect = await get('/s/ABC?ignored=yes');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://example.com/new');
  assert.equal(redirect.headers.get('cache-control'), 'no-store');
  assert.equal(await redirect.text(), '');
  const exported = await get(api + 'export');
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal(await exported.text(), store.export());
  assert.equal((await get('/wrong/api/short-links/export')).status, 404);
  assert.equal((await get('/s/missing')).status, 404);
  assert.equal((await save('export', 'https://example.com/')).status, 201);
  for (const url of ['javascript:alert(1)', 'https://user:pass@example.com/', 'https://example.com/' + 'x'.repeat(8192), origin + '/s/self']) {
    assert.equal((await save('self', url)).status, 400);
  }
  assert.equal((await save('bad.name', 'https://example.com/')).status, 400);
  assert.equal((await save('cross', 'https://example.com/', 'POST', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await save('type', 'https://example.com/', 'POST', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await save('large', 'x'.repeat(70000))).status, 413);
  assert.equal((await fetch(origin + api + 'item/ABC', { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(origin + api + 'item/ABC', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
});

test('generated names have ten URL-safe characters', () => {
  for (let i = 0; i < 100; i++) assert.match(generateShortName(), /^[A-Za-z0-9_-]{10}$/);
});
