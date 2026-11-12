function integer(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

export function loadConfig() {
  return {
    accessId: accessId(),
    timeoutMs: integer('REQUEST_TIMEOUT_MS', 5000, 60_000),
    port: integer('PORT', 3000, 65_535),
    host: process.env.HOST ?? '127.0.0.1',
  };
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function accessId(): string {
  const value = process.env.ACCESS_ID;
  if (!value || !UUID_V4.test(value)) {
    throw new Error('ACCESS_ID must be a valid UUID v4. Run pnpm run setup to initialize .env, or correct ACCESS_ID in the existing file.');
  }
  return value.toLowerCase();
}
