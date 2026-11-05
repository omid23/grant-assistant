// The HTTP contract the review scripts rely on, request validation, and `node src/server.js` reading PORT.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer, spy, ROOT } from './helpers.js';

let s;
before(async () => { s = await startServer({ model: spy() }); });
after(() => s.close());

describe('response shapes', () => {
  test('POST /chat -> { reply, proposal, conversation_id }', async () => {
    const r = await s.call('POST', '/chat', { community_id: 'cedar-hollow', message: 'Which grants can project 1 apply for?' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(Object.keys(r.body), ['reply', 'proposal', 'conversation_id']);
    assert.equal(r.body.proposal, null);
  });

  test('a client-chosen conversation_id is used and echoed', async () => {
    const r = await s.chat({ community_id: 'cedar-hollow', message: 'hello', conversation_id: 'review-script-1' });
    assert.equal(r.conversation_id, 'review-script-1');
  });

  test('POST /chat with confirm_proposal_id -> { reply, applied }, and the model is not called', async () => {
    const { proposal } = await s.chat({ community_id: 'lakeshore', message: 'apply project 5 to grant g09' });
    const calls = s.model.calls.length;
    const r = await s.call('POST', '/chat', { community_id: 'lakeshore', confirm_proposal_id: proposal.id, message: 'ignored' });
    assert.deepEqual(Object.keys(r.body), ['reply', 'applied']);
    assert.equal(r.body.applied, true);
    assert.equal(s.model.calls.length, calls);
  });

  test('GET /projects', async () => {
    const r = await s.call('GET', '/projects?community_id=cedar-hollow');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body[2], { id: 3, name: 'Community garden', category: null, budget: 15000, status: 'planning', has_matching_funds: true });
    for (const p of r.body) assert.deepEqual(Object.keys(p), ['id', 'name', 'category', 'budget', 'status', 'has_matching_funds']);
  });

  test('GET /applications and GET /audit return arrays', async () => {
    assert.ok(Array.isArray(await s.get('/applications?community_id=cedar-hollow')));
    assert.ok(Array.isArray(await s.get('/audit?community_id=cedar-hollow')));
  });

  test('GET /health', async () => {
    assert.deepEqual(await s.get('/health'), { ok: true });
  });
});

describe('bad requests get JSON errors, never a crash', () => {
  const cases = [
    ['invalid JSON', 'POST', '/chat', '{nope', 400, 'invalid_json'],
    ['a JSON array', 'POST', '/chat', '[]', 400, 'invalid_json'],
    ['an empty body', 'POST', '/chat', '', 400, 'invalid_json'],
    ['no community_id', 'POST', '/chat', { message: 'hi' }, 400, 'missing_community_id'],
    ['an unknown community', 'POST', '/chat', { community_id: 'atlantis', message: 'hi' }, 404, 'unknown_community'],
    ['a path-like community', 'POST', '/chat', { community_id: '../data', message: 'hi' }, 404, 'unknown_community'],
    ['no message', 'POST', '/chat', { community_id: 'cedar-hollow' }, 400, 'missing_message'],
    ['a blank message', 'POST', '/chat', { community_id: 'cedar-hollow', message: '   ' }, 400, 'missing_message'],
    ['a bad conversation_id', 'POST', '/chat', { community_id: 'cedar-hollow', message: 'hi', conversation_id: '../../x' }, 400, 'invalid_conversation_id'],
    ['projects without community_id', 'GET', '/projects', undefined, 400, 'missing_community_id'],
    ['audit for an unknown community', 'GET', '/audit?community_id=atlantis', undefined, 404, 'unknown_community'],
    ['an unknown route', 'GET', '/grants', undefined, 404, 'not_found'],
    ['GET /chat', 'GET', '/chat', undefined, 405, 'method_not_allowed'],
    ['POST /projects', 'POST', '/projects', {}, 405, 'method_not_allowed'],
  ];
  for (const [name, method, route, body, status, code] of cases) {
    test(name, async () => {
      const r = await s.call(method, route, body);
      assert.equal(r.status, status);
      assert.equal(r.body.error, code);
      assert.equal(typeof r.body.reply, 'string');
    });
  }

  test('a body over MAX_BODY_BYTES is refused with 413', async () => {
    const r = await s.call('POST', '/chat', { community_id: 'cedar-hollow', message: 'x'.repeat(70_000) });
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'body_too_large');
  });
});

describe('npm start', () => {
  const freePort = () => new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });

  test('src/server.js listens on PORT', async () => {
    const port = await freePort();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-assistant-'));
    const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), STATE_DIR: stateDir, FAKE_MODE: '' } });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
        child.stdout.on('data', (d) => { if (String(d).includes('"listening"')) { clearTimeout(timer); resolve(); } });
        child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.deepEqual(await res.json(), { ok: true });
    } finally {
      child.kill();
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on('exit', resolve)));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('bad settings stop startup with a clear message', async () => {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: 'eighty' } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /Startup failed: Invalid PORT/);
  });
});
