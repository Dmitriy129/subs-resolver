import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent, fetch, type Response } from 'undici';

interface ResolverOptions {
  accessId: string;
  timeoutMs: number;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
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

async function resolve(req: IncomingMessage, res: ServerResponse, options: ResolverOptions, dispatcher: Agent) {
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
  const headers: Record<string, string> = {};
  for (const name of ['user-agent', 'accept'] as const) {
    const value = req.headers[name];
    if (value) headers[name] = value;
  }

  try {
    for (const [index, source] of sources.entries()) {
      if (client.signal.aborted) return;
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
        if (client.signal.aborted) return;
        // Use the selected input URL, even if its validation followed redirects.
        // URL serialization makes Unicode safe for the Location header.
        res.writeHead(302, {
          location: new URL(source).href,
          'content-length': '0',
        });
        res.end();
        return;
      } catch (error) {
        if (client.signal.aborted) return;
        console.warn(JSON.stringify({
          event: 'source_failed',
          source: index + 1,
          code: error instanceof SourceError ? error.code
            : timeout.aborted ? 'TimeoutError' : sourceErrorCode(error),
          status: error instanceof SourceError ? error.status : undefined,
          elapsedMs: Math.round(performance.now() - started),
        }));
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
  // Match connection setup to the full attempt deadline instead of Undici's
  // independent 10-second default. One agent retains connection pooling.
  const dispatcher = new Agent({ connect: { timeout: options.timeoutMs } });
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 10_000 }, (req, res) => {
    void resolve(req, res, options, dispatcher).catch(() => {
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
