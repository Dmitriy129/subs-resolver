import type { IncomingMessage, ServerResponse } from 'node:http';
import { LinkError, ShortLinks, validDestination, validSlug } from './short-links.js';

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export async function shortRoute(req: IncomingMessage, res: ServerResponse, pathname: string, accessId: string, store?: ShortLinks): Promise<boolean> {
  const admin = `/${accessId}/api/short-links`;
  const publicMatch = /^\/s\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  if (!publicMatch && pathname !== `${admin}/export` && !pathname.startsWith(`${admin}/`)) return false;
  const exporting = !publicMatch && pathname === `${admin}/export`;
  if (!publicMatch && !exporting && !pathname.startsWith(`${admin}/item/`)) {
    json(res, 404, { error: 'Not found' }); return true;
  }
  const name = publicMatch?.[1] ?? pathname.slice(`${admin}/item/`.length);
  if (!exporting && !validSlug(name)) { json(res, 400, { error: 'Invalid short name' }); return true; }
  const allowed = publicMatch || exporting ? ['GET'] : ['GET', 'POST', 'PUT'];
  if (!allowed.includes(req.method ?? '')) {
    res.setHeader('allow', allowed.join(', ')); json(res, 405, { error: 'Method not allowed' }); return true;
  }
  if (!store) { json(res, 503, { error: 'Short-link storage unavailable' }); return true; }
  if (publicMatch) {
    const target = store.get(name);
    if (!target) json(res, 404, { error: 'Short link not found' });
    else { res.writeHead(302, { location: target, 'content-length': '0', 'referrer-policy': 'no-referrer' }); res.end(); }
    return true;
  }
  if (exporting) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="short-links.json"', 'x-content-type-options': 'nosniff' });
    res.end(store.export()); return true;
  }
  if (req.method === 'GET') {
    const url = store.get(name);
    json(res, 200, url === undefined ? { exists: false } : { exists: true, url }); return true;
  }
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) throw new Error();
    } catch { json(res, 403, { error: 'Cross-origin write denied' }); return true; }
  }
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    json(res, 415, { error: 'Expected application/json' }); return true;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    // Keep the connection writable for a 413 response when stopping body reading early.
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 64 * 1024) { res.setHeader('connection', 'close'); throw new LinkError(413, 'Request body too large'); }
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new LinkError(400, 'Invalid JSON'); }
    if (!validDestination(data?.url)) throw new LinkError(400, 'Expected an HTTP(S) URL up to 8192 bytes, without credentials or spaces');
    const destination = new URL(data.url);
    if (destination.host === req.headers.host && destination.pathname === `/s/${name}`) throw new LinkError(400, 'A short link cannot point to itself');
    await store.save(name, data.url, req.method === 'POST');
    json(res, req.method === 'POST' ? 201 : 200, { exists: true, url: store.get(name), path: `/s/${name}` });
  } catch (error) {
    json(res, error instanceof LinkError ? error.status : 500, { error: error instanceof LinkError ? error.message : 'Could not save short link' });
  }
  return true;
}
