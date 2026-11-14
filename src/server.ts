import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { shortRoute } from './short-api.js';
import type { ShortLinks } from './short-links.js';
import { Agent, fetch, type Response } from 'undici';

interface ResolverOptions {
  shortLinks?: ShortLinks;
  accessId: string;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SOURCE_BATCH_SIZE = 10;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 1000;
type AvailabilityCache = Map<string, { available: boolean; expiresAt: number }>;
const BUILDER_HTML = readFileSync(new URL('../public/index.html', import.meta.url));
const EDITOR_HTML = readFileSync(new URL('../public/editor.html', import.meta.url));
const EDITOR_SCRIPT = readFileSync(new URL('../public/editor.js', import.meta.url));
const TRANSFER_HTML = readFileSync(new URL('../public/transfer.html', import.meta.url));
const TRANSFER_SCRIPT = readFileSync(new URL('../public/transfer.js', import.meta.url));
const BUILDER_SCRIPT = readFileSync(new URL('../public/index.js', import.meta.url));
const ERROR_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'Z_DATA_ERROR', 'Z_BUF_ERROR', 'ERR_INVALID_CHAR', 'ERR_HTTP_INVALID_HEADER_VALUE',
]);

class SourceError extends Error {
  constructor(readonly code: 'HTTP_STATUS' | 'EMPTY_BODY' | 'BODY_TOO_LARGE', readonly status?: number) {
    super(code);
  }
}

function sourceErrorCode(error: unknown): string {
  // Undici wraps network failures in TypeError.cause. Only known codes are safe
  // to log: messages, stacks and unknown error fields may contain source URLs.
  for (let depth = 0; depth < 3 && typeof error === 'object' && error !== null; depth += 1) {
    const failure = error as { code?: unknown; cause?: unknown };
    if (typeof failure.code === 'string' && ERROR_CODES.has(failure.code)) return failure.code;
    error = failure.cause;
  }
  return 'UPSTREAM_ERROR';
}

function errorResponse(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${message}\n`);
}

function cacheAvailability(cache: AvailabilityCache, key: string, available: boolean) {
  cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { available, expiresAt: Date.now() + CACHE_TTL_MS });
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

async function validateBody(response: Response): Promise<void> {
  if (!response.body) throw new SourceError('EMPTY_BODY');
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new SourceError('BODY_TOO_LARGE');
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) throw new SourceError('EMPTY_BODY');
}

async function resolve(req: IncomingMessage, res: ServerResponse, options: ResolverOptions, dispatcher: Agent, cache: AvailabilityCache) {
  const routePrefix = `/${options.accessId}`;
  res.setHeader('cache-control', 'no-store');
  const target = req.url ?? '';
  const queryStart = target.indexOf('?');
  const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
  if (await shortRoute(req, res, pathname, options.accessId, options.shortLinks)) return;
  const isEditor = pathname === `${routePrefix}/editor.html`;
  const isEditorScript = pathname === `${routePrefix}/editor.js`;
  const isTransfer = pathname === `${routePrefix}/transfer.html`;
  const isTransferScript = pathname === `${routePrefix}/transfer.js`;
  const isBuilderScript = pathname === `${routePrefix}/index.js`;
  if (pathname !== routePrefix && pathname !== `${routePrefix}/` && !isBuilderScript && !isTransfer && !isTransferScript && !isEditor && !isEditorScript) {
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
  if (isBuilderScript || isTransfer || isTransferScript || isEditor || isEditorScript || query === '') {
    if (!isBuilderScript && pathname === routePrefix) {
      res.writeHead(302, { location: `${routePrefix}/`, 'content-length': '0' });
      res.end();
      return;
    }
    const body = isEditor ? EDITOR_HTML : isEditorScript ? EDITOR_SCRIPT : isTransfer ? TRANSFER_HTML : isTransferScript ? TRANSFER_SCRIPT : isBuilderScript ? BUILDER_SCRIPT : BUILDER_HTML;
    res.writeHead(200, {
      'content-type': isBuilderScript || isTransferScript || isEditorScript ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'content-length': body.byteLength,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
    return;
  }
  const params = new URLSearchParams(`?${query}`);
  const sources = params.getAll('subs');
  const bypassCache = params.get('no_cache') === '1';
  if (sources.length === 0 || sources.some((source) => !isSubscriptionUrl(source))) {
    errorResponse(res, 400, 'Provide subs as repeated absolute HTTP(S) URLs without userinfo or fragments');
    return;
  }

  const client = new AbortController();
  const onClose = () => client.abort();
  res.once('close', onClose);
  const headers: Record<string, string> = {};
  for (const name of ['user-agent', 'accept'] as const) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  try {
    for (let offset = 0; offset < sources.length; offset += SOURCE_BATCH_SIZE) {
      if (client.signal.aborted) return;
      const batch = sources.slice(offset, offset + SOURCE_BATCH_SIZE);
      const results = await Promise.all(batch.map(async (source, index) => {
        // Browser and subscription clients may receive different representations.
        const cacheKey = JSON.stringify([new URL(source).href, headers['user-agent'] ?? '', headers.accept ?? '']);
        const cached = cache.get(cacheKey);
        if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.available;
        if (cached && cached.expiresAt <= Date.now()) cache.delete(cacheKey);

        const attempt = new AbortController();
        const timeout = AbortSignal.timeout(options.timeoutMs);
        const started = performance.now();
        try {
          // Query decoding happens once in URLSearchParams; use the complete URL.
          const response = await fetch(source, {
            dispatcher,
            headers,
            signal: AbortSignal.any([
              client.signal,
              attempt.signal,
              timeout,
            ]),
          });
          if (response.status !== 200) throw new SourceError('HTTP_STATUS', response.status);

          // Validate the complete download before directing the client to it.
          await validateBody(response);
          if (!client.signal.aborted) cacheAvailability(cache, cacheKey, true);
          return true;
        } catch (error) {
          if (client.signal.aborted) return false;
          cacheAvailability(cache, cacheKey, false);
          console.warn(JSON.stringify({
            event: 'source_failed',
            source: offset + index + 1,
            code: error instanceof SourceError ? error.code
              : timeout.aborted ? 'TimeoutError' : sourceErrorCode(error),
            status: error instanceof SourceError ? error.status : undefined,
            elapsedMs: Math.round(performance.now() - started),
          }));
          return false;
        } finally {
          // Also release unread bodies on non-200 responses or size-limit failures.
          attempt.abort();
        }
      }));
      if (client.signal.aborted) return;

      // Wait for the whole batch, then select by input priority, not finish time.
      const source = batch[results.indexOf(true)];
      if (source !== undefined) {
        // Use the selected input URL, even if its validation followed redirects.
        // URL serialization makes Unicode safe for the Location header.
        res.writeHead(302, {
          location: new URL(source).href,
          'content-length': '0',
        });
        res.end();
        return;
      }
    }
    errorResponse(res, 503, 'No subscription source is available');
  } finally {
    res.off('close', onClose);
    client.abort();
  }
}

export function createResolverServer(options: ResolverOptions) {
  // Match connection setup to the full attempt deadline instead of Undici's
  // independent 10-second default. One agent retains connection pooling.
  const dispatcher = new Agent({ connect: { timeout: options.timeoutMs } });
  const cache: AvailabilityCache = new Map();
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 10_000 }, (req, res) => {
    void resolve(req, res, options, dispatcher, cache).catch(() => {
      console.error('Failed to handle subscription request.');
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else errorResponse(res, 500, 'Internal server error');
    });
  });
  server.once('close', () => {
    // No incoming clients remain, including after closeAllConnections().
    void dispatcher.destroy().catch(() => {
      console.error('Failed to close subscription HTTP client.');
    });
  });
  return server;
}
