#!/usr/bin/env node
// Seeds the "Beats %" histograms: stats/S1, stats/S2, stats/pilot_S1, stats/pilot_S2,
// each { counts: number[9] } where counts[k] = participants who scored k on that set.
//
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/seed-stats.mjs <mode> [--force]
//
// Modes:
//   --zeros        create all four documents with zeros (skips documents that already exist)
//   --from-pilot   set stats/S1 and stats/S2 from the block scores of completed, non-withdrawn
//                  pilot participants (run after piloting, before real data collection)
//   --show         print the current documents and change nothing
//
// --force overwrites documents that already hold counts. Do not overwrite the real stats
// once data collection has started: every participant's "Beats %" depends on them.

import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const config = JSON.parse(readFileSync(new URL('../src/content/config.json', import.meta.url), 'utf8'));
const SIZE = config.questionsPerBlock + 1;
const prefix = config.pilotPrefix;

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON (see README).');
  process.exit(1);
}
const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || undefined;
initializeApp(process.env.FIRESTORE_EMULATOR_HOST ? { projectId: projectId || 'demo-dsa' } : { credential: applicationDefault(), projectId });
const db = getFirestore();

const ids = ['S1', 'S2', `${prefix}S1`, `${prefix}S2`];

async function show() {
  for (const id of ids) {
    const snap = await db.doc(`stats/${id}`).get();
    console.log(`stats/${id}:`, snap.exists ? JSON.stringify(snap.data().counts) : '(missing)');
  }
}

async function put(id, counts) {
  const ref = db.doc(`stats/${id}`);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data().counts || [] : [];
  if (existing.some((c) => c > 0) && !has('--force')) {
    console.log(`stats/${id}: already has counts ${JSON.stringify(existing)}; skipped (use --force to overwrite)`);
    return;
  }
  if (snap.exists && !has('--force') && counts.every((c) => c === 0)) {
    console.log(`stats/${id}: exists; skipped`);
    return;
  }
  await ref.set({ counts });
  console.log(`stats/${id} ← ${JSON.stringify(counts)}`);
}

if (has('--show')) {
  await show();
} else if (has('--zeros')) {
  for (const id of ids) await put(id, Array(SIZE).fill(0));
} else if (has('--from-pilot')) {
  const snap = await db.collection('participants').where('pilot', '==', true).get();
  const counts = { S1: Array(SIZE).fill(0), S2: Array(SIZE).fill(0) };
  let used = 0;
  for (const doc of snap.docs) {
    const p = doc.data();
    if (p.status !== 'completed' || p.withdrawn || p.debug) continue;
    used++;
    for (const b of [p.block1, p.block2]) {
      if (!b?.answers?.length) continue;
      const score = b.answers.filter((a) => a.correct).length;
      counts[b.setId][score] += 1;
    }
  }
  console.log(`Using ${used} completed pilot participants (debug sessions excluded).`);
  await put('S1', counts.S1);
  await put('S2', counts.S2);
} else {
  console.log('Usage: node scripts/seed-stats.mjs --zeros | --from-pilot | --show [--force]');
  process.exit(1);
}
