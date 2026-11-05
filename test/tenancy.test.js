// Tenancy: a community only ever sees its own projects, documents, conversations,
// proposals, applications and audit entries.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

describe('projects', () => {
  test("another community's project is not found, with no hint that it exists", async () => {
    const a = await s.chat({ community_id: 'cedar-hollow', message: 'Which grants can project 4 apply for?' });
    assert.equal(a.reply, 'I could not complete that request (Project 4 was not found in Cedar Hollow).');
    const b = await s.chat({ community_id: 'lakeshore', message: 'Which grants can project 1 apply for?' });
    assert.equal(b.reply, 'I could not complete that request (Project 1 was not found in Lakeshore).');
    const missing = await s.chat({ community_id: 'lakeshore', message: 'Which grants can project 99 apply for?' });
    assert.equal(missing.reply, 'I could not complete that request (Project 99 was not found in Lakeshore).');
  });

  test("another community's project cannot be proposed", async () => {
    const r = await s.chat({ community_id: 'cedar-hollow', message: 'apply project 4 to grant g07' });
    assert.equal(r.proposal, null);
    assert.match(r.reply, /Project 4 was not found in Cedar Hollow/);
  });

  test('GET /projects lists only the community\'s own projects', async () => {
    assert.deepEqual((await s.get('/projects?community_id=cedar-hollow')).map((p) => p.id), [1, 2, 3]);
    assert.deepEqual((await s.get('/projects?community_id=lakeshore')).map((p) => p.id), [4, 5, 6]);
  });
});

describe('documents', () => {
  test("a community cannot find another community's documents", async () => {
    const r = await s.chat({ community_id: 'lakeshore', message: 'When does the Brightpath licence renew?' });
    assert.equal(r.reply, 'I could not find that in your community documents.');
    const plan = await s.chat({ community_id: 'lakeshore', message: 'When is the arena roof replaced?' });
    assert.doesNotMatch(plan.reply, /community-plan-2026\.md/);
  });
});

describe('applications and audit', () => {
  test('each community sees only its own', async () => {
    const { proposal } = await s.chat({ community_id: 'lakeshore', message: 'apply project 4 to grant g07' });
    await s.call('POST', '/chat', { community_id: 'lakeshore', confirm_proposal_id: proposal.id });
    assert.deepEqual((await s.get('/applications?community_id=lakeshore')).map((a) => a.project_id), [4]);
    assert.deepEqual(await s.get('/applications?community_id=cedar-hollow'), []);

    const cedarAudit = await s.get('/audit?community_id=cedar-hollow');
    const lakeAudit = await s.get('/audit?community_id=lakeshore');
    assert.ok(cedarAudit.length > 0 && lakeAudit.length > 0);
    assert.ok(!cedarAudit.some((a) => a.input.project_id >= 4 && a.tool === 'propose_application' && a.outcome === 'ok'));
    assert.ok(lakeAudit.some((a) => a.tool === 'confirm_proposal'));
    assert.ok(!cedarAudit.some((a) => a.tool === 'confirm_proposal'));
  });
});

describe('conversations', () => {
  test('the same conversation id in two communities is two separate conversations', async () => {
    const id = 'shared-conversation-id';
    const cedar = await s.chat({ community_id: 'cedar-hollow', message: 'Which grants can project 3 apply for?', conversation_id: id });
    assert.match(cedar.reply, /has no category recorded/);
    // Lakeshore's conversation with the same id has never heard that question.
    const lake = await s.chat({ community_id: 'lakeshore', message: 'food', conversation_id: id });
    assert.doesNotMatch(lake.reply, /Community garden/);
    assert.equal((await s.deps.store.conversations.get('lakeshore', id)).pending, null);
    // Cedar Hollow's is still waiting, and still answers.
    assert.equal((await s.deps.store.conversations.get('cedar-hollow', id)).pending.project_id, 3);
    assert.match((await s.chat({ community_id: 'cedar-hollow', message: 'food', conversation_id: id })).reply, /^Grants Community garden/);
  });
});
