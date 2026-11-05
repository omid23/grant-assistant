// The confirm gate: proposals never create applications; only a later request naming the
// proposal id does, once, and only while the grant is still open to the project.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { createClock } from '../src/clock.js';

const propose = (s, message, community_id = 'cedar-hollow', conversation_id) =>
  s.chat({ community_id, message, ...(conversation_id ? { conversation_id } : {}) });
const confirm = (s, id, community_id = 'cedar-hollow') => s.call('POST', '/chat', { community_id, confirm_proposal_id: id });
const apps = (s, cid = 'cedar-hollow') => s.get(`/applications?community_id=${cid}`);

describe('propose, then confirm', () => {
  test('a proposal is returned and nothing is created yet', async () => {
    const s = await startServer();
    try {
      const r = await propose(s, 'Can we apply for project 1 with grant g01?');
      assert.match(r.proposal.id, /^prop_/);
      assert.match(r.proposal.summary, /Youth Leadership Program \(project 1, budget \$48,000\) to Youth Futures Fund 2027 \[g01\]/);
      assert.match(r.proposal.summary, /not submitted to the funder/);
      assert.match(r.reply, /^I have prepared this for you to confirm/);
      assert.deepEqual(await apps(s), []);
    } finally { await s.close(); }
  });

  test('confirming creates exactly one application, pending review', async () => {
    const s = await startServer();
    try {
      const { proposal } = await propose(s, 'apply project 1 to grant g01');
      const r = await confirm(s, proposal.id);
      assert.equal(r.status, 200);
      assert.equal(r.body.applied, true);
      assert.match(r.body.reply, /recorded as pending review\. It has not been submitted to the funder/);
      const list = await apps(s);
      assert.equal(list.length, 1);
      assert.deepEqual(Object.keys(list[0]), ['id', 'project_id', 'grant_id', 'status', 'created_at']);
      assert.deepEqual([list[0].project_id, list[0].grant_id, list[0].status], [1, 'g01', 'pending_review']);
    } finally { await s.close(); }
  });

  test('confirming twice, one after the other, still makes one application', async () => {
    const s = await startServer();
    try {
      const { proposal } = await propose(s, 'apply project 1 to grant g01');
      assert.equal((await confirm(s, proposal.id)).body.applied, true);
      const again = await confirm(s, proposal.id);
      assert.equal(again.body.applied, true);
      assert.match(again.body.reply, /already confirmed/);
      assert.equal((await apps(s)).length, 1);
    } finally { await s.close(); }
  });

  test('confirming twice at the same moment still makes one application', async () => {
    const s = await startServer();
    try {
      const { proposal } = await propose(s, 'apply project 1 to grant g01');
      const results = await Promise.all([confirm(s, proposal.id), confirm(s, proposal.id), confirm(s, proposal.id)]);
      assert.ok(results.every((r) => r.body.applied === true));
      assert.equal((await apps(s)).length, 1);
    } finally { await s.close(); }
  });

  test('proposing the same thing again returns the same proposal; after applying, it is refused', async () => {
    const s = await startServer();
    try {
      const a = await propose(s, 'apply project 1 to grant g01');
      const b = await propose(s, 'apply project 1 to grant g01');
      assert.equal(a.proposal.id, b.proposal.id);
      await confirm(s, a.proposal.id);
      const c = await propose(s, 'apply project 1 to grant g01');
      assert.equal(c.proposal, null);
      assert.match(c.reply, /has already applied to Youth Futures Fund 2027 \[g01\] \(app_/);
    } finally { await s.close(); }
  });
});

describe('what cannot be confirmed', () => {
  test('an unknown proposal id', async () => {
    const s = await startServer();
    try {
      const r = await confirm(s, 'prop_does-not-exist');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { reply: 'I could not find that proposal.', applied: false });
      assert.deepEqual(await apps(s), []);
    } finally { await s.close(); }
  });

  test("another community's proposal looks exactly like an unknown one, and nothing is created", async () => {
    const s = await startServer();
    try {
      const { proposal } = await propose(s, 'apply project 4 to grant g07', 'lakeshore');
      const r = await confirm(s, proposal.id, 'cedar-hollow');
      assert.deepEqual(r.body, { reply: 'I could not find that proposal.', applied: false });
      assert.deepEqual(await apps(s, 'cedar-hollow'), []);
      assert.deepEqual(await apps(s, 'lakeshore'), []);
      assert.equal((await s.deps.store.proposals.get('lakeshore', proposal.id)).status, 'pending');
    } finally { await s.close(); }
  });

  test('a proposal whose grant closed before confirmation is refused and marked stale', async () => {
    const clock = createClock({ today: '2026-11-05' });
    const s = await startServer({ clock });
    try {
      const { proposal } = await propose(s, 'apply project 1 to grant g01');
      clock.set('2027-02-01'); // g01 closed on 2027-01-31
      const r = await confirm(s, proposal.id);
      assert.equal(r.body.applied, false);
      assert.match(r.body.reply, /can no longer apply to Youth Futures Fund 2027 \[g01\]: closed on 2027-01-31\. Nothing was created/);
      assert.deepEqual(await apps(s), []);
      assert.equal((await s.deps.store.proposals.get('cedar-hollow', proposal.id)).status, 'stale');
      assert.equal((await confirm(s, proposal.id)).body.applied, false);
    } finally { await s.close(); }
  });

  test('a category given in conversation carries through to confirmation', async () => {
    const s = await startServer();
    try {
      const q = await propose(s, 'Which grants can project 3 apply for?');
      await propose(s, 'food', 'cedar-hollow', q.conversation_id);
      const p = await propose(s, 'apply project 3 to grant g12', 'cedar-hollow', q.conversation_id);
      assert.match(p.proposal.id, /^prop_/);
      const r = await confirm(s, p.proposal.id);
      assert.equal(r.body.applied, true);
      assert.deepEqual((await apps(s)).map((a) => [a.project_id, a.grant_id]), [[3, 'g12']]);
    } finally { await s.close(); }
  });

  test('a project with no category cannot be proposed to an area grant until the user says which area', async () => {
    const s = await startServer();
    try {
      const r = await propose(s, 'apply project 3 to grant g12');
      assert.equal(r.proposal, null);
      assert.match(r.reply, /has no category recorded/);
    } finally { await s.close(); }
  });
});

describe('ineligible grants cannot be proposed', () => {
  const cases = [
    ['cedar-hollow', 1, 'g02', /closed on 2026-03-31/],
    ['cedar-hollow', 1, 'g04', /a housing grant but this project is youth/],
    ['cedar-hollow', 2, 'g04', /requires matching funds but this project has none/],
    ['lakeshore', 6, 'g01', /this one is completed/],
    ['lakeshore', 5, 'g21', /under 1,000 members but Lakeshore has 2,400/],
  ];
  for (const [cid, pid, gid, why] of cases) {
    test(`${cid} project ${pid} -> ${gid}`, async () => {
      const s = await startServer();
      try {
        const r = await propose(s, `apply project ${pid} to grant ${gid}`, cid);
        assert.equal(r.proposal, null);
        assert.match(r.reply, /cannot be proposed for/);
        assert.match(r.reply, why);
        const audit = await s.get(`/audit?community_id=${cid}`);
        assert.deepEqual(audit.map((a) => [a.tool, a.outcome]), [['propose_application', 'refused']]);
        assert.equal(await s.deps.store.proposals.findPending(cid, pid, gid), null);
      } finally { await s.close(); }
    });
  }

  test('an unknown grant id fails cleanly', async () => {
    const s = await startServer();
    try {
      const r = await propose(s, 'apply project 1 to grant g99');
      assert.match(r.reply, /Grant g99 is not in the catalogue/);
      assert.equal((await s.get('/audit?community_id=cedar-hollow'))[0].outcome, 'failed');
    } finally { await s.close(); }
  });
});
