import { randomUUID } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const envFile = new URL('../.env', import.meta.url);
const content = [
  `ACCESS_ID=${randomUUID()}`,
  'HOST=127.0.0.1',
  'PORT=3000',
  'REQUEST_TIMEOUT_MS=5000',
  '',
].join('\n');

try {
  await writeFile(envFile, content, {
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Created .env');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  await chmod(envFile, 0o600);
  const existing = await readFile(envFile, 'utf8');
  if (Object.hasOwn(parseEnv(existing), 'ACCESS_ID')) {
    console.log('Kept existing .env');
  } else {
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(envFile, `${separator}ACCESS_ID=${randomUUID()}\n`);
    console.log('Added ACCESS_ID to existing .env');
  }
}

console.log('Run pnpm build and pnpm start. Domains are supplied in each request.');
