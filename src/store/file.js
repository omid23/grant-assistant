// File-backed store: the in-memory store, loaded from disk at startup and written back on every change.
//   STATE_DIR/<community>/state.json    conversations, proposals, applications (rewritten atomically)
//   STATE_DIR/<community>/audit.jsonl   one audit entry per line (append only)
// State survives restarts. It is single-instance: two servers must not share a STATE_DIR
// (see NOTES.md; the next step is a database behind the same interface).
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryStore } from './memory.js';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from, to, attempts = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fs.promises.rename(from, to);
    } catch (e) {
      // Windows can briefly lock a file (antivirus, indexer); retry a few times.
      if (!RETRYABLE.has(e.code) || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 20 * i));
    }
  }
}

function loadCommunity(dir, cid, logger) {
  const stateFile = path.join(dir, cid, 'state.json');
  const auditFile = path.join(dir, cid, 'audit.jsonl');
  const loaded = { conversations: {}, proposals: {}, applications: {}, audit: [] };

  if (fs.existsSync(stateFile)) {
    try {
      Object.assign(loaded, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    } catch (e) {
      // Refuse to start rather than silently overwrite a community's applications.
      throw new Error(`Could not read state file ${stateFile}: ${e.message}. Fix or move it before starting.`);
    }
  }
  if (fs.existsSync(auditFile)) {
    const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter((l) => l.trim());
    lines.forEach((line, i) => {
      try {
        loaded.audit.push(JSON.parse(line));
      } catch {
        // A crash mid-append leaves a partial last line. Losing that one entry beats refusing to start.
        logger.error('audit_line_skipped', { file: auditFile, line: i + 1 });
      }
    });
  }
  return loaded;
}

export function createFileStore({ dir, communityIds, withLock, logger }) {
  const initial = {};
  for (const cid of communityIds) initial[cid] = loadCommunity(dir, cid, logger);

  let store;
  const onChange = (cid, kind, entry) =>
    withLock(`file:${cid}`, async () => {
      const folder = path.join(dir, cid);
      await fs.promises.mkdir(folder, { recursive: true });
      if (kind === 'audit') {
        await fs.promises.appendFile(path.join(folder, 'audit.jsonl'), JSON.stringify(entry) + '\n');
        return;
      }
      const target = path.join(folder, 'state.json');
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(store.snapshot(cid)));
      await renameWithRetry(tmp, target);
    });

  store = createMemoryStore({ onChange, initial });
  return store;
}
