import assert from 'node:assert/strict';
import { createServer, get, request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { createResolverServer } from '../dist/server.js';

const ACCESS_ID = '11111111-2222-4333-8444-555555555555';
const originalFetch = globalThis.fetch;
const incomingPath = '/sub/test-user?format=x';
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
  const origins = new Map(await Promise.all(Object.entries(handlers).map(async ([domain, handler]) => [
    domain,
    await listen(t, createServer(handler)),
  ])));
  const outgoing = [];

  // Preserve real fetch/body/abort behavior, mapping HTTPS test domains to local servers.
  // Client requests use originalFetch; no test request can reach an external server.
  t.mock.method(globalThis, 'fetch', (input, options) => {
    const target = new URL(input);
    outgoing.push(target.href);
    const origin = origins.get(target.hostname);
    if (target.protocol !== 'https:' || target.port || !origin) {
      throw new Error('Unexpected upstream destination in test');
    }
    return originalFetch(`${origin}${target.pathname}${target.search}`, options);
  });

  const base = await listen(t, createResolverServer({ accessId: ACCESS_ID, timeoutMs }));
  return { base, outgoing };
}

function route(domains, path = incomingPath) {
  const query = domains.map((domain) => `available_domains=${encodeURIComponent(domain)}`).join('&');
  return `/${ACCESS_ID}${path}${path.includes('?') ? '&' : '?'}${query}`;
}

function request(url, options = {}) {
  return originalFetch(url, { signal: AbortSignal.timeout(4000), ...options });
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

test('tries request domains in order and returns to the primary after recovery', { timeout: 5000 }, async (t) => {
  let primaryHealthy = false;
  const { base, outgoing } = await fixture(t, {
    'primary.example': (_req, res) => {
      if (!primaryHealthy) res.writeHead(503).end('Unavailable');
      else res.end('primary subscription');
    },
    'backup.example': (_req, res) => res.end('backup subscription'),
    'third.example': (_req, res) => res.end('third subscription'),
  });
  const url = base + route(['primary.example', 'backup.example', 'third.example']);

  assert.equal(await (await request(url)).text(), 'backup subscription');
  primaryHealthy = true;
  assert.equal(await (await request(url)).text(), 'primary subscription');
  assert.deepEqual(outgoing, [
    `https://primary.example${incomingPath}`,
    `https://backup.example${incomingPath}`,
    `https://primary.example${incomingPath}`,
  ]);
});

test('uses each request domain list and subscription path independently', { timeout: 5000 }, async (t) => {
  const { base, outgoing } = await fixture(t, {
    'alice.example': (req, res) => res.end(`alice: ${req.url}`),
    'bob.example': (req, res) => res.end(`bob: ${req.url}`),
  });
  const paths = ['/sub/alice?format=base64', '/clients/bob/subscription?format=clash&group=mobile', '/'];

  for (const [index, path] of paths.entries()) {
    const name = index === 1 ? 'bob' : 'alice';
    const response = await request(base + route([`${name}.example`], path));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `${name}: ${path}`);
  }
  assert.deepEqual(outgoing, [
    `https://alice.example${paths[0]}`,
    `https://bob.example${paths[1]}`,
    'https://alice.example/',
  ]);
});

test('removes only available_domains while preserving encoding, query order and repeated parameters', { timeout: 5000 }, async (t) => {
  const received = [];
  const { base, outgoing } = await fixture(t, {
    'primary.example': (req, res) => {
      received.push(req.url);
      res.writeHead(502).end();
    },
    'backup.example': (req, res) => {
      received.push(req.url);
      res.end(req.url);
    },
  });
  const path = '/sub/user%2Fpart%2Bname?first=1&?available_domains=keep&tag=a%2Fb&tag=a%2Bb&tag=a+b&empty=&last=2';
  const target = `/${ACCESS_ID}/sub/user%2Fpart%2Bname?first=1&available_domains=primary.example&?available_domains=keep&tag=a%2Fb&%61vailable_domains=backup.example&tag=a%2Bb&tag=a+b&empty=&last=2`;
  const response = await rawRequest(base, target);

  assert.equal(response.status, 200);
  assert.equal(response.body, path);
  assert.deepEqual(received, [path, path]);
  assert.deepEqual(outgoing, [`https://primary.example${path}`, `https://backup.example${path}`]);
});

test('keeps a double-slash subscription path on the selected HTTPS domain', { timeout: 5000 }, async (t) => {
  let outsideCalls = 0;
  const { base, outgoing } = await fixture(t, {
    'primary.example': (req, res) => res.end(req.url),
    'outside.example': (_req, res) => {
      outsideCalls += 1;
      res.end('unexpected destination');
    },
  });
  const path = '//outside.example/subscription?key=a%2Bb';
  const response = await rawRequest(base, route(['primary.example'], path));

  assert.equal(response.status, 200);
  assert.equal(response.body, path);
  assert.equal(outsideCalls, 0);
  assert.deepEqual(outgoing, [`https://primary.example${path}`]);
});

test('rejects paths without the exact UUID prefix and required trailing slash', { timeout: 5000 }, async (t) => {
  const { base, outgoing } = await fixture(t, {
    'primary.example': (_req, res) => res.end('subscription'),
  });
  for (const path of ['/', '/different-id/subscription', `/${ACCESS_ID}`, `/${ACCESS_ID}extra/subscription`]) {
    const response = await request(`${base}${path}?available_domains=primary.example`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  const absolute = await rawRequest(base, `http://other.example/${ACCESS_ID}/sub/user?available_domains=primary.example`);
  assert.equal(absolute.status, 404);
  assert.deepEqual(outgoing, []);
});

test('each server uses its configured access ID instead of a shared source constant', { timeout: 5000 }, async (t) => {
  const { base } = await fixture(t, {
    'primary.example': (_req, res) => res.end('subscription'),
  });
  const otherAccessId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const otherBase = await listen(t, createResolverServer({ accessId: otherAccessId, timeoutMs: 1000 }));
  const originalPath = route(['primary.example']);
  const ownPath = originalPath.replace(`/${ACCESS_ID}/`, `/${otherAccessId}/`);

  const wrong = await request(otherBase + originalPath);
  assert.equal(wrong.status, 404);
  await wrong.arrayBuffer();
  for (const url of [base + originalPath, otherBase + ownPath]) {
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'subscription');
  }
});

test('rejects literal fragments while preserving percent-encoded fragment characters', { timeout: 5000 }, async (t) => {
  const { base, outgoing } = await fixture(t, {
    'primary.example': (req, res) => res.end(req.url),
  });
  const invalid = await rawRequest(base, `/${ACCESS_ID}/sub/user?available_domains=primary.example&key=value#fragment`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(outgoing, []);

  const path = '/sub/user%23label?key=value%23fragment';
  const valid = await rawRequest(base, route(['primary.example'], path));
  assert.equal(valid.status, 200);
  assert.equal(valid.body, path);
  assert.deepEqual(outgoing, [`https://primary.example${path}`]);
});

test('rejects missing, empty and invalid domains before making any upstream request', { timeout: 5000 }, async (t) => {
  const { base, outgoing } = await fixture(t, {
    'primary.example': (_req, res) => res.end('subscription'),
  });
  const missing = await request(`${base}/${ACCESS_ID}/sub/user?format=base64`);
  assert.equal(missing.status, 400);
  await missing.arrayBuffer();

  for (const domain of [
    '', 'localhost', '127.0.0.1', '192.0.2.1', '[::1]',
    'primary.example:443', 'https://primary.example', 'user@primary.example',
    'primary.example/path', '-bad.example', 'bad-.example', 'bad..example',
    'under_score.example', 'домен.example', ' primary.example',
  ]) {
    const response = await request(base + route(['primary.example', domain]));
    assert.equal(response.status, 400, `Unexpected status for domain ${JSON.stringify(domain)}`);
    await response.arrayBuffer();
  }
  assert.deepEqual(outgoing, []);
});

test('rejects unsupported methods on valid subscription routes without fetching', { timeout: 5000 }, async (t) => {
  const { base, outgoing } = await fixture(t, {
    'primary.example': (_req, res) => res.end('subscription'),
  });
  for (const method of ['POST', 'HEAD', 'PUT']) {
    const response = await request(base + route(['primary.example']), { method });
    assert.equal(response.status, 405);
    await response.arrayBuffer();
  }
  assert.deepEqual(outgoing, []);
});

test('preserves subscription bytes and allowed metadata, forwarding only client preferences', { timeout: 5000 }, async (t) => {
  const body = Buffer.from([0, 255, 13, 10, 128, 42]);
  let incomingHeaders;
  const { base } = await fixture(t, {
    'primary.example': (req, res) => {
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
  const response = await request(base + route(['primary.example']), {
    headers: {
      'user-agent': 'VituraNG-test-client',
      accept: 'text/plain, application/octet-stream',
      authorization: 'Bearer client-only',
      cookie: 'client-cookie=secret',
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  assert.equal(incomingHeaders['user-agent'], 'VituraNG-test-client');
  assert.equal(incomingHeaders.accept, 'text/plain, application/octet-stream');
  assert.equal(incomingHeaders.authorization, undefined);
  assert.equal(incomingHeaders.cookie, undefined);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="subscription.txt"');
  assert.equal(response.headers.get('subscription-userinfo'), 'upload=1; download=2; total=1000; expire=2000000000');
  assert.equal(response.headers.get('profile-title'), 'base64:VGVzdA==');
  assert.equal(response.headers.get('profile-update-interval'), '1');
  assert.equal(response.headers.get('support-url'), 'https://example.com/support');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-private-header'), null);
});

test('returns decompressed gzip data without stale encoding or length headers', { timeout: 5000 }, async (t) => {
  const body = Buffer.from('subscription configuration\n'.repeat(20));
  const compressed = gzipSync(body);
  const { base } = await fixture(t, {
    'primary.example': (_req, res) => res.writeHead(200, {
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
      'content-length': String(compressed.length),
    }).end(compressed),
  });
  const response = await request(base + route(['primary.example']));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), null);
  const downstreamLength = response.headers.get('content-length');
  assert.ok(downstreamLength === null || Number(downstreamLength) === body.length);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});

test('skips empty 200 responses and non-200 responses, including a nonempty 201', { timeout: 5000 }, async (t) => {
  const handlers = {
    'empty.example': (_req, res) => res.end(),
    'created.example': (_req, res) => res.writeHead(201).end('not a 200 response'),
    'denied.example': (_req, res) => res.writeHead(403).end('access denied'),
    'valid.example': (_req, res) => res.end('valid subscription'),
  };
  const { base, outgoing } = await fixture(t, handlers);
  const domains = Object.keys(handlers);
  const response = await request(base + route(domains));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'valid subscription');
  assert.deepEqual(outgoing, domains.map((domain) => `https://${domain}${incomingPath}`));
});

test('falls back when a source never sends response headers', { timeout: 5000 }, async (t) => {
  const { base, outgoing } = await fixture(t, {
    'hanging.example': () => {},
    'backup.example': (_req, res) => res.end('backup'),
  }, 100);
  const response = await request(base + route(['hanging.example', 'backup.example']));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'backup');
  assert.deepEqual(outgoing, [`https://hanging.example${incomingPath}`, `https://backup.example${incomingPath}`]);
});

test('times out a hanging body without sending partial bytes or headers to the client', { timeout: 5000 }, async (t) => {
  const { base } = await fixture(t, {
    'hanging.example': (_req, res) => {
      res.writeHead(200, { 'profile-title': 'incomplete primary' });
      res.write('incomplete primary subscription');
    },
    'backup.example': (_req, res) => res.writeHead(200, { 'profile-title': 'backup' }).end('complete backup'),
  }, 100);
  const response = await request(base + route(['hanging.example', 'backup.example']));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('profile-title'), 'backup');
  assert.equal(await response.text(), 'complete backup');
});

test('falls back after an upstream connection breaks midway through the body', { timeout: 5000 }, async (t) => {
  const { base } = await fixture(t, {
    'broken.example': (_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('partial data');
      const timer = setTimeout(() => res.destroy(), 20);
      t.after(() => clearTimeout(timer));
    },
    'backup.example': (_req, res) => res.end('complete backup'),
  });
  const response = await request(base + route(['broken.example', 'backup.example']));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'complete backup');
});

test('accepts exactly 2 MiB and skips oversized responses with or without content-length', { timeout: 5000 }, async (t) => {
  const exactBody = Buffer.alloc(maxBodyBytes, 'a');
  const oversizedBody = Buffer.alloc(maxBodyBytes + 1, 'b');
  const { base } = await fixture(t, {
    'exact.example': (_req, res) => res.end(exactBody),
    'length.example': (_req, res) => res.writeHead(200, { 'content-length': String(oversizedBody.length) }).end(oversizedBody),
    'chunked.example': (_req, res) => {
      res.writeHead(200);
      res.write(oversizedBody);
      res.end();
    },
    'backup.example': (_req, res) => res.end('small backup'),
  });
  const exactResponse = await request(base + route(['exact.example']));
  assert.equal(exactResponse.status, 200);
  assert.deepEqual(Buffer.from(await exactResponse.arrayBuffer()), exactBody);

  for (const domain of ['length.example', 'chunked.example']) {
    const response = await request(base + route([domain, 'backup.example']));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'small backup');
  }
});

test('returns 503 when every source fails, including a connection error', { timeout: 5000 }, async (t) => {
  const { base } = await fixture(t, {
    'broken.example': (req) => req.socket.destroy(),
    'unavailable.example': (_req, res) => res.writeHead(503).end('upstream private error'),
    'empty.example': (_req, res) => res.end(),
  });
  const response = await request(base + route(['broken.example', 'unavailable.example', 'empty.example']));

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(!(await response.text()).includes('upstream private error'));
});

test('does not include the access UUID, domains or query in failure logs', { timeout: 5000 }, async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error']) {
    t.mock.method(console, method, (...args) => logs.push(args.map(String).join(' ')));
  }
  const domain = 'private-source.example';
  const secretQuery = 'private-subscription-value';
  const { base } = await fixture(t, {
    [domain]: (_req, res) => res.writeHead(503).end('Unavailable'),
  });
  const response = await request(base + route([domain], `/sub/user?key=${secretQuery}`));
  assert.equal(response.status, 503);
  await response.arrayBuffer();

  const output = logs.join('\n');
  for (const secret of [ACCESS_ID, domain, secretQuery, 'available_domains']) {
    assert.ok(!output.includes(secret), `Failure log contained ${secret}`);
  }
});

test('cancels the upstream body when the client disconnects without trying a backup', { timeout: 5000 }, async (t) => {
  let markStarted;
  let markClosed;
  let backupCalls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const { base } = await fixture(t, {
    'primary.example': (_req, res) => {
      res.on('close', markClosed);
      res.write('unfinished subscription');
      markStarted();
    },
    'backup.example': (_req, res) => {
      backupCalls += 1;
      res.end('backup');
    },
  }, 3000);
  const client = get(base + route(['primary.example', 'backup.example']));
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
