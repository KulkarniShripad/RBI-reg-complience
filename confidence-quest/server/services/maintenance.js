import fs from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta } from '../db/connection.js';
import { STEPS } from './stateMachine.js';
import { nowIso } from '../util.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Online backup (consistent even while participants are answering).
export async function backupDatabase(db, backupDir, label = 'manual') {
  fs.mkdirSync(backupDir, { recursive: true });
  const file = path.join(backupDir, `app-${stamp()}-${label.replace(/[^a-z0-9_-]/gi, '')}.sqlite`);
  await db.backup(file);
  db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (NULL, ?, ?, ?)').run(
    'backup_taken',
    JSON.stringify({ file: path.basename(file) }),
    nowIso(),
  );
  return file;
}

// Records the hash of every content file and logs when one changes between starts.
export function recordContentHashes(db, content) {
  const changed = [];
  db.transaction(() => {
    for (const [file, hash] of Object.entries(content.hashes)) {
      const key = `content_hash:${file}`;
      const previous = getMeta(db, key);
      if (previous !== hash) {
        if (previous) changed.push(file);
        setMeta(db, key, hash);
      }
    }
    if (changed.length) {
      db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (NULL, ?, ?, ?)').run(
        'content_changed',
        JSON.stringify({ files: changed }),
        nowIso(),
      );
    }
  })();
  return changed;
}

export function ensureStudyMode(db, initialMode) {
  if (!getMeta(db, 'study_mode')) setMeta(db, 'study_mode', initialMode);
}

function summarise(rows) {
  const out = { total: rows.length, by_status: {}, by_step: {}, by_arm: {} };
  for (const step of STEPS) out.by_step[step] = 0;
  for (const arm of ['control', 'experimental', 'unassigned']) {
    out.by_arm[arm] = { total: 0, in_progress: 0, completed: 0, abandoned: 0, withdrawn: 0 };
  }
  for (const row of rows) {
    out.by_status[row.status] = (out.by_status[row.status] ?? 0) + 1;
    if (row.status === 'in_progress') out.by_step[row.current_step] = (out.by_step[row.current_step] ?? 0) + 1;
    const arm = out.by_arm[row.arm ?? 'unassigned'];
    arm.total++;
    arm[row.status]++;
  }
  return out;
}

export function studyStatus(db, content, startedAt) {
  const participants = db.prepare('SELECT is_pilot, arm, status, current_step FROM participants').all();
  const slots = db
    .prepare('SELECT list, COUNT(*) AS total, COUNT(claimed_by) AS claimed FROM allocation_slots GROUP BY list')
    .all();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return {
    now_utc: nowIso(),
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    study_mode: getMeta(db, 'study_mode'),
    live: summarise(participants.filter((p) => p.is_pilot === 0)),
    pilot: summarise(participants.filter((p) => p.is_pilot === 1)),
    allocation: {
      seed_source: getMeta(db, 'allocation_seed_source'),
      block_size: Number(getMeta(db, 'allocation_block_size')),
      lists: Object.fromEntries(slots.map((s) => [s.list, { total: s.total, claimed: s.claimed, remaining: s.total - s.claimed }])),
    },
    errors_last_hour: db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'error' AND created_at >= ?")
      .get(hourAgo).n,
    recent_errors: db
      .prepare("SELECT payload, created_at FROM events WHERE event_type = 'error' ORDER BY id DESC LIMIT 10")
      .all()
      .map((e) => ({ ...JSON.parse(e.payload), at: e.created_at })),
    content: {
      questions_version: content.questionsVersion,
      warnings: content.warnings,
      sha256: Object.fromEntries(Object.entries(content.hashes).map(([f, h]) => [f, h.slice(0, 12)])),
    },
  };
}

function deleteParticipantData(db, ids) {
  for (const table of ['survey_responses', 'question_responses', 'gamification_events', 'events']) {
    const stmt = db.prepare(`DELETE FROM ${table} WHERE participant_id = ?`);
    for (const id of ids) stmt.run(id);
  }
}

// Removes all pilot/rehearsal rows and resets the pilot allocation list.
export function purgePilotData(db) {
  return db
    .transaction(() => {
      const ids = db.prepare('SELECT id FROM participants WHERE is_pilot = 1').all().map((r) => r.id);
      // The events table is append-only for updates, but deleting a pilot's rows is allowed.
      deleteParticipantData(db, ids);
      // Slots and participants point at each other: unlink, delete the people, then the pilot list.
      // (With a shared list, pilots' main-list slots become free again.)
      db.prepare('UPDATE allocation_slots SET claimed_by = NULL, claimed_at = NULL WHERE claimed_by IN (SELECT id FROM participants WHERE is_pilot = 1)').run();
      const removed = db.prepare('DELETE FROM participants WHERE is_pilot = 1').run().changes;
      db.prepare("DELETE FROM allocation_slots WHERE list = 'pilot'").run();
      db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (NULL, ?, ?, ?)').run(
        'pilot_data_purged',
        JSON.stringify({ participants: removed }),
        nowIso(),
      );
      return removed;
    })
    .immediate();
}

// A participant asked (with their code) for their answers to be removed. The row and its
// allocation slot stay so the allocation sequence is unchanged; everything they answered goes.
export function withdrawParticipantData(db, participantCode) {
  return db
    .transaction(() => {
      const p = db.prepare('SELECT id, status FROM participants WHERE participant_code = ?').get(participantCode);
      if (!p) return false;
      deleteParticipantData(db, [p.id]);
      db.prepare(`UPDATE participants SET status = 'withdrawn', leaderboard_name = NULL WHERE id = ?`).run(p.id);
      db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)').run(
        p.id,
        'data_withdrawn',
        null,
        nowIso(),
      );
      return true;
    })
    .immediate();
}
