import assert from 'node:assert/strict';
import { createServer, get, request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createResolverServer } from '../dist/server.js';

const ACCESS_ID = '11111111-2222-4333-8444-555555555555';
const maxBodyBytes = 2 * 1024 * 1024;

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

async function fixture(t, handlers, timeoutMs = 1000) {
  const calls = [];
  const sources = Object.fromEntries(await Promise.all(Object.entries(handlers).map(async ([name, handler]) => [
    name,
    await listen(t, createServer((req, res) => {
      calls.push({ name, path: req.url, host: req.headers.host });
      handler(req, res);
    })),
  ])));
  const base = await listen(t, createResolverServer({ accessId: ACCESS_ID, timeoutMs }));
  return { base, sources, calls };
}

function route(sources) {
  const query = new URLSearchParams();
  for (const source of sources) query.append('subs', source);
  return `/${ACCESS_ID}/?${query}`;
}

function request(url, options = {}) {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000), ...options });
}

async function assertRedirect(response, source) {
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), new URL(source).href);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
}

function rawRequest(base, path) {
  return new Promise((resolve, reject) => {
    const client = httpRequest(base, { path, signal: AbortSignal.timeout(4000) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    client.on('error', reject);
    client.end();
  });
}

test('tries complete URLs in order, preserving different paths, queries and ports, and returns to the recovered primary', { timeout: 5000 }, async (t) => {
  let primaryHealthy = false;
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => {
      if (!primaryHealthy) res.writeHead(503).end('Unavailable');
      else res.end('primary subscription');
    },
    backup: (_req, res) => res.end('backup subscription'),
    third: (_req, res) => res.end('third subscription'),
  });
  const primaryPath = '/first/account?format=base64&key=primary';
  const backupPath = '/different/client/token?format=clash&key=backup';
  const url = base + route([sources.primary + primaryPath, sources.backup + backupPath, sources.third]);
  assert.notEqual(new URL(sources.primary).port, new URL(sources.backup).port);

  await assertRedirect(await request(url), sources.backup + backupPath);
  primaryHealthy = true;
  await assertRedirect(await request(url), sources.primary + primaryPath);
  assert.deepEqual(calls, [
    { name: 'primary', path: primaryPath, host: new URL(sources.primary).host },
    { name: 'backup', path: backupPath, host: new URL(sources.backup).host },
    { name: 'primary', path: primaryPath, host: new URL(sources.primary).host },
  ]);
});

test('uses each request URL list independently and supports the endpoint with or without a trailing slash', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    alice: (req, res) => res.end(`alice: ${req.url}`),
    bob: (req, res) => res.end(`bob: ${req.url}`),
  });
  const cases = [
    { name: 'alice', path: '/sub/alice?format=base64', trailingSlash: true },
    { name: 'bob', path: '/clients/bob?format=clash&group=mobile', trailingSlash: false },
    { name: 'alice', path: '/', trailingSlash: false },
  ];

  for (const { name, path, trailingSlash } of cases) {
    const endpoint = route([sources[name] + path]);
    const response = await request(base + (trailingSlash ? endpoint : endpoint.replace('/?', '?')));
    await assertRedirect(response, sources[name] + path);
  }
  assert.deepEqual(calls.map(({ name, path }) => ({ name, path })), cases.map(({ name, path }) => ({ name, path })));
});

test('preserves encoded inner URLs and repeated inner parameters while ignoring other outer parameters', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.writeHead(502).end(),
    backup: (req, res) => res.end(req.url),
  });
  const primaryPath = '/sub/user%2Fpart%2Bname?tag=a%2Fb&tag=a%2Bb&tag=a+b&empty=&subs=inner-value';
  const backupPath = '/other/user%23label?key=a%26b&key=c%3Dd&fragment=%23value&last=2';
  const endpoint = route([sources.primary + primaryPath, sources.backup + backupPath]);
  const response = await request(`${base}${endpoint}&format=outer-only&key=do-not-forward`);

  await assertRedirect(response, sources.backup + backupPath);
  assert.deepEqual(calls.map(({ path }) => path), [primaryPath, backupPath]);
});

test('a client following the redirect retrieves the subscription directly from the selected source', { timeout: 5000 }, async (t) => {
  const subscription = 'vless://example-subscription';
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.writeHead(503).end('Unavailable'),
    backup: (_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(subscription),
  });
  const selected = `${sources.backup}/client/subscription?key=a%26b&key=c%2Bd`;
  const response = await request(base + route([sources.primary, selected]), { redirect: 'follow' });

  assert.equal(response.status, 200);
  assert.equal(response.redirected, true);
  assert.equal(response.url, selected);
  assert.equal(await response.text(), subscription);
  // The resolver validates once, and the redirected client then requests it itself.
  assert.deepEqual(calls.map(({ name }) => name), ['primary', 'backup', 'backup']);
  assert.equal(calls[1].path, '/client/subscription?key=a%26b&key=c%2Bd');
  assert.equal(calls[2].path, calls[1].path);
});

test('validates an upstream redirect chain but returns the original source URL in Location', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.writeHead(302, { location: `${sources.landing}/middle?stage=2` }).end(),
    landing: (req, res) => {
      if (req.url === '/middle?stage=2') {
        res.writeHead(307, { location: '/final?key=a%26b&key=c' }).end();
      } else {
        res.end('complete subscription');
      }
    },
  });
  const original = `${sources.primary}/entry?key=original%2Bvalue`;
  const response = await request(base + route([original]));

  await assertRedirect(response, original);
  assert.deepEqual(calls.map(({ name, path }) => ({ name, path })), [
    { name: 'primary', path: '/entry?key=original%2Bvalue' },
    { name: 'landing', path: '/middle?stage=2' },
    { name: 'landing', path: '/final?key=a%26b&key=c' },
  ]);
});

test('normalizes Unicode source URLs into a safe Location without double-encoding existing escapes', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.end('subscription'),
  });
  const source = `${sources.primary}/профиль/用户?имя=Иван&tag=%2F&tag=a%2Bb&tag=a+b`;
  const expected = new URL(source);
  const response = await request(base + route([source]));

  assert.match(response.headers.get('location'), /^[\x20-\x7e]+$/);
  await assertRedirect(response, source);
  assert.equal(calls[0].path, expected.pathname + expected.search);
  assert.ok(expected.search.includes('tag=%2F&tag=a%2Bb&tag=a+b'));
});

test('accepts an HTTPS source and falls back after a TLS failure without restricting IPs or ports', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    // Intentionally HTTP: an HTTPS request to this local port fails its TLS handshake.
    primary: (_req, res) => res.end('plain HTTP source'),
    backup: (_req, res) => res.end('HTTP backup'),
  }, 200);
  const secureUrl = sources.primary.replace('http:', 'https:') + '/secure/subscription?key=one';
  const response = await request(base + route([secureUrl, `${sources.backup}/backup?key=two`]));

  await assertRedirect(response, `${sources.backup}/backup?key=two`);
  assert.deepEqual(calls.map(({ name }) => name), ['backup']);
});

test('allows a TLS connection to wait beyond 10 seconds and falls back at the configured total timeout', { timeout: 30_000 }, async (t) => {
  const sockets = new Set();
  let receivedClientHello = false;
  let markClosed;
  const primaryClosed = new Promise((resolve) => { markClosed = resolve; });
  const stalledTls = createTcpServer((socket) => {
    sockets.add(socket);
    // Accept and consume the TLS ClientHello without completing the handshake.
    socket.on('data', () => { receivedClientHello = true; });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      markClosed();
    });
  });
  await new Promise((resolve, reject) => {
    stalledTls.once('error', reject);
    stalledTls.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      stalledTls.close((error) => (error ? reject(error) : resolve()));
    });
    for (const socket of sockets) socket.destroy();
    await closed;
  });

  const { base, sources, calls } = await fixture(t, {
    backup: (_req, res) => res.end('backup after TLS timeout'),
  }, 12_500);
  const primary = `https://127.0.0.1:${stalledTls.address().port}/subscription`;
  const startedAt = performance.now();
  const response = await request(base + route([primary, sources.backup]), {
    signal: AbortSignal.timeout(25_000),
  });
  const elapsed = performance.now() - startedAt;

  await assertRedirect(response, sources.backup);
  assert.ok(receivedClientHello, 'The primary must reach the TLS handshake');
  assert.ok(elapsed >= 12_000, `Fallback occurred after ${Math.round(elapsed)} ms, before the configured timeout`);
  assert.deepEqual(calls.map(({ name }) => name), ['backup']);

  let closeTimer;
  try {
    await Promise.race([
      primaryClosed,
      new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Timed-out TLS connection was not closed')), 1500);
      }),
    ]);
  } finally {
    clearTimeout(closeTimer);
  }
});

test('rejects unknown paths and additional suffixes without contacting sources', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.end('subscription'),
  });
  const query = new URLSearchParams({ subs: sources.primary });
  for (const path of ['/', '/different-id', `/${ACCESS_ID}/extra`, `/${ACCESS_ID}//`, `/${ACCESS_ID}extra`]) {
    const response = await request(`${base}${path}?${query}`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  const absolute = await rawRequest(base, `http://other.example/${ACCESS_ID}/?${query}`);
  assert.equal(absolute.status, 404);
  assert.deepEqual(calls, []);
});

test('each server uses its configured access ID instead of a shared source constant', { timeout: 5000 }, async (t) => {
  const { base, sources } = await fixture(t, {
    primary: (_req, res) => res.end('subscription'),
  });
  const otherAccessId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const otherBase = await listen(t, createResolverServer({ accessId: otherAccessId, timeoutMs: 1000 }));
  const originalPath = route([sources.primary]);
  const ownPath = originalPath.replace(`/${ACCESS_ID}/`, `/${otherAccessId}/`);

  const wrong = await request(otherBase + originalPath);
  assert.equal(wrong.status, 404);
  await wrong.arrayBuffer();
  for (const url of [base + originalPath, otherBase + ownPath]) {
    const response = await request(url);
    await assertRedirect(response, sources.primary);
  }
});

test('rejects missing, empty, relative, unsupported and credential-bearing URLs before fetching any source', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.end('subscription'),
  });
  const missing = await request(`${base}/${ACCESS_ID}/?format=base64`);
  assert.equal(missing.status, 400);
  await missing.arrayBuffer();

  for (const source of [
    '', ' ', '\t', 'not a URL', '/relative/path', '//127.0.0.1/subscription',
    'http://', 'ftp://127.0.0.1/subscription', 'file:///private/subscription',
    sources.primary.replace('http://', 'http://user:password@'),
    `${sources.primary}/subscription#fragment`, `${sources.primary}/subscription#`,
  ]) {
    const response = await request(base + route([sources.primary, source]));
    assert.equal(response.status, 400, `Unexpected status for source ${JSON.stringify(source)}`);
    await response.arrayBuffer();
  }
  assert.deepEqual(calls, []);
});

test('rejects unsupported methods on valid endpoints without fetching', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    primary: (_req, res) => res.end('subscription'),
  });
  for (const method of ['POST', 'HEAD', 'PUT']) {
    const response = await request(base + route([sources.primary]), { method });
    assert.equal(response.status, 405);
    await response.arrayBuffer();
  }
  assert.deepEqual(calls, []);
});

test('validates subscription bytes without copying the body or metadata, forwarding only client preferences upstream', { timeout: 5000 }, async (t) => {
  const body = Buffer.from([0, 255, 13, 10, 128, 42]);
  let incomingHeaders;
  const { base, sources } = await fixture(t, {
    primary: (req, res) => {
      incomingHeaders = req.headers;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="subscription.txt"',
        'subscription-userinfo': 'upload=1; download=2; total=1000; expire=2000000000',
        'profile-title': 'base64:VGVzdA==',
        'profile-update-interval': '1',
        'support-url': 'https://example.com/support',
        'cache-control': 'public, max-age=3600',
        'set-cookie': 'private=value',
        'x-private-header': 'do not forward',
      }).end(body);
    },
  });
  const response = await request(base + route([sources.primary]), {
    headers: {
      'user-agent': 'VituraNG-test-client',
      accept: 'text/plain, application/octet-stream',
      authorization: 'Bearer client-only',
      cookie: 'client-cookie=secret',
    },
  });

  await assertRedirect(response, sources.primary);
  assert.equal(incomingHeaders['user-agent'], 'VituraNG-test-client');
  assert.equal(incomingHeaders.accept, 'text/plain, application/octet-stream');
  assert.equal(incomingHeaders.authorization, undefined);
  assert.equal(incomingHeaders.cookie, undefined);
  for (const header of [
    'content-type', 'content-disposition', 'subscription-userinfo', 'profile-title',
    'profile-update-interval', 'support-url', 'set-cookie', 'x-private-header',
  ]) {
    assert.equal(response.headers.get(header), null);
  }
});

test('validates a gzip subscription but returns only a redirect without its encoding or body length', { timeout: 5000 }, async (t) => {
  const body = Buffer.from('subscription configuration\n'.repeat(20));
  const compressed = gzipSync(body);
  const { base, sources } = await fixture(t, {
    primary: (_req, res) => res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
      'content-length': String(compressed.length),
    }).end(compressed),
  });
  const response = await request(base + route([sources.primary]));

  await assertRedirect(response, sources.primary);
  assert.equal(response.headers.get('content-encoding'), null);
  const downstreamLength = response.headers.get('content-length');
  assert.ok(downstreamLength === null || Number(downstreamLength) === 0);
});

test('skips empty 200 responses and non-200 responses, including a nonempty 201', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    empty: (_req, res) => res.end(),
    created: (_req, res) => res.writeHead(201).end('not a 200 response'),
    denied: (_req, res) => res.writeHead(403).end('access denied'),
    valid: (_req, res) => res.end('valid subscription'),
  });
  const response = await request(base + route(Object.values(sources)));

  await assertRedirect(response, sources.valid);
  assert.deepEqual(calls.map(({ name }) => name), ['empty', 'created', 'denied', 'valid']);
});

test('falls back when a source never sends response headers', { timeout: 5000 }, async (t) => {
  const { base, sources, calls } = await fixture(t, {
    hanging: () => {},
    backup: (_req, res) => res.end('backup'),
  }, 100);
  const response = await request(base + route([sources.hanging, sources.backup]));

  await assertRedirect(response, sources.backup);
  assert.deepEqual(calls.map(({ name }) => name), ['hanging', 'backup']);
});

test('times out a hanging body without sending partial bytes or headers to the client', { timeout: 5000 }, async (t) => {
  const { base, sources } = await fixture(t, {
    hanging: (_req, res) => {
      res.writeHead(200, { 'profile-title': 'incomplete primary' });
      res.write('incomplete primary subscription');
    },
    backup: (_req, res) => res.writeHead(200, { 'profile-title': 'backup' }).end('complete backup'),
  }, 100);
  const response = await request(base + route([sources.hanging, sources.backup]));

  await assertRedirect(response, sources.backup);
  assert.equal(response.headers.get('profile-title'), null);
});

test('falls back after an upstream connection breaks midway through the body', { timeout: 5000 }, async (t) => {
  const { base, sources } = await fixture(t, {
    broken: (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial data');
      const timer = setTimeout(() => res.destroy(), 20);
      t.after(() => clearTimeout(timer));
    },
    backup: (_req, res) => res.end('complete backup'),
  });
  const response = await request(base + route([sources.broken, sources.backup]));

  await assertRedirect(response, sources.backup);
});

test('accepts exactly 2 MiB and skips oversized plain and decompressed responses', { timeout: 5000 }, async (t) => {
  const exactBody = Buffer.alloc(maxBodyBytes, 'a');
  const oversizedBody = Buffer.alloc(maxBodyBytes + 1, 'b');
  const { base, sources } = await fixture(t, {
    exact: (_req, res) => res.end(exactBody),
    length: (_req, res) => res.writeHead(200, { 'content-length': String(oversizedBody.length) }).end(oversizedBody),
    chunked: (_req, res) => {
      res.writeHead(200);
      res.write(oversizedBody);
      res.end();
    },
    compressed: (_req, res) => res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(oversizedBody)),
    backup: (_req, res) => res.end('small backup'),
  });
  const exactResponse = await request(base + route([sources.exact]));
  await assertRedirect(exactResponse, sources.exact);

  for (const source of [sources.length, sources.chunked, sources.compressed]) {
    const response = await request(base + route([source, sources.backup]));
    await assertRedirect(response, sources.backup);
  }
});

test('returns 503 when every source fails, including a connection error', { timeout: 5000 }, async (t) => {
  const { base, sources } = await fixture(t, {
    broken: (req) => req.socket.destroy(),
    unavailable: (_req, res) => res.writeHead(503).end('upstream private error'),
    empty: (_req, res) => res.end(),
  });
  const response = await request(base + route([sources.broken, sources.unavailable, sources.empty]));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('upstream private error'));
});

test('logs structured failure metadata without the access UUID, source URLs or query', { timeout: 5000 }, async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => logs.push(args.map(String).join(' ')));
  }
  const secretQuery = 'private-subscription-value';
  const { base, sources } = await fixture(t, {
    primary: (_req, res) => res.writeHead(503).end('Unavailable'),
  });
  const source = `${sources.primary}/private-client?key=${secretQuery}`;
  const response = await request(base + route([source]));
  assert.equal(response.status, 503);
  await response.arrayBuffer();

  const failures = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'source_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].source, 1);
  assert.equal(failures[0].code, 'HTTP_STATUS');
  assert.equal(failures[0].status, 503);
  assert.ok(Number.isFinite(failures[0].elapsedMs) && failures[0].elapsedMs >= 0);

  const output = logs.join('\n');
  for (const secret of [ACCESS_ID, source, new URL(source).host, secretQuery, 'subs=']) {
    assert.ok(!output.includes(secret), `Failure log contained ${secret}`);
  }
});

test('cancels the upstream body when the client disconnects without trying a backup', { timeout: 5000 }, async (t) => {
  let markStarted;
  let markClosed;
  let backupCalls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const { base, sources } = await fixture(t, {
    primary: (_req, res) => {
      res.on('close', markClosed);
      res.write('unfinished subscription');
      markStarted();
    },
    backup: (_req, res) => {
      backupCalls += 1;
      res.end('backup');
    },
  }, 3000);
  const client = get(base + route([sources.primary, sources.backup]));
  client.on('error', () => {});
  t.after(() => client.destroy());

  await started;
  client.destroy();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Upstream was not cancelled after client disconnect')), 1000);
  });
  try {
    await Promise.race([closed, deadline]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(backupCalls, 0);
});
