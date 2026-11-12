import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { test } from 'node:test';
import { createResolverServer } from '../dist/server.js';

const ACCESS_ID = '11111111-2222-4333-8444-555555555555';
const TTL_MS = 5 * 60_000;
const CLIENT_HEADERS = { 'user-agent': 'cache-test-client', accept: 'text/plain' };

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler, timeoutMs = 1000) {
  const calls = [];
  const source = await listen(t, createServer((req, res) => {
    calls.push(req.url);
    handler(req, res);
  }));
  const base = await listen(t, createResolverServer({ accessId: ACCESS_ID, timeoutMs }));
  return { base, source, calls };
}

function resolverUrl(base, sources, noCache = false) {
  const url = new URL(`/${ACCESS_ID}/`, base);
  for (const source of sources) url.searchParams.append('subs', source);
  if (noCache) url.searchParams.set('no_cache', '1');
  return url.href;
}

async function query(f, sources, { noCache = false, headers = CLIENT_HEADERS } = {}) {
  const response = await fetch(resolverUrl(f.base, sources, noCache), {
    redirect: 'manual',
    signal: AbortSignal.timeout(4000),
    headers,
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    cacheControl: response.headers.get('cache-control'),
    bytes: (await response.arrayBuffer()).byteLength,
  };
}

function assertSelected(result, source) {
  assert.equal(result.status, 302);
  assert.equal(result.location, new URL(source).href);
  assert.equal(result.cacheControl, 'no-store');
  assert.equal(result.bytes, 0);
}

test('reuses positive and negative availability flags without refetching or returning source bodies', { timeout: 5000 }, async (t) => {
  const healthy = { '/primary': false, '/backup': true };
  const f = await fixture(t, (req, res) => {
    res.writeHead(healthy[req.url] ? 200 : 503).end('upstream subscription or error');
  });
  const primary = `${f.source}/primary`;
  const backup = `${f.source}/backup`;
  assertSelected(await query(f, [primary, backup]), backup);
  assert.equal(f.calls.length, 2);

  healthy['/primary'] = true;
  healthy['/backup'] = false;
  assertSelected(await query(f, [primary, backup]), backup);
  assert.equal((await query(f, [primary])).status, 503);
  assertSelected(await query(f, [backup]), backup);
  assert.equal(f.calls.length, 2);
});

test('no_cache=1 bypasses cached reads and refreshes both failed and successful flags', { timeout: 5000 }, async (t) => {
  let healthy = false;
  const f = await fixture(t, (_req, res) => res.writeHead(healthy ? 200 : 503).end('body'));
  const source = `${f.source}/subscription`;
  assert.equal((await query(f, [source])).status, 503);
  healthy = true;
  assert.equal((await query(f, [source])).status, 503);
  assert.equal(f.calls.length, 1);
  assertSelected(await query(f, [source], { noCache: true }), source);
  assert.equal(f.calls.length, 2);

  healthy = false;
  assertSelected(await query(f, [source]), source);
  assert.equal((await query(f, [source], { noCache: true })).status, 503);
  assert.equal(f.calls.length, 3);
  healthy = true;
  assert.equal((await query(f, [source])).status, 503);
  assertSelected(await query(f, [source], { noCache: true }), source);
  assertSelected(await query(f, [source]), source);
  assert.deepEqual(f.calls, Array(4).fill('/subscription'));
});

test('positive and negative entries expire after five minutes measured from probe completion', { timeout: 5000 }, async (t) => {
  const start = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: start });
  let healthy = true;
  let completeFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const f = await fixture(t, (_req, res) => {
    if (f.calls.length === 1) {
      completeFirst = () => res.end('subscription');
      markStarted();
    } else {
      res.writeHead(healthy ? 200 : 503).end('body');
    }
  });
  const source = `${f.source}/subscription`;
  const first = query(f, [source]);
  await started;
  const completed = start + 60_000;
  t.mock.timers.setTime(completed);
  completeFirst();
  assertSelected(await first, source);

  healthy = false;
  t.mock.timers.setTime(start + TTL_MS + 1);
  assertSelected(await query(f, [source]), source);
  assert.equal(f.calls.length, 1);
  t.mock.timers.setTime(completed + TTL_MS);
  assert.equal((await query(f, [source])).status, 503);
  assert.equal(f.calls.length, 2);

  healthy = true;
  t.mock.timers.setTime(completed + 2 * TTL_MS - 1);
  assert.equal((await query(f, [source])).status, 503);
  assert.equal(f.calls.length, 2);
  t.mock.timers.setTime(completed + 2 * TTL_MS);
  assertSelected(await query(f, [source]), source);
  assert.equal(f.calls.length, 3);
});

test('caches timeout, connection and empty-body failures, and refreshes them on bypass', { timeout: 5000 }, async (t) => {
  let recovered = false;
  const f = await fixture(t, (req, res) => {
    if (recovered) res.end('subscription');
    else if (req.url === '/empty') res.end();
    else if (req.url === '/broken') req.socket.destroy();
    // /hanging intentionally never sends headers until the attempt times out.
  }, 150);
  const sources = ['/empty', '/broken', '/hanging'].map((path) => f.source + path);
  assert.equal((await query(f, sources)).status, 503);
  assert.equal(f.calls.length, 3);
  recovered = true;
  assert.equal((await query(f, sources)).status, 503);
  assert.equal(f.calls.length, 3);
  assertSelected(await query(f, sources, { noCache: true }), sources[0]);
  assertSelected(await query(f, sources), sources[0]);
  assert.equal(f.calls.length, 6);
});

test('keys flags by canonical full URL, User-Agent and Accept independently', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (_req, res) => res.end('subscription'));
  const sources = [
    `${f.source}/sub/a?format=x&tag=a%2Fb`,
    `${f.source}/sub/b?format=x&tag=a%2Fb`,
    `${f.source}/sub/a?format=y&tag=a%2Fb`,
  ];
  for (const source of sources) assertSelected(await query(f, [source]), source);
  assert.equal(f.calls.length, 3);
  const equivalent = sources[0].replace(/^http:/, 'HTTP:');
  assertSelected(await query(f, [equivalent]), sources[0]);
  assert.equal(f.calls.length, 3);

  const variants = [
    { 'user-agent': 'another-client', accept: 'text/plain' },
    { 'user-agent': 'another-client', accept: 'application/json' },
    { 'user-agent': CLIENT_HEADERS['user-agent'], accept: 'application/json' },
  ];
  for (const headers of variants) assertSelected(await query(f, [sources[0]], { headers }), sources[0]);
  assert.equal(f.calls.length, 6);
  for (const source of sources) assertSelected(await query(f, [source]), source);
  for (const headers of variants) assertSelected(await query(f, [sources[0]], { headers }), sources[0]);
  assert.equal(f.calls.length, 6);
});

test('client disconnect does not cache an unfinished source as unavailable', { timeout: 5000 }, async (t) => {
  let recovered = false;
  let markStarted;
  let markClosed;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    if (recovered) res.end('subscription');
    else {
      res.once('close', markClosed);
      res.write('unfinished');
      markStarted();
    }
  }, 3000);
  const source = `${f.source}/subscription`;
  const client = get(resolverUrl(f.base, [source]), { headers: CLIENT_HEADERS });
  client.on('error', () => {});
  t.after(() => client.destroy());
  await started;
  client.destroy();
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Upstream did not close after client disconnect')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  recovered = true;
  assertSelected(await query(f, [source]), source);
  assertSelected(await query(f, [source]), source);
  assert.equal(f.calls.length, 2);
});
