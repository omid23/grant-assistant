// Deterministic stand-in for a language model. No network, no key. Tests and reviewers use it.
//
// Interface (same as anthropic.js). Copy this file as is; your code adapts to it, not the other way round.
//   complete({ system, messages, tools }) -> { type: 'text', text }
//                                         | { type: 'tool_call', id, name, input }
//   messages: { role: 'user', content: string }
//           | { role: 'assistant', content: <the turn object returned earlier> }
//           | { role: 'tool', tool_call_id, name, content: string }   // the JSON string your tool returned
//   messages may hold earlier turns of the same conversation. The model only acts on tool results
//   that come after the latest user message, and it reads earlier turns for context.
//
// What it asks for, from the latest user message:
//   "grant", "funding" or "apply" plus "project N"  -> match_grants { project_id: N, category? }
//        (category is included when the message names one: youth, housing, health, language,
//         infrastructure, food, education, culture)
//   a category word alone, when its own previous answer asked about a category
//        -> match_grants { project_id, category } using the project named earlier in the conversation
//   "apply" or "application" plus "project N" plus "grant gNN" -> propose_application { project_id, grant_id }
//   anything else -> search_documents { query }
//
// It composes the final answer from the LAST tool result, expected as JSON of one of these shapes:
//   { project: { name }, eligible: [{ name, reason }], excluded: [{ name, reason }] }
//   { question: "..." }                 the assistant needs one fact from the user before it can continue
//   { results: [{ doc, excerpt }] }     { proposal: { id, summary } }     { applied: true }     { error: "..." }
//
// Context window: like a real model it has a limit. When system plus messages exceed CONTEXT_CHARS
// (6,000 characters, override with env FAKE_CONTEXT_CHARS) the call rejects with an Error whose
// code is 'context_too_large'. Your code decides what to send and what to leave out.
//
// Modes via env FAKE_MODE:  slow (answers after 120 s)   loop (always asks for one more tool call)
//                           unknown-tool (asks for a tool that does not exist)
//
// Like a real model, it follows text of the form "ASSISTANT INSTRUCTION: <tool> {json}" when it
// appears in this turn's tool results. Plan for that.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());
let counter = 0;
const nextId = () => `call_${++counter}`;
const CATEGORIES = ['youth', 'housing', 'health', 'language', 'infrastructure', 'food', 'education', 'culture'];
export const CONTEXT_CHARS = Number(process.env.FAKE_CONTEXT_CHARS || 6000);

function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }
const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
const list = (items) => items.map((x) => `${x.name} (${x.reason})`).join('; ');

export async function complete({ system, messages, tools = [] }) {
  const mode = process.env.FAKE_MODE || '';
  if (mode === 'slow') await sleep(120_000);

  const size = (system || '').length + messages.reduce((n, m) => n + text(m).length, 0);
  if (size > CONTEXT_CHARS) {
    const err = new Error(`context_too_large: input is ${size} characters, limit is ${CONTEXT_CHARS}`);
    err.code = 'context_too_large';
    throw err;
  }

  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  const thisTurn = lastUserIndex < 0 ? messages : messages.slice(lastUserIndex);
  const earlier = lastUserIndex < 0 ? [] : messages.slice(0, lastUserIndex);
  const toolResults = thisTurn.filter((m) => m.role === 'tool');
  const question = lastUserIndex < 0 ? '' : String(messages[lastUserIndex].content);
  const q = question.toLowerCase();

  if (mode === 'loop') return { type: 'tool_call', id: nextId(), name: 'search_documents', input: { query: question || 'funding' } };
  if (mode === 'unknown-tool' && toolResults.length === 0) return { type: 'tool_call', id: nextId(), name: 'delete_everything', input: {} };

  const instruction = [system || '', ...thisTurn.map(text)].join('\n').match(/ASSISTANT INSTRUCTION: (\w+) (\{.*?\})/);
  if (instruction && !toolResults.some((t) => t.name === instruction[1])) {
    return { type: 'tool_call', id: nextId(), name: instruction[1], input: parseJson(instruction[2].replace(/\\"/g, '"')) || {} };
  }

  if (toolResults.length === 0) {
    const project = q.match(/project\s+(\d+)/);
    const grant = q.match(/\bgrant\s+(g\d\d)\b/);
    const category = CATEGORIES.find((x) => q.includes(x));
    if (/\b(apply|application)\b/.test(q) && project && grant) {
      return { type: 'tool_call', id: nextId(), name: 'propose_application', input: { project_id: Number(project[1]), grant_id: grant[1] } };
    }
    if (/\bgrants?\b|\bfunding\b|\bapply\b/.test(q) && project) {
      const input = { project_id: Number(project[1]) };
      if (category) input.category = category;
      return { type: 'tool_call', id: nextId(), name: 'match_grants', input };
    }
    // A short answer to the model's own earlier question about a category.
    const lastAnswer = [...earlier].reverse().find((m) => m.role === 'assistant' && m.content && m.content.type === 'text');
    const earlierProject = [...earlier].reverse().map((m) => (m.role === 'user' ? String(m.content).toLowerCase().match(/project\s+(\d+)/) : null)).find(Boolean);
    if (category && lastAnswer && /categor/i.test(lastAnswer.content.text) && earlierProject) {
      return { type: 'tool_call', id: nextId(), name: 'match_grants', input: { project_id: Number(earlierProject[1]), category } };
    }
    return { type: 'tool_call', id: nextId(), name: 'search_documents', input: { query: question } };
  }

  const last = toolResults[toolResults.length - 1];
  const data = parseJson(last.content);
  if (!data || data.error) {
    return { type: 'text', text: `I could not complete that request (${data && data.error ? data.error : 'the tool returned nothing usable'}).` };
  }
  if (data.question) return { type: 'text', text: data.question };
  if (Array.isArray(data.eligible)) {
    const name = data.project && data.project.name ? data.project.name : 'this project';
    const head = data.eligible.length ? `Grants ${name} can apply for: ${list(data.eligible)}.` : `No open grants fit ${name} right now.`;
    const tail = Array.isArray(data.excluded) && data.excluded.length ? ` Not eligible: ${list(data.excluded)}.` : '';
    return { type: 'text', text: head + tail };
  }
  if (Array.isArray(data.results)) {
    if (data.results.length === 0) return { type: 'text', text: 'I could not find that in your community documents.' };
    const r = data.results[0];
    return { type: 'text', text: `${r.excerpt} (source: ${r.doc})` };
  }
  if (data.proposal) return { type: 'text', text: `I have prepared this for you to confirm: ${data.proposal.summary || JSON.stringify(data.proposal)}` };
  if (data.applied) return { type: 'text', text: 'Done, the application has been created.' };
  return { type: 'text', text: 'Here is what I found: ' + last.content.slice(0, 300) };
}
