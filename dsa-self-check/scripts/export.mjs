#!/usr/bin/env node
// Exports participants/* to three CSV files in ./export/.
//
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/export.mjs [flags]
//
// Flags:
//   --include-withdrawn   keep participants who pressed "Withdraw my data" (excluded by default)
//   --pilot               export only pilot data (?pilot=1 and ?debug=1 sessions); excluded by default
//   --out <dir>           output folder (default ./export)
//
// Writes participants.csv (one row per participant, nested fields as dot-names),
// answers.csv (one row per answer) and feedback.csv (one row per feedback screen).
// Never commit the service-account file: it is listed in .gitignore.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const includeWithdrawn = flag('--include-withdrawn');
const pilotOnly = flag('--pilot');
const outDir = resolve(opt('--out', './export'));

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON (see README → Exporting the data).');
  process.exit(1);
}

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || undefined;
initializeApp(process.env.FIRESTORE_EMULATOR_HOST ? { projectId: projectId || 'demo-dsa' } : { credential: applicationDefault(), projectId });
const db = getFirestore();

// ---------- helpers ----------

const toCell = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== 'object') ? v.join('|') : JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const escape = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function writeCsv(file, columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => escape(toCell(r[c]))).join(','));
  // BOM so Excel opens the ✔ / △ / ✘ symbols correctly.
  writeFileSync(join(outDir, file), '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  console.log(`  ${file}: ${rows.length} rows`);
}

// Answers and the block plan go to answers.csv instead of being flattened here.
const SKIP = new Set(['block1.answers', 'block2.answers', 'block1.plan', 'block2.plan']);

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (SKIP.has(key)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof Date)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

// Column order follows the data model; anything else goes after, alphabetically.
const ORDER = [
  'uid', 'status', 'withdrawn', 'pilot', 'debug', 'createdAt', 'updatedAt', 'completedAt', 'withdrawnAt',
  'appVersion', 'contentVersion', 'device', 'currentStep', 'currentStepName', 'blockOrder', 'group', 'stratum',
  'profile', 'ratingStart', 'ratingMid', 'ratingEnd', 'statements', 'rankGuessStart', 'scoreGuessStart',
  'block1', 'block2', 'feedback1', 'feedback2', 'endItems', 'endItemsOrder', 'attentionPassed', 'packTopic',
  'packType', 'close', 'preference', 'derived', 'lang', 'rev',
];
const rank = (col) => {
  const i = ORDER.indexOf(col.split('.')[0]);
  return i < 0 ? ORDER.length : i;
};

// ---------- export ----------

const snap = await db.collection('participants').get();
const all = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
const kept = all.filter((p) => (pilotOnly ? p.pilot === true : p.pilot !== true) && (includeWithdrawn || p.withdrawn !== true));
console.log(
  `${all.length} participants in Firestore → exporting ${kept.length} ` +
    `(${pilotOnly ? 'pilot only' : 'pilot excluded'}, ${includeWithdrawn ? 'withdrawn kept' : 'withdrawn excluded'})`,
);

mkdirSync(outDir, { recursive: true });

const flat = kept.map((p) => flatten(p));
const seen = new Set();
for (const row of flat) for (const k of Object.keys(row)) seen.add(k);
// A section that is still null for a drop-out (e.g. ratingMid) would add an empty "ratingMid"
// column next to "ratingMid.arrays" …; drop such parents when they are empty in every row.
const cols = [...seen]
  .filter((c) => !([...seen].some((o) => o.startsWith(c + '.')) && flat.every((r) => r[c] == null)))
  .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
writeCsv('participants.csv', cols, flat);

// feedbackMs / feedbackShown are filled only in blocks with per-question feedback (config.questionFeedbackBlocks).
const answerCols = ['uid', 'group', 'blockOrder', 'block', 'setId', 'position', 'qid', 'topic', 'type', 'chosen', 'correct', 'confidence', 'timeMs', 'langAtAnswer', 'langSwitches', 'feedbackMs', 'feedbackShown'];
const answers = [];
for (const p of kept) {
  for (const block of [1, 2]) {
    const b = p[`block${block}`];
    if (!b) continue;
    for (const a of b.answers || []) answers.push({ uid: p.uid, group: p.group, blockOrder: p.blockOrder, block, setId: b.setId, ...a });
  }
}
writeCsv('answers.csv', answerCols, answers);

const feedbackCols = ['uid', 'group', 'block', 'blockScore', 'beatsPct', 'strongTopic', 'strongType', 'workOnTopic', 'workOnType', 'tip', 'timeOnScreenMs'];
const feedback = [];
for (const p of kept) {
  for (const block of [1, 2]) {
    const f = p[`feedback${block}`];
    if (!f) continue;
    feedback.push({
      uid: p.uid,
      group: p.group,
      block,
      blockScore: f.blockScore,
      beatsPct: f.beatsPct,
      strongTopic: f.strong?.topic,
      strongType: f.strong?.type,
      workOnTopic: f.workOn?.topic,
      workOnType: f.workOn?.type,
      tip: f.tip,
      timeOnScreenMs: f.timeOnScreenMs,
    });
  }
}
writeCsv('feedback.csv', feedbackCols, feedback);
console.log(`Done → ${outDir}`);
