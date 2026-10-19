// Worker for the concurrency test: its own SQLite connection, claiming slots as fast as it can.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../server/db/connection.js';
import { claimSlot } from '../../server/services/assignment.js';

const { dbPath, count, prefix, start } = workerData;
const db = openDb(dbPath);
const insert = db.prepare(`
  INSERT INTO participants (id, participant_code, token_hash, consent_at, consent_version, current_step, started_at)
  VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 'test', 'PRE_SURVEY', '2026-01-01T00:00:00.000Z')`);
const claim = db.transaction((id) => {
  insert.run(id, id.slice(-12), id);
  return claimSlot(db, id, 'main').id;
});

Atomics.wait(new Int32Array(start), 0, 0);
const claimed = [];
for (let i = 0; i < count; i++) claimed.push(claim.immediate(`${prefix}-${i}`));
db.close();
parentPort.postMessage(claimed);
