import { loadConfig } from './config.js';
import { createResolverServer } from './server.js';

try {
  const config = loadConfig();
  const server = createResolverServer(config);
  server.on('error', () => {
    console.error('Cannot start HTTP server. Check HOST, PORT and whether the port is already in use.');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`Listening on ${config.host}:${config.port}.`);
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close();
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Failed to load configuration.');
  process.exitCode = 1;
}
