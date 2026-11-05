// All runtime settings come from environment variables, parsed once at startup.
// Every variable, its default and its meaning is listed in README.md and .env.example.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readInt(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Invalid ${name}: expected an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function readDate(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error(`Invalid ${name}: expected YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

const LOG_LEVELS = ['info', 'error', 'silent'];

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ modelContextChars?: number }} [opts] the model's own context limit, when it exports one
 */
export function loadConfig(env = process.env, { modelContextChars } = {}) {
  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`Invalid LOG_LEVEL: expected one of ${LOG_LEVELS.join(', ')}`);
  return {
    port: readInt(env, 'PORT', 3000),
    maxSteps: readInt(env, 'MAX_STEPS', 6, { min: 1 }),
    requestTimeoutMs: readInt(env, 'REQUEST_TIMEOUT_MS', 10_000, { min: 1 }),
    contextBudgetChars: readInt(env, 'CONTEXT_BUDGET_CHARS', Number(modelContextChars) || 6000, { min: 1 }),
    maxMessageChars: readInt(env, 'MAX_MESSAGE_CHARS', 1000, { min: 1 }),
    maxToolResultChars: readInt(env, 'MAX_TOOL_RESULT_CHARS', 1800, { min: 200 }),
    pendingReserveChars: readInt(env, 'PENDING_RESERVE_CHARS', 650),
    searchTopK: readInt(env, 'SEARCH_TOP_K', 3, { min: 1 }),
    chunkChars: readInt(env, 'CHUNK_CHARS', 400, { min: 100 }),
    maxBodyBytes: readInt(env, 'MAX_BODY_BYTES', 65_536, { min: 1024 }),
    dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data'),
    stateDir: env.STATE_DIR ? path.resolve(env.STATE_DIR) : path.join(ROOT, 'var'),
    today: readDate(env, 'TODAY'),
    logLevel,
  };
}
