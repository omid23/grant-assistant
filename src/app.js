// Wires the service together. Everything is passed in, so tests can swap the model, store and clock.
import { loadCatalog } from './catalog/catalog.js';
import { buildDocIndex } from './docs/index.js';
import { createStore } from './store/index.js';
import { createClock } from './clock.js';
import { createLogger } from './log.js';
import { createMutex } from './lib/mutex.js';
import { tools as defaultTools } from './tools/index.js';
import { buildSystemPrompt } from './agent/prompt.js';
import { createHandler } from './http/router.js';

// A tool call carrying the whole latest message (the fake model sends it as the search query) + JSON overhead.
const TOOL_CALL_OVERHEAD = 200;

/** Fail at startup, not on the first long conversation, if the settings cannot fit the budget. */
export function checkBudget(config, catalog) {
  const longestName = catalog.communityIds().map((cid) => catalog.getCommunity(cid).name).sort((a, b) => b.length - a.length)[0] || '';
  const system = buildSystemPrompt({ communityName: longestName, today: '0000-00-00' }).length;
  const needed = system + 2 * config.maxMessageChars + TOOL_CALL_OVERHEAD + config.maxToolResultChars + config.pendingReserveChars;
  if (needed > config.contextBudgetChars) {
    throw new Error(
      `Context budget too small: system prompt ${system} + 2 x MAX_MESSAGE_CHARS ${config.maxMessageChars} + ${TOOL_CALL_OVERHEAD} ` +
        `+ MAX_TOOL_RESULT_CHARS ${config.maxToolResultChars} + PENDING_RESERVE_CHARS ${config.pendingReserveChars} = ${needed}, ` +
        `but CONTEXT_BUDGET_CHARS is ${config.contextBudgetChars}. Lower the limits or raise the budget.`,
    );
  }
}

/**
 * @param {object} p
 * @param {{ complete: Function }} p.model
 * @param {object} p.config            from loadConfig()
 * @param {'file'|'memory'} [p.storeDriver]
 */
export function createApp({ model, config, storeDriver = 'file', store, catalog, docs, clock, logger, tools = defaultTools }) {
  const log = logger || createLogger({ level: config.logLevel });
  const cat = catalog || loadCatalog(config.dataDir);
  checkBudget(config, cat);
  const withLock = createMutex();
  const deps = {
    model,
    config,
    tools,
    logger: log,
    withLock,
    catalog: cat,
    docs: docs || buildDocIndex(cat, { chunkChars: config.chunkChars }),
    clock: clock || createClock({ today: config.today }),
    store: store || createStore({ driver: storeDriver, dir: config.stateDir, communityIds: cat.communityIds(), withLock, logger: log }),
  };
  return { handler: createHandler(deps), deps };
}
