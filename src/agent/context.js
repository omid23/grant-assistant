// What goes to the model each step, within a fixed character budget.
//
// Never dropped:
//   - the system prompt
//   - the latest user message, intact
//   - the question the assistant is waiting on (and the user message that led to it, cut to ~300 chars
//     around "project N" so the model still knows which project it was about)
//   - the newest tool call and its result in this turn (the model answers from it)
// Then, while they fit:
//   - older tool calls in this turn, compacted to stubs (dropped oldest first if needed)
//   - earlier turns, newest first, as [user message, final answer] pairs, answers cut to 500 chars.
//     Earlier turns' tool calls and results are never re-sent; their answers already say what mattered.
// The result is always in chronological order, and the latest user message is the last "user" role.

export const OLD_ANSWER_CHARS = 500;
export const PINNED_USER_CHARS = 300;

/** Size of a model call, computed exactly as model/fake.js does. */
export const textOf = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
export const measure = (system, messages) => (system || '').length + messages.reduce((n, m) => n + textOf(m).length, 0);

const cut = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Cut a user message to `max` chars, keeping the "project N" mention inside the window. */
export function cutAround(text, max = PINNED_USER_CHARS) {
  if (text.length <= max) return text;
  const at = Math.max(0, text.search(/project\s+\d+/i));
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), text.length - max));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max - 2)}…`;
}

const answerText = (m) => (m.content && m.content.type === 'text' ? m.content.text : null);

/** Earlier turns from stored history: [{ turn, user, answer }] for complete turns, oldest first. */
function earlierTurns(history) {
  const turns = new Map();
  for (const m of history) {
    if (!turns.has(m.turn)) turns.set(m.turn, { turn: m.turn, user: null, answer: null });
    const t = turns.get(m.turn);
    if (m.role === 'user') t.user = m.content;
    else if (m.role === 'assistant' && answerText(m) != null) t.answer = answerText(m);
  }
  return [...turns.values()].filter((t) => t.user != null && t.answer != null).sort((a, b) => a.turn - b.turn);
}

const pair = (user, answer) => [
  { role: 'user', content: user },
  { role: 'assistant', content: { type: 'text', text: answer } },
];

const stub = (call) => [
  { role: 'assistant', content: { ...call[0].content, input: {} } },
  { ...call[1], content: '{"omitted":"earlier result in this turn"}' },
];

/**
 * @param {object} p
 * @param {string} p.system
 * @param {object[]} p.history     stored messages of earlier turns ({role, content, turn})
 * @param {object|null} p.pending  { turn, question, user_message } the question being waited on
 * @param {string} p.userMessage   the latest user message
 * @param {object[]} p.turn        this turn's messages so far: alternating tool_call / tool result
 * @param {number} p.budget        max characters, measured like the model measures
 * @param {(content: string, max: number) => string} [p.shrinkResult]  fits a tool result into max chars
 * @param {boolean} [p.minimal]    only the never-dropped parts (used when the model still rejects)
 * @returns {object[]|null} messages, or null when even the never-dropped parts do not fit
 */
export function buildMessages({ system, history, pending, userMessage, turn, budget, shrinkResult, minimal = false }) {
  const pinned = pending ? { turn: pending.turn, messages: pair(cutAround(pending.user_message || ''), pending.question) } : null;
  const user = { role: 'user', content: userMessage };

  const pairs = [];
  for (let i = 0; i + 1 < turn.length; i += 2) pairs.push([turn[i], turn[i + 1]]);
  let latest = pairs.pop() || null;
  let older = minimal ? [] : pairs.map(stub);

  const assemble = (before) => [...before, user, ...older.flat(), ...(latest || [])];
  const fixedBefore = pinned ? pinned.messages : [];

  // 1. The never-dropped set, shrinking only what may shrink.
  while (measure(system, assemble(fixedBefore)) > budget && older.length) older.shift();
  if (latest && measure(system, assemble(fixedBefore)) > budget && shrinkResult) {
    const over = measure(system, assemble(fixedBefore)) - budget;
    const content = latest[1].content;
    latest = [latest[0], { ...latest[1], content: shrinkResult(content, Math.max(0, content.length - over)) }];
  }
  if (measure(system, assemble(fixedBefore)) > budget) return null;
  if (minimal) return assemble(fixedBefore);

  // 2. Earlier turns, newest first, while they fit. Stop at the first that does not,
  //    so what the model sees is always a contiguous recent stretch of the conversation.
  const kept = pinned ? [pinned] : [];
  for (const t of earlierTurns(history).reverse()) {
    if (pinned && t.turn === pinned.turn) continue;
    const candidate = { turn: t.turn, messages: pair(t.user, cut(t.answer, OLD_ANSWER_CHARS)) };
    const before = [...kept, candidate].sort((a, b) => a.turn - b.turn).flatMap((x) => x.messages);
    if (measure(system, assemble(before)) > budget) break;
    kept.push(candidate);
  }
  return assemble(kept.sort((a, b) => a.turn - b.turn).flatMap((x) => x.messages));
}
