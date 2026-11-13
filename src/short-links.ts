import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_STORE_BYTES = 8 * 1024 * 1024;
export const validSlug = (value: string) => /^[A-Za-z0-9_-]{1,64}$/.test(value);
export function validDestination(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8192 || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return /^https?:\/\//i.test(value) && !url.username && !url.password
      && ['http:', 'https:'].includes(url.protocol) && Buffer.byteLength(url.href) <= 8192;
  } catch { return false; }
}

export class LinkError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// One process owns this file. Serialize writes and publish in memory only after rename.
export class ShortLinks {
  private links = new Map<string, string>();
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private readonly file: string) {}

  static async load(file: string): Promise<ShortLinks> {
    const store = new ShortLinks(resolve(file));
    await mkdir(dirname(store.file), { recursive: true, mode: 0o700 });
    try {
      if ((await stat(store.file)).size > MAX_STORE_BYTES) throw new Error('Too large');
      const data = JSON.parse(await readFile(store.file, 'utf8'));
      if (data?.version !== 1 || !data.links || typeof data.links !== 'object' || Array.isArray(data.links)) throw new Error('Invalid format');
      for (const [slug, url] of Object.entries(data.links)) {
        if (!validSlug(slug) || !validDestination(url)) throw new Error('Invalid entry');
        store.links.set(slug, new URL(url).href);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load short-link storage; check its permissions and JSON format.');
    }
    return store;
  }

  get(slug: string) { return this.links.get(slug); }
  export() { return JSON.stringify({ version: 1, links: Object.fromEntries(this.links) }, null, 2) + '\n'; }

  save(slug: string, url: string, create: boolean): Promise<void> {
    const operation = this.pending.then(async () => {
      if (!validSlug(slug) || !validDestination(url)) throw new LinkError(400, 'Invalid slug or HTTP(S) URL');
      if (create && this.links.has(slug)) throw new LinkError(409, 'This short name is already taken');
      if (!create && !this.links.has(slug)) throw new LinkError(404, 'Short link not found');
      const next = new Map(this.links);
      next.set(slug, new URL(url).href);
      const json = JSON.stringify({ version: 1, links: Object.fromEntries(next) }, null, 2) + '\n';
      if (Buffer.byteLength(json) > MAX_STORE_BYTES) throw new LinkError(507, 'Short-link storage is full');
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(json); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.file);
        this.links = next;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
