// Audit: every tool call lands in the log, including refused and failed ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('ok, refused and failed tool calls, and confirmations, are all audited with the public shape', async () => {
  const s = await startServer();
  try {
    const chat = (message) => s.chat({ community_id: 'cedar-hollow', message });
    await chat('Which grants can project 1 apply for?'); // ok
    await chat('When is the youth program report due?'); // ok
    await chat('apply project 1 to grant g02'); // refused: closed
    await chat('Which grants can project 4 apply for?'); // failed: not in this community
    const { proposal } = await chat('apply project 1 to grant g01'); // ok
    await s.call('POST', '/chat', { community_id: 'cedar-hollow', confirm_proposal_id: proposal.id }); // ok
    await s.call('POST', '/chat', { community_id: 'cedar-hollow', confirm_proposal_id: 'prop_nope' }); // failed

    const audit = await s.get('/audit?community_id=cedar-hollow');
    assert.deepEqual(
      audit.map((a) => [a.tool, a.outcome]),
      [
        ['match_grants', 'ok'],
        ['search_documents', 'ok'],
        ['propose_application', 'refused'],
        ['match_grants', 'failed'],
        ['propose_application', 'ok'],
        ['confirm_proposal', 'ok'],
        ['confirm_proposal', 'failed'],
      ],
    );
    for (const entry of audit) {
      assert.deepEqual(Object.keys(entry), ['tool', 'input', 'outcome', 'ms', 'at']);
      assert.equal(typeof entry.input, 'object');
      assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0);
      assert.ok(!Number.isNaN(Date.parse(entry.at)));
    }
    assert.deepEqual(audit[2].input, { project_id: 1, grant_id: 'g02' });
    assert.deepEqual(audit[5].input, { proposal_id: proposal.id });
    // oldest first
    assert.deepEqual([...audit].sort((a, b) => a.at.localeCompare(b.at)).map((a) => a.at), audit.map((a) => a.at));
  } finally { await s.close(); }
});
