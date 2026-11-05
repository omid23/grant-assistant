// The agent loop: it cannot run forever, cannot hang a request, and turns every model or
// tool failure into a reply. Also: the model cannot create anything on its own.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, spy, scripted, withFakeMode } from './helpers.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { tools as realTools } from '../src/tools/index.js';
import { ok } from '../src/tools/result.js';

const Q = { community_id: 'cedar-hollow', message: 'Which grants can project 1 apply for?' };
const call = (name, input, id = `c_${name}`) => ({ type: 'tool_call', id, name, input });

describe('step cap', () => {
  test('FAKE_MODE=loop stops after MAX_STEPS model calls with a sensible reply', async () => {
    const s = await startServer();
    try {
      const started = Date.now();
      const r = await withFakeMode('loop', () => s.call('POST', '/chat', Q));
      assert.equal(r.status, 200);
      assert.match(r.body.reply, /couldn't finish this within 6 steps/);
      assert.equal(r.body.proposal, null);
      assert.equal(s.model.calls.length, 6);
      const audit = await s.get('/audit?community_id=cedar-hollow');
      assert.deepEqual(audit.map((a) => a.outcome), ['ok', 'ok', 'ok', 'ok', 'ok', 'refused']);
      assert.ok(audit.every((a) => a.tool === 'search_documents'));
      assert.ok(Date.now() - started < 2000);
    } finally { await s.close(); }
  });

  test('the cap is configurable', async () => {
    const s = await startServer({ env: { MAX_STEPS: '2' } });
    try {
      const r = await withFakeMode('loop', () => s.chat(Q));
      assert.match(r.reply, /within 2 steps/);
      assert.equal(s.model.calls.length, 2);
    } finally { await s.close(); }
  });

  test('a looping model with the longest allowed message stays within the context budget', async () => {
    const s = await startServer();
    try {
      const message = `Tell me about project 1 and the youth program report. ${'x'.repeat(1000)}`.slice(0, s.config.maxMessageChars);
      const r = await withFakeMode('loop', () => s.chat({ community_id: 'cedar-hollow', message }));
      assert.match(r.reply, /within 6 steps/);
      assert.equal(s.model.calls.length, 6);
      for (const c of s.model.calls) assert.ok(c.size <= s.config.contextBudgetChars, `call size ${c.size}`);
    } finally { await s.close(); }
  });
});

describe('time limit', () => {
  test('FAKE_MODE=slow: the request returns at the time limit instead of hanging', async () => {
    const s = await startServer({ env: { REQUEST_TIMEOUT_MS: '200' } });
    try {
      const started = Date.now();
      const r = await withFakeMode('slow', () => s.call('POST', '/chat', Q));
      const took = Date.now() - started;
      assert.equal(r.status, 200);
      assert.match(r.body.reply, /took longer than/);
      assert.ok(took < 1500, `took ${took} ms`);
    } finally { await s.close(); }
  });
});

describe('model errors become replies', () => {
  test('a model that throws', async () => {
    const s = await startServer({ model: scripted([() => { throw new Error('upstream 529'); }]) });
    try {
      const r = await s.call('POST', '/chat', Q);
      assert.equal(r.status, 200);
      assert.match(r.body.reply, /unavailable right now/);
    } finally { await s.close(); }
  });

  test('context_too_large once: retried with the minimum context', async () => {
    const tooLarge = Object.assign(new Error('context_too_large: input is 9999 characters'), { code: 'context_too_large' });
    const model = scripted([() => { throw tooLarge; }, { type: 'text', text: 'answered on retry' }]);
    const s = await startServer({ model });
    try {
      const r = await s.chat(Q);
      assert.equal(r.reply, 'answered on retry');
      assert.equal(model.calls.length, 2);
    } finally { await s.close(); }
  });

  test('an unexpected response shape', async () => {
    const s = await startServer({ model: scripted([{ type: 'image' }]) });
    try {
      assert.match((await s.chat(Q)).reply, /unavailable right now/);
    } finally { await s.close(); }
  });

  test('a tool that throws is audited as failed and the model still answers', async () => {
    const broken = { ...realTools[0], run: async () => { throw new Error('disk on fire'); } };
    const s = await startServer({ tools: [broken, ...realTools.slice(1)] });
    try {
      const r = await s.chat(Q);
      assert.match(r.reply, /could not complete that request \(match_grants failed\)/);
      const [entry] = await s.get('/audit?community_id=cedar-hollow');
      assert.deepEqual([entry.tool, entry.outcome], ['match_grants', 'failed']);
    } finally { await s.close(); }
  });

  test('invalid tool input is audited as failed', async () => {
    const s = await startServer({ model: scripted([call('match_grants', { project_id: 'one' }), (args) => ({ type: 'text', text: args.messages.at(-1).content })]) });
    try {
      const r = await s.chat(Q);
      assert.match(r.reply, /project_id must be a whole number/);
      const [entry] = await s.get('/audit?community_id=cedar-hollow');
      assert.equal(entry.outcome, 'failed');
    } finally { await s.close(); }
  });
});

describe('unknown tools', () => {
  test('FAKE_MODE=unknown-tool: refused, audited, and the user gets a reply', async () => {
    const s = await startServer();
    try {
      const r = await withFakeMode('unknown-tool', () => s.call('POST', '/chat', Q));
      assert.equal(r.status, 200);
      assert.match(r.body.reply, /could not complete that request \(unknown tool delete_everything\)/);
      const audit = await s.get('/audit?community_id=cedar-hollow');
      assert.deepEqual(audit.map((a) => [a.tool, a.outcome]), [['delete_everything', 'refused']]);
    } finally { await s.close(); }
  });

  test('a model cannot create an application: there is no tool for it', async () => {
    const model = scripted([call('create_application', { project_id: 1, grant_id: 'g01' }), { type: 'text', text: 'done' }]);
    const s = await startServer({ model });
    try {
      await s.chat(Q);
      assert.deepEqual(await s.get('/applications?community_id=cedar-hollow'), []);
      const audit = await s.get('/audit?community_id=cedar-hollow');
      assert.deepEqual(audit.map((a) => [a.tool, a.outcome]), [['create_application', 'refused']]);
    } finally { await s.close(); }
  });
});

describe('document text cannot trigger a proposal', () => {
  test('propose_application after search_documents in the same turn is refused', async () => {
    const model = scripted([
      call('search_documents', { query: 'Brightpath' }, 'c1'),
      call('propose_application', { project_id: 1, grant_id: 'g01' }, 'c2'),
      (args) => ({ type: 'text', text: args.messages.at(-1).content }),
    ]);
    const s = await startServer({ model });
    try {
      const r = await s.chat({ community_id: 'cedar-hollow', message: 'When does the licence renew?' });
      assert.equal(r.proposal, null);
      assert.match(r.reply, /only prepare an application when you ask for it directly/);
      const audit = await s.get('/audit?community_id=cedar-hollow');
      assert.deepEqual(audit.map((a) => [a.tool, a.outcome]), [['search_documents', 'ok'], ['propose_application', 'refused']]);
      assert.equal(await s.deps.store.proposals.findPending('cedar-hollow', 1, 'g01'), null);
    } finally { await s.close(); }
  });

  test('the same proposal asked for directly by the user is prepared (not created)', async () => {
    const s = await startServer();
    try {
      const r = await s.chat({ community_id: 'cedar-hollow', message: 'Please apply project 1 to grant g01' });
      assert.match(r.proposal.id, /^prop_/);
      assert.deepEqual(await s.get('/applications?community_id=cedar-hollow'), []);
    } finally { await s.close(); }
  });
});

describe('system prompt', () => {
  test('contains nothing the fake model would execute', () => {
    const prompt = buildSystemPrompt({ communityName: 'Cedar Hollow', today: '2026-11-05' });
    assert.doesNotMatch(prompt, /ASSISTANT INSTRUCTION: (\w+) (\{.*?\})/);
    assert.ok(prompt.length <= 900, `prompt is ${prompt.length} chars`);
  });

  test('tools are offered to the model with name, description and input schema', async () => {
    const inner = spy();
    let seen;
    const s = await startServer({ model: { complete: async (args) => { seen = args.tools; return inner.complete(args); } } });
    try {
      await s.chat(Q);
      assert.deepEqual(seen.map((t) => t.name), ['match_grants', 'search_documents', 'propose_application']);
      for (const t of seen) assert.deepEqual(Object.keys(t), ['name', 'description', 'input_schema']);
    } finally { await s.close(); }
  });
});

describe('a turn with several tools', () => {
  test('the model answers from the last result; earlier ones stay paired with their calls', async () => {
    const model = scripted([
      call('search_documents', { query: 'youth report' }, 'c1'),
      call('match_grants', { project_id: 1 }, 'c2'),
      (args) => ({ type: 'text', text: `saw ${args.messages.filter((m) => m.role === 'tool').map((m) => m.name).join(',')}` }),
    ]);
    const s = await startServer({ model });
    try {
      const r = await s.chat(Q);
      assert.equal(r.reply, 'saw search_documents,match_grants');
    } finally { await s.close(); }
  });

  test('ok() helper shape', () => assert.deepEqual(ok({ a: 1 }), { outcome: 'ok', result: { a: 1 } }));
});
