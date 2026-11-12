import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { loadConfig } from '../dist/config.js';

const run = promisify(execFile);
const testAccessId = '11111111-aaaa-4bbb-8ccc-555555555555';
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'subs-resolver-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await copyFile(new URL('../scripts/setup.mjs', import.meta.url), join(directory, 'scripts/setup.mjs'));
  return directory;
}

function setup(directory) {
  return run(process.execPath, ['scripts/setup.mjs'], { cwd: directory });
}

function configureEnvironment(t, overrides = {}) {
  const names = ['ACCESS_ID', 'HOST', 'PORT', 'REQUEST_TIMEOUT_MS'];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of names) delete process.env[name];
  Object.assign(process.env, overrides);
}

test('fresh setup generates a private UUID, preserves it on rerun and gives another install a different UUID', async (t) => {
  const directory = await sandbox(t);
  const firstRun = await setup(directory);
  const envFile = join(directory, '.env');
  const firstContent = await readFile(envFile, 'utf8');
  const first = parseEnv(firstContent);
  assert.match(first.ACCESS_ID, uuidV4);
  assert.equal(first.HOST, '127.0.0.1');
  assert.equal(first.PORT, '3000');
  assert.equal(first.REQUEST_TIMEOUT_MS, '5000');
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);

  const secondRun = await setup(directory);
  assert.equal(await readFile(envFile, 'utf8'), firstContent);
  const logs = firstRun.stdout + firstRun.stderr + secondRun.stdout + secondRun.stderr;
  assert.ok(!logs.includes(first.ACCESS_ID));

  const otherDirectory = await sandbox(t);
  await setup(otherDirectory);
  const other = parseEnv(await readFile(join(otherDirectory, '.env'), 'utf8'));
  assert.match(other.ACCESS_ID, uuidV4);
  assert.notEqual(other.ACCESS_ID, first.ACCESS_ID);
});

test('setup migrates an existing env without ACCESS_ID once and preserves every existing setting', async (t) => {
  const directory = await sandbox(t);
  const envFile = join(directory, '.env');
  const existing = '# Existing deployment\nHOST=0.0.0.0\nPORT=9000\nCUSTOM_VALUE="kept exactly"';
  await writeFile(envFile, existing, { mode: 0o644 });

  const result = await setup(directory);
  const migrated = await readFile(envFile, 'utf8');
  assert.ok(migrated.startsWith(`${existing}\n`));
  const config = parseEnv(migrated);
  assert.match(config.ACCESS_ID, uuidV4);
  assert.equal(config.HOST, '0.0.0.0');
  assert.equal(config.PORT, '9000');
  assert.equal(config.CUSTOM_VALUE, 'kept exactly');
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  assert.ok(!(result.stdout + result.stderr).includes(config.ACCESS_ID));

  await setup(directory);
  assert.equal(await readFile(envFile, 'utf8'), migrated);
  assert.equal(migrated.match(/^ACCESS_ID=/gm).length, 1);
});

test('setup preserves explicitly assigned IDs, including empty, invalid and quoted exported values', async (t) => {
  for (const assignment of ['ACCESS_ID=', 'ACCESS_ID=invalid-existing-value', `export ACCESS_ID="${testAccessId}"`]) {
    const directory = await sandbox(t);
    const envFile = join(directory, '.env');
    const existing = `${assignment}\nHOST=0.0.0.0\n`;
    await writeFile(envFile, existing, { mode: 0o644 });
    await setup(directory);
    assert.equal(await readFile(envFile, 'utf8'), existing);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  }
});

test('configuration requires a UUID v4, normalizes its case and preserves runtime defaults', (t) => {
  configureEnvironment(t, { ACCESS_ID: testAccessId.toUpperCase() });
  assert.deepEqual(loadConfig(), {
    accessId: testAccessId,
    host: '127.0.0.1',
    port: 3000,
    timeoutMs: 5000,
  });
});

test('configuration rejects missing or invalid ACCESS_ID with a setup hint and no secret in the error', (t) => {
  configureEnvironment(t);
  for (const value of [undefined, '', 'private-invalid-value', '11111111-aaaa-1bbb-8ccc-555555555555', '11111111-aaaa-4bbb-7ccc-555555555555']) {
    if (value === undefined) delete process.env.ACCESS_ID;
    else process.env.ACCESS_ID = value;
    assert.throws(() => loadConfig(), (error) => {
      assert.match(error.message, /ACCESS_ID/);
      assert.match(error.message, /pnpm run setup/);
      if (value) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});

test('production startup fails instead of listening when no ACCESS_ID is configured', async (t) => {
  const directory = await sandbox(t);
  const env = { ...process.env };
  delete env.ACCESS_ID;
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  await assert.rejects(run(process.execPath, ['--env-file-if-exists=.env', entry], {
    cwd: directory,
    env,
    timeout: 2000,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /ACCESS_ID/);
    assert.match(error.stderr, /pnpm run setup/);
    assert.ok(!error.stdout.includes('Listening'));
    return true;
  });
});
