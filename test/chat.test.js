// End to end through POST /chat with the fake model: grant answers name grants and reasons,
// document answers name the document, missing facts become questions and the answer is remembered.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

const ask = (community_id, message, conversation_id) =>
  s.chat({ community_id, message, ...(conversation_id ? { conversation_id } : {}) });

describe('grant answers name the grants and the reasons', () => {
  const cases = [
    ['cedar-hollow', 1, ['Youth Futures Fund 2027 [g01]', 'Northern Youth Leadership Exchange [g22]', 'Youth Mental Wellness Initiative [g18]', 'Community Priorities Fund [g16]', 'Capacity Building Micro Grant [g19]'],
      ['Youth Futures Fund 2026 [g02] (closed on 2026-03-31)', 'Active Communities Youth Grant [g03] (south region only', 'Youth Program Startup Grant [g23] (funds planning projects']],
    ['cedar-hollow', 2, ['Elder Housing Accessibility Grant [g05]', 'Capacity Building Micro Grant [g19]'],
      ['Safe Homes Repair Fund [g04] (requires matching funds', 'Rural Housing Innovation 2026 [g06] (closed on 2026-09-30']],
    ['lakeshore', 4, ['Clean Water Capital Program [g07]', 'Community Infrastructure Top Up [g08]', 'Emergency Preparedness Grant [g17]', 'Community Priorities Fund [g16]'],
      ['Capacity Building Micro Grant [g19] (only for communities under 1,000 members but Lakeshore has 2,400)']],
    ['lakeshore', 5, ['Language Keepers Grant [g09]'],
      ['Digital Language Tools [g10] (closed on 2026-08-01)', 'Small Communities Language Fund [g21] (only for communities under 1,000']],
  ];
  for (const [cid, pid, eligible, excluded] of cases) {
    test(`${cid} project ${pid}`, async () => {
      const r = await ask(cid, `Which grants can project ${pid} apply for?`);
      assert.equal(r.proposal, null);
      assert.ok(r.conversation_id);
      const head = r.reply.split('Not eligible:')[0];
      let at = -1;
      for (const name of eligible) {
        const pos = head.indexOf(`${name} (`);
        assert.ok(pos > at, `"${name}" with a reason, in rank order, in: ${r.reply}`);
        at = pos;
      }
      for (const fragment of excluded) assert.ok(r.reply.split('Not eligible:')[1].includes(fragment), `excluded "${fragment}" in: ${r.reply}`);
    });
  }

  test('a completed project: "no open grants", with the reasons', async () => {
    const r = await ask('lakeshore', 'Which grants can project 6 apply for?');
    assert.match(r.reply, /^No open grants fit Youth summer camp 2026 right now\./);
    assert.match(r.reply, /this one is completed/);
  });

  test('a project with no category: the assistant asks, then remembers the answer', async () => {
    const first = await ask('cedar-hollow', 'Which grants can project 3 apply for?');
    assert.match(first.reply, /Project 3 \(Community garden\) has no category recorded/);
    assert.match(first.reply, /food/);

    const second = await ask('cedar-hollow', 'food', first.conversation_id);
    assert.equal(second.conversation_id, first.conversation_id);
    assert.match(second.reply, /^Grants Community garden can apply for: Northern Greenhouse Pilot \[g13\].*Food Sovereignty Fund \[g12\]/);

    // Asked again later in the same conversation: no second question, the category is remembered.
    const third = await ask('cedar-hollow', 'Which grants can project 3 apply for?', first.conversation_id);
    assert.match(third.reply, /^Grants Community garden can apply for/);

    const conversation = await s.deps.store.conversations.get('cedar-hollow', first.conversation_id);
    assert.deepEqual(conversation.facts, { 'project:3:category': 'food' });
    assert.equal(conversation.pending, null);
  });

  test('an answer naming a different category is used and remembered', async () => {
    const first = await ask('cedar-hollow', 'Which grants can project 3 apply for?');
    await ask('cedar-hollow', 'food', first.conversation_id);
    const r = await ask('cedar-hollow', 'Which culture grants can project 3 apply for?', first.conversation_id);
    assert.match(r.reply, /Culture and Heritage Projects \[g14\]/);
    assert.match(r.reply, /Elders in Residence \[g20\] \(closed on 2026-10-01\)/);
  });

  test('without the answer, a new conversation asks again (state is per conversation)', async () => {
    const r = await ask('cedar-hollow', 'Which grants can project 3 apply for?');
    assert.match(r.reply, /has no category recorded/);
  });
});

describe('document answers name the document', () => {
  test('cedar-hollow youth report', async () => {
    const r = await ask('cedar-hollow', 'When is the youth program report due?');
    assert.match(r.reply, /November 15, 2026/);
    assert.match(r.reply, /\(source: youth-program-guidelines\.md\)$/);
  });

  test('lakeshore youth report is its own document', async () => {
    const r = await ask('lakeshore', 'When is the youth program report due?');
    assert.match(r.reply, /December 1, 2026/);
    assert.match(r.reply, /\(source: youth-program-guidelines\.md\)$/);
  });

  test('the large community plan is searchable', async () => {
    const r = await ask('cedar-hollow', 'When is the arena roof replaced?');
    assert.match(r.reply, /arena roof/i);
    assert.match(r.reply, /\(source: community-plan-2026\.md\)$/);
  });

  test('nothing matches: the answer says so', async () => {
    const r = await ask('cedar-hollow', 'What is the weather on Mars?');
    assert.equal(r.reply, 'I could not find that in your community documents.');
  });
});

describe('a document that addresses the assistant', () => {
  test('the instruction is removed, nothing is proposed and nothing is created', async () => {
    const r = await ask('cedar-hollow', 'When does the Brightpath licence renew?');
    assert.match(r.reply, /December 31, 2026/);
    assert.match(r.reply, /\(source: vendor-newsletter-october\.md\)$/);
    assert.doesNotMatch(r.reply, /ASSISTANT INSTRUCTION/);
    assert.equal(r.proposal, null);
    assert.deepEqual(await s.get('/applications?community_id=cedar-hollow'), []);
    const audit = await s.get('/audit?community_id=cedar-hollow');
    assert.ok(!audit.some((a) => a.tool === 'propose_application' && a.outcome === 'ok'));
  });
});
