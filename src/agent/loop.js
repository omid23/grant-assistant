// The agent loop for one request: ask the model, run the tool it asks for, hand back the result,
// repeat until it answers. Bounded three ways:
//   - at most MAX_STEPS model calls; a tool asked for on the last step is refused, not run
//   - REQUEST_TIMEOUT_MS for the whole request; a slow model is abandoned, not awaited
//   - every model call fits the context budget (context.js)
// Whatever happens, the caller gets { reply } back. Model and tool errors never escape as exceptions.
import { buildMessages } from './context.js';
import { validateInput } from '../tools/index.js';

export const REPLIES = {
  stepCap: (n) => `I couldn't finish this within ${n} steps, so I stopped. Please try asking in a simpler way.`,
  timeout: (ms) => `That took longer than ${Math.round(ms / 1000)} seconds, so I stopped. Please try again.`,
  modelError: () => 'The assistant is unavailable right now, so I could not answer. Please try again in a moment.',
  tooLarge: () => 'That needs more context than I can handle at once. Please ask a shorter or more specific question.',
  empty: () => "I don't have an answer for that.",
};

const TIMEOUT = Symbol('timeout');

function withDeadline(promise, ms) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, ms)); });
  // The abandoned call may still settle later; make sure that can never become an unhandled rejection.
  promise.catch(() => {});
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Fit a tool result into `max` characters: drop items from the end of its lists (noting how many),
 * then fall back to a short error. Results from our own tools are far below the limit in practice.
 */
export function fitResult(result, max) {
  let json = JSON.stringify(result);
  if (json.length <= max) return json;
  const copy = structuredClone(result);
  const lists = Object.keys(copy).filter((k) => Array.isArray(copy[k])).reverse();
  let dropped = 0;
  for (const key of lists) {
    while (copy[key].length && json.length > max) {
      copy[key].pop();
      copy.truncated = ++dropped;
      json = JSON.stringify(copy);
    }
  }
  return json.length <= max ? json : JSON.stringify({ error: 'the result was too large to show' }).slice(0, max);
}

const shrinkResult = (content, max) => {
  try { return fitResult(JSON.parse(content), max); } catch { return content.slice(0, max); }
};

const clip = (value) =>
  JSON.parse(JSON.stringify(value ?? {}, (k, v) => (typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v)));

/**
 * @param {object} p
 * @param {{ complete: Function }} p.model
 * @param {object[]} p.tools              tool objects (see tools/index.js)
 * @param {string} p.system
 * @param {object} p.conversation         { messages, pending } — pending may be changed by tools
 * @param {string} p.userMessage
 * @param {object} p.toolContext          passed to every tool's run()
 * @param {(entry: object) => Promise<void>} p.audit
 * @param {{ maxSteps, requestTimeoutMs, contextBudgetChars, maxToolResultChars }} p.config
 * @param {{ error: Function }} p.logger
 * @returns {Promise<{ reply: string, proposal: object|null, turnMessages: object[], endedBy: string }>}
 */
export async function runAgent({ model, tools, system, conversation, userMessage, toolContext, audit, config, logger }) {
  const startedAt = Date.now();
  const deadline = startedAt + config.requestTimeoutMs;
  const definitions = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const turn = [];
  let tainted = false;
  let proposal = null;
  let retried = false;

  const done = (reply, endedBy) => ({ reply, proposal, turnMessages: turn, endedBy });

  for (let step = 1; step <= config.maxSteps; step++) {
    if (Date.now() >= deadline) return done(REPLIES.timeout(config.requestTimeoutMs), 'timeout');

    const build = (minimal) =>
      buildMessages({
        system, history: conversation.messages, pending: conversation.pending, userMessage, turn,
        budget: config.contextBudgetChars, shrinkResult, minimal,
      });
    let messages = build(false);
    if (!messages) return done(REPLIES.tooLarge(), 'too_large');

    let response;
    for (;;) {
      try {
        response = await withDeadline(Promise.resolve().then(() => model.complete({ system, messages, tools: definitions })), deadline - Date.now());
        break;
      } catch (error) {
        if (error && error.code === 'context_too_large' && !retried) {
          // Our measure should prevent this; if a model counts differently, retry once with the minimum.
          retried = true;
          messages = build(true);
          if (messages) continue;
        }
        logger.error('model_error', { code: error?.code, message: String(error?.message || error).slice(0, 300) });
        return done(error?.code === 'context_too_large' ? REPLIES.tooLarge() : REPLIES.modelError(), 'model_error');
      }
    }
    if (response === TIMEOUT) return done(REPLIES.timeout(config.requestTimeoutMs), 'timeout');

    if (!response || response.type === 'text') {
      const text = response && typeof response.text === 'string' && response.text.trim() ? response.text : REPLIES.empty();
      return done(text, 'answer');
    }
    if (response.type !== 'tool_call' || typeof response.name !== 'string') {
      logger.error('model_error', { message: 'unexpected response shape' });
      return done(REPLIES.modelError(), 'model_error');
    }

    const started = Date.now();
    const record = (outcome, detail) =>
      audit({ tool: response.name, input: clip(response.input), outcome, ms: Date.now() - started, at: new Date(started).toISOString(), detail });

    if (step === config.maxSteps) {
      await record('refused', 'step limit reached');
      return done(REPLIES.stepCap(config.maxSteps), 'step_cap');
    }

    const { outcome, result, detail } = await runTool(response, { tools, tainted, toolContext, logger });
    await record(outcome, detail);
    if (outcome === 'ok' && tools.find((t) => t.name === response.name)?.untrustedOutput) tainted = true;
    if (outcome === 'ok' && response.name === 'propose_application' && result.proposal) proposal = result.proposal;

    turn.push({ role: 'assistant', content: response });
    turn.push({ role: 'tool', tool_call_id: response.id, name: response.name, content: fitResult(result, config.maxToolResultChars) });
  }
  // Not reachable: the last step either answers or is refused above.
  return done(REPLIES.stepCap(config.maxSteps), 'step_cap');
}

async function runTool(call, { tools, tainted, toolContext, logger }) {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { outcome: 'refused', result: { error: `unknown tool ${call.name}` }, detail: 'unknown tool' };
  if (tool.sideEffect && tainted) {
    // Document text entered this turn; anything that writes must come from the user, not from a document.
    return {
      outcome: 'refused',
      result: { error: 'I can only prepare an application when you ask for it directly, not because a document says so' },
      detail: 'side effect after untrusted content',
    };
  }
  const checked = validateInput(tool, call.input);
  if (checked.error) return { outcome: 'failed', result: { error: checked.error }, detail: 'invalid input' };
  try {
    return await tool.run(checked.input, toolContext);
  } catch (error) {
    logger.error('tool_error', { tool: tool.name, message: String(error?.message || error).slice(0, 300) });
    return { outcome: 'failed', result: { error: `${tool.name} failed` }, detail: 'exception' };
  }
}
