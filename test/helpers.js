// Shared test setup: a real HTTP server on a random port, wired to the fake model,
// an in-memory store (or a temp dir) and a fixed date. No network beyond localhost.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fake from '../model/fake.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createClock } from '../src/clock.js';
import { silentLogger } from '../src/log.js';
import { measure } from '../src/agent/context.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
// Tests pin the date so real deadlines passing never changes the expected results.
export const TODAY = '2026-11-05';

/** Wraps a model so tests can see every call and its size, measured the way the fake measures. */
export function spy(model = fake) {
  const calls = [];
  return {
    calls,
    async complete(args) {
      calls.push({ size: measure(args.system, args.messages), messages: args.messages, system: args.system });
      return model.complete(args);
    },
  };
}

/** A model that returns the given turns in order (then repeats the last), for loop tests. */
export function scripted(turns) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async complete(args) {
      calls.push(args);
      const next = turns[Math.min(i++, turns.length - 1)];
      if (typeof next === 'function') return next(args);
      return next;
    },
  };
}

/**
 * Start the service. Options: env (config overrides), model, storeDriver ('memory' default),
 * stateDir (with storeDriver 'file'), clock, tools.
 */
export async function startServer({ env = {}, model = spy(), storeDriver = 'memory', stateDir, clock, tools } = {}) {
  const config = loadConfig(
    { TODAY, LOG_LEVEL: 'silent', ...(stateDir ? { STATE_DIR: stateDir } : {}), ...env },
    { modelContextChars: fake.CONTEXT_CHARS },
  );
  const app = createApp({ model, config, storeDriver, logger: silentLogger, clock: clock || createClock({ today: TODAY }), ...(tools ? { tools } : {}) });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body) => {
    const res = await fetch(url + route, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  return {
    url,
    model,
    config,
    deps: app.deps,
    call,
    chat: async (body) => (await call('POST', '/chat', body)).body,
    get: async (route) => (await call('GET', route)).body,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** Run fn with FAKE_MODE set (the fake reads it on every call), restoring it afterwards. */
export async function withFakeMode(mode, fn) {
  const before = process.env.FAKE_MODE;
  process.env.FAKE_MODE = mode;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.FAKE_MODE;
    else process.env.FAKE_MODE = before;
  }
}
