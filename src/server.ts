import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface ResolverOptions {
  accessId: string;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const DOMAINS_PARAM = 'available_domains';
const RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'subscription-userinfo',
  'profile-title',
  'profile-update-interval',
  'support-url',
];

function errorResponse(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

async function readBody(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('Empty body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Body too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new Error('Empty body');
  return Buffer.concat(chunks, size);
}

async function resolve(req: IncomingMessage, res: ServerResponse, options: ResolverOptions) {
  const routePrefix = `/${options.accessId}`;
  res.setHeader('cache-control', 'no-store');
  const target = req.url ?? '';
  const queryStart = target.indexOf('?');
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  if (!pathname.startsWith(`${routePrefix}/`)) {
    errorResponse(res, 404, 'Not found');
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    errorResponse(res, 405, 'Method not allowed');
    return;
  }
  if (target.includes('#')) {
    errorResponse(res, 400, 'Fragments are not valid in an HTTP request target');
    return;
  }

  const query = queryStart === -1 ? '' : target.slice(queryStart + 1);
  const domains = new URLSearchParams(`?${query}`).getAll(DOMAINS_PARAM);
  if (domains.length === 0 || domains.some((domain) => !DOMAIN.test(domain))) {
    errorResponse(res, 400, 'Provide available_domains as repeated valid domain names');
    return;
  }
  // Keep encoding and order of upstream parameters, including duplicate keys.
  const upstreamQuery = query.split('&')
    .filter((part) => !new URLSearchParams(`?${part}`).has(DOMAINS_PARAM)).join('&');
  const upstreamPath = pathname.slice(routePrefix.length)
    + (upstreamQuery ? `?${upstreamQuery}` : '');

  const client = new AbortController();
  const onClose = () => client.abort();
  res.once('close', onClose);
  const headers = new Headers();
  for (const name of ['user-agent', 'accept'] as const) {
    const value = req.headers[name];
    if (value) headers.set(name, value);
  }

  try {
    for (const [index, domain] of domains.entries()) {
      if (client.signal.aborted) return;
      const attempt = new AbortController();
      try {
        // Append the path instead of resolving it against a base: //host/path
        // must remain a path rather than replacing the selected domain.
        const response = await fetch(`https://${domain}${upstreamPath}`, {
          headers,
          signal: AbortSignal.any([
            client.signal,
            attempt.signal,
            AbortSignal.timeout(options.timeoutMs),
          ]),
        });
        if (response.status !== 200) throw new Error('Unsuccessful status');

        // Buffer first: a broken download must not leak a partial subscription.
        const body = await readBody(response);
        if (client.signal.aborted) return;
        for (const name of RESPONSE_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) res.setHeader(name, value);
        }
        // fetch decompresses the body; upstream length/encoding no longer apply.
        res.setHeader('content-length', body.byteLength);
        res.end(body);
        return;
      } catch {
        if (client.signal.aborted) return;
        console.warn(`Source ${index + 1} unavailable; trying next source.`);
      } finally {
        // Also release unread bodies on non-200 responses or size-limit failures.
        attempt.abort();
      }
    }
    errorResponse(res, 503, 'No subscription source is available');
  } finally {
    res.off('close', onClose);
  }
}

export function createResolverServer(options: ResolverOptions) {
  return createServer({ headersTimeout: 10_000, requestTimeout: 10_000 }, (req, res) => {
    void resolve(req, res, options).catch(() => {
      console.error('Failed to handle subscription request.');
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else errorResponse(res, 500, 'Internal server error');
    });
  });
}
