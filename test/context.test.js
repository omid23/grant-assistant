// Context budget: long conversations and large documents never push the model over its window,
// and the latest message and the question being waited on are never dropped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fake from '../model/fake.js';
import { startServer, spy } from './helpers.js';
import { buildMessages, measure, cutAround } from '../src/agent/context.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { silentLogger } from '../src/log.js';

describe('measure', () => {
  test('counts exactly like the fake model: at the limit is accepted, one more is rejected', async () => {
    const messages = [
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: { type: 'text', text: 'hi' } },
      { role: 'user', content: 'what is new?' },
    ];
    const system = 'x'.repeat(fake.CONTEXT_CHARS - measure('', messages));
    assert.equal(measure(system, messages), fake.CONTEXT_CHARS);
    await fake.complete({ system, messages });
    await assert.rejects(fake.complete({ system: `${system}x`, messages }), (e) => e.code === 'context_too_large');
  });
});

describe('buildMessages', () => {
  const system = 'S'.repeat(500);
  const history = [];
  for (let t = 1; t <= 50; t++) {
    history.push({ role: 'user', content: `question ${t} ${'q'.repeat(150)}`, turn: t });
    history.push({ role: 'assistant', content: { type: 'tool_call', id: `c${t}`, name: 'search_documents', input: { query: 'q' } }, turn: t });
    history.push({ role: 'tool', tool_call_id: `c${t}`, name: 'search_documents', content: '{"results":[]}', turn: t });
    history.push({ role: 'assistant', content: { type: 'text', text: `answer ${t} ${'a'.repeat(700)}` }, turn: t });
  }
  const pending = { turn: 3, question: 'Which category is project 3 (Community garden)?', user_message: `${'blah '.repeat(200)}Which grants can project 3 apply for? ${'more '.repeat(100)}` };

  test('stays within budget, keeps the latest message and the pending question, newest turns first', () => {
    const userMessage = 'food';
    const messages = buildMessages({ system, history, pending, userMessage, turn: [], budget: 3000 });
    assert.ok(measure(system, messages) <= 3000);
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'food' });
    const texts = messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.text));
    assert.ok(texts.includes(pending.question), 'pending question kept');
    const pinnedUser = texts.find((t) => t.includes('project 3'));
    assert.ok(pinnedUser && pinnedUser.length <= 300, 'the message that led to the question, cut around "project 3"');
    assert.ok(texts.some((t) => t?.startsWith('question 50 ')), 'newest earlier turn kept');
    assert.ok(!texts.some((t) => t?.startsWith('question 10 ')), 'old turns dropped');
    // chronological: pinned turn 3 comes before turn 50
    assert.ok(texts.indexOf(pending.question) < texts.findIndex((t) => t?.startsWith('question 50 ')));
    // earlier turns' tool calls are not re-sent, and old answers are cut
    assert.ok(messages.every((m) => m.role !== 'tool'));
    assert.ok(messages.filter((m) => m.role === 'assistant').every((m) => m.content.text.length <= 500));
  });

  test('the latest user message is always last among user messages, and intact', () => {
    const userMessage = `please look at ${'z'.repeat(900)}`;
    const turn = [
      { role: 'assistant', content: { type: 'tool_call', id: 'x1', name: 'search_documents', input: { query: userMessage } } },
      { role: 'tool', tool_call_id: 'x1', name: 'search_documents', content: JSON.stringify({ results: [{ doc: 'a.md', excerpt: 'e'.repeat(380) }] }) },
    ];
    const messages = buildMessages({ system, history, pending, userMessage, turn, budget: 6000 });
    const users = messages.filter((m) => m.role === 'user');
    assert.equal(users.at(-1).content, userMessage);
    assert.deepEqual(messages.slice(-2), turn, 'newest tool call and result kept as they are');
    assert.ok(measure(system, messages) <= 6000);
  });

  test('older tool calls in this turn are compacted, then dropped, before anything that must stay', () => {
    const turn = [];
    for (let i = 1; i <= 5; i++) {
      turn.push({ role: 'assistant', content: { type: 'tool_call', id: `t${i}`, name: 'search_documents', input: { query: 'q'.repeat(900) } } });
      turn.push({ role: 'tool', tool_call_id: `t${i}`, name: 'search_documents', content: JSON.stringify({ results: [{ doc: 'a.md', excerpt: 'e'.repeat(390) }] }) });
    }
    const messages = buildMessages({ system, history: [], pending: null, userMessage: 'hi', turn, budget: 2200 });
    assert.ok(measure(system, messages) <= 2200);
    assert.deepEqual(messages.slice(-2), turn.slice(-2));
    const stubs = messages.filter((m) => m.role === 'tool' && m.content.includes('omitted'));
    assert.ok(stubs.length >= 1 && stubs.length < 4);
  });

  test('returns null when even the never-dropped parts cannot fit', () => {
    assert.equal(buildMessages({ system, history: [], pending: null, userMessage: 'u'.repeat(2000), turn: [], budget: 1000 }), null);
  });

  test('cutAround keeps the project mention', () => {
    const text = `${'a'.repeat(1000)} project 42 ${'b'.repeat(1000)}`;
    const cut = cutAround(text, 300);
    assert.ok(cut.length <= 300);
    assert.match(cut, /project 42/);
  });
});

describe('through /chat', () => {
  test('a long conversation never exceeds the window and still answers the latest message', async () => {
    const model = spy();
    const s = await startServer({ model });
    try {
      let id;
      for (let i = 0; i < 60; i++) {
        const r = await s.chat({ community_id: 'cedar-hollow', message: `When is the youth program report due? (${i}) ${'please '.repeat(60)}`, ...(id ? { conversation_id: id } : {}) });
        id = r.conversation_id;
        assert.match(r.reply, /source: youth-program-guidelines\.md/);
      }
      const last = await s.chat({ community_id: 'cedar-hollow', message: 'Which grants can project 1 apply for?', conversation_id: id });
      assert.match(last.reply, /^Grants Youth Leadership Program can apply for/);
      const sizes = model.calls.map((c) => c.size);
      assert.ok(Math.max(...sizes) <= s.config.contextBudgetChars, `largest call ${Math.max(...sizes)}`);
      const stored = await s.deps.store.conversations.get('cedar-hollow', id);
      assert.ok(stored.messages.length <= 200, 'stored history is capped');
    } finally { await s.close(); }
  });

  test('after a long history, the category question is still answered by "food"', async () => {
    const s = await startServer();
    try {
      let id;
      for (let i = 0; i < 40; i++) {
        id = (await s.chat({ community_id: 'cedar-hollow', message: `Who submits grant applications? ${'really '.repeat(80)}`, ...(id ? { conversation_id: id } : {}) })).conversation_id;
      }
      assert.match((await s.chat({ community_id: 'cedar-hollow', message: 'Which grants can project 3 apply for?', conversation_id: id })).reply, /has no category/);
      assert.match((await s.chat({ community_id: 'cedar-hollow', message: 'food', conversation_id: id })).reply, /^Grants Community garden can apply for: Northern Greenhouse Pilot/);
    } finally { await s.close(); }
  });

  test('a long question and a long answer: the pinned question still links them', async () => {
    const model = spy();
    const s = await startServer({ model });
    try {
      const longQuestion = `${'Some background on the garden. '.repeat(20)}Which grants can project 3 apply for? ${'Thanks. '.repeat(40)}`.slice(0, 1000);
      const first = await s.chat({ community_id: 'cedar-hollow', message: longQuestion });
      assert.match(first.reply, /has no category/);
      const longAnswer = `It is a food project. ${'z'.repeat(1000)}`.slice(0, 1000);
      const second = await s.chat({ community_id: 'cedar-hollow', message: longAnswer, conversation_id: first.conversation_id });
      assert.match(second.reply, /^Grants Community garden can apply for/);
      for (const c of model.calls) assert.ok(c.size <= s.config.contextBudgetChars);
    } finally { await s.close(); }
  });

  test('a message over MAX_MESSAGE_CHARS gets a reply asking to shorten it; the model is not called', async () => {
    const model = spy();
    const s = await startServer({ model });
    try {
      const r = await s.call('POST', '/chat', { community_id: 'cedar-hollow', message: 'x'.repeat(1001) });
      assert.equal(r.status, 200);
      assert.match(r.body.reply, /1001 characters long. Please keep it under 1000/);
      assert.equal(r.body.proposal, null);
      assert.ok(r.body.conversation_id);
      assert.equal(model.calls.length, 0);
      assert.equal(await s.deps.store.conversations.get('cedar-hollow', r.body.conversation_id), null);
    } finally { await s.close(); }
  });

  test('the 7,000-character community plan only ever goes to the model as short excerpts', async () => {
    const model = spy();
    const s = await startServer({ model });
    try {
      const r = await s.chat({ community_id: 'cedar-hollow', message: 'What does the plan say about the water line, the daycare and the arena?' });
      assert.match(r.reply, /source: community-plan-2026\.md/);
      const tool = model.calls.at(-1).messages.find((m) => m.role === 'tool');
      for (const x of JSON.parse(tool.content).results) assert.ok(x.excerpt.length <= s.config.chunkChars);
      assert.ok(model.calls.every((c) => c.size <= s.config.contextBudgetChars));
    } finally { await s.close(); }
  });

  test('with a much smaller window (FAKE_CONTEXT_CHARS=3000) everything still fits', async () => {
    process.env.FAKE_CONTEXT_CHARS = '3000';
    // A fresh copy of the fake model, so it reads the variable at import time.
    const small = await import('../model/fake.js?context=3000');
    delete process.env.FAKE_CONTEXT_CHARS;
    assert.equal(small.CONTEXT_CHARS, 3000);
    const model = spy(small);
    const s = await startServer({
      model,
      env: { CONTEXT_BUDGET_CHARS: '3000', MAX_MESSAGE_CHARS: '300', MAX_TOOL_RESULT_CHARS: '1000', PENDING_RESERVE_CHARS: '400' },
    });
    try {
      const plan = await s.chat({ community_id: 'cedar-hollow', message: 'What does the plan say about the water line and the arena roof?' });
      assert.match(plan.reply, /source: community-plan-2026\.md/);
      const grants = await s.chat({ community_id: 'lakeshore', message: 'Which grants can project 6 apply for?' });
      assert.match(grants.reply, /No open grants fit Youth summer camp 2026/);
      let id;
      for (let i = 0; i < 15; i++) {
        id = (await s.chat({ community_id: 'cedar-hollow', message: `Who submits grant applications? ${i}`, ...(id ? { conversation_id: id } : {}) })).conversation_id;
      }
      assert.ok(model.calls.every((c) => c.size <= 3000), `largest ${Math.max(...model.calls.map((c) => c.size))}`);
    } finally { await s.close(); }
  });

  test('settings that cannot fit the window are rejected at startup with a clear message', () => {
    const config = loadConfig({ CONTEXT_BUDGET_CHARS: '2000', LOG_LEVEL: 'silent' });
    assert.throws(() => createApp({ model: fake, config, storeDriver: 'memory', logger: silentLogger }), /Context budget too small/);
  });
});
