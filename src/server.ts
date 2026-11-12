import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface ResolverOptions {
  accessId: string;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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

function isSubscriptionUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return /^https?:\/\//i.test(source)
      && !/\s/.test(source)
      && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && !source.includes('#');
  } catch {
    return false;
  }
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
  if (pathname !== routePrefix && pathname !== `${routePrefix}/`) {
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
  const sources = new URLSearchParams(`?${query}`).getAll('subs');
  if (sources.length === 0 || sources.some((source) => !isSubscriptionUrl(source))) {
    errorResponse(res, 400, 'Provide subs as repeated absolute HTTP(S) URLs without userinfo or fragments');
    return;
  }

  const client = new AbortController();
  const onClose = () => client.abort();
  res.once('close', onClose);
  const headers = new Headers();
  for (const name of ['user-agent', 'accept'] as const) {
    const value = req.headers[name];
    if (value) headers.set(name, value);
  }

  try {
    for (const [index, source] of sources.entries()) {
      if (client.signal.aborted) return;
      const attempt = new AbortController();
      try {
        // Query decoding happens once in URLSearchParams; use the complete URL.
        const response = await fetch(source, {
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
