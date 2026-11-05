// Entry point: `npm start`. Reads PORT and the rest of the settings from the environment.
import http from 'node:http';
import { model } from '../model/index.js';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

let config;
let app;
try {
  config = loadConfig(process.env, { modelContextChars: model.CONTEXT_CHARS });
  app = createApp({ model, config });
} catch (error) {
  // Bad settings or unreadable data/state: say exactly what is wrong and stop.
  process.stderr.write(`Startup failed: ${error.message}\n`);
  process.exit(1);
}

const log = app.deps.logger;
const server = http.createServer(app.handler);
// Keep connections from hanging on forever; the agent loop has its own, shorter limit.
server.requestTimeout = config.requestTimeoutMs + 5_000;

server.listen(config.port, () => {
  log.info('listening', {
    port: server.address().port,
    model: process.env.MODEL === 'anthropic' ? 'anthropic' : 'fake',
    fake_mode: process.env.FAKE_MODE || null,
    state_dir: config.stateDir,
    context_budget_chars: config.contextBudgetChars,
  });
});

function shutdown(signal) {
  log.info('shutting_down', { signal });
  // Stop accepting new connections; finish in-flight requests (every write is awaited before replying).
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), config.requestTimeoutMs + 1_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

