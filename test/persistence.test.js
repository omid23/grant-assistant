// State on disk survives a restart: the question being waited on, remembered facts,
// proposals, applications and the audit log.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fake from '../model/fake.js';
import { startServer } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { silentLogger } from '../src/log.js';

const made = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-assistant-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

describe('file store', () => {
  test('a restart in the middle of a question does not lose it', async () => {
    const dir = tempDir();
    const first = await startServer({ storeDriver: 'file', stateDir: dir });
    const q = await first.chat({ community_id: 'cedar-hollow', message: 'Which grants can project 3 apply for?' });
    assert.match(q.reply, /has no category recorded/);
    await first.close();

    const second = await startServer({ storeDriver: 'file', stateDir: dir });
    const a = await second.chat({ community_id: 'cedar-hollow', message: 'food', conversation_id: q.conversation_id });
    assert.match(a.reply, /^Grants Community garden can apply for/);
    const p = await second.chat({ community_id: 'cedar-hollow', message: 'apply project 3 to grant g12', conversation_id: q.conversation_id });
    await second.close();

    // The proposal made before this restart can be confirmed after it.
    const third = await startServer({ storeDriver: 'file', stateDir: dir });
    const c = await third.call('POST', '/chat', { community_id: 'cedar-hollow', confirm_proposal_id: p.proposal.id });
    assert.equal(c.body.applied, true);
    await third.close();

    const fourth = await startServer({ storeDriver: 'file', stateDir: dir });
    try {
      assert.deepEqual((await fourth.get('/applications?community_id=cedar-hollow')).map((x) => x.grant_id), ['g12']);
      assert.deepEqual(
        (await fourth.get('/audit?community_id=cedar-hollow')).map((x) => x.tool),
        ['match_grants', 'match_grants', 'propose_application', 'confirm_proposal'],
      );
      assert.ok(fs.existsSync(path.join(dir, 'cedar-hollow', 'state.json')));
      assert.ok(!fs.existsSync(path.join(dir, 'lakeshore', 'state.json')), 'each community has its own files');
    } finally { await fourth.close(); }
  });

  test('a half-written last audit line is skipped, not fatal', async () => {
    const dir = tempDir();
    const s = await startServer({ storeDriver: 'file', stateDir: dir });
    await s.chat({ community_id: 'lakeshore', message: 'Which grants can project 4 apply for?' });
    await s.close();
    fs.appendFileSync(path.join(dir, 'lakeshore', 'audit.jsonl'), '{"tool":"match_gr');

    const again = await startServer({ storeDriver: 'file', stateDir: dir });
    try {
      assert.deepEqual((await again.get('/audit?community_id=lakeshore')).map((x) => x.tool), ['match_grants']);
    } finally { await again.close(); }
  });

  test('a corrupt state file stops startup with its path, instead of being overwritten', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'cedar-hollow'));
    fs.writeFileSync(path.join(dir, 'cedar-hollow', 'state.json'), '{not json');
    const config = loadConfig({ STATE_DIR: dir, LOG_LEVEL: 'silent' }, { modelContextChars: fake.CONTEXT_CHARS });
    assert.throws(() => createApp({ model: fake, config, logger: silentLogger }), /Could not read state file .*state\.json/);
    assert.equal(fs.readFileSync(path.join(dir, 'cedar-hollow', 'state.json'), 'utf8'), '{not json');
  });
});
