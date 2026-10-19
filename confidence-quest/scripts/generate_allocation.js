// Creates the allocation list(s) in the database and prints them. Run once before the study.
// The server also does this automatically on first start; running it by hand lets you set
// and record the seed first, and preview the list.
//
// Usage:
//   ALLOCATION_SEED=my-seed node scripts/generate_allocation.js           create (if missing) and print
//   node scripts/generate_allocation.js --preview --seed X --n 50         print a list without touching the DB
//   node scripts/generate_allocation.js --simulate 1000 --n 50           balance check over many random seeds
import crypto from 'node:crypto';
import { loadConfig } from '../server/config.js';
import { loadContent } from '../server/services/content.js';
import { generateSlots } from '../server/services/assignment.js';
import { bootstrap } from '../server/bootstrap.js';
import { getMeta } from '../server/db/connection.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const config = loadConfig();
const alloc = loadContent(config.contentDir).study.allocation;
const blockSize = Number(value('block-size', alloc.block_size));
const n = Number(value('n', alloc.main_slots));

if (flag('simulate')) {
  const runs = Number(value('simulate', 1000));
  let worst = 0;
  for (let r = 0; r < runs; r++) {
    const slots = generateSlots(crypto.randomBytes(8).toString('hex'), 'main', blockSize, n).slice(0, n);
    const exp = slots.filter((s) => s.arm === 'experimental').length;
    worst = Math.max(worst, Math.abs(n - 2 * exp));
  }
  console.log(`${runs} runs of ${n} participants, block size ${blockSize}: largest arm difference = ${worst}`);
  process.exit(0);
}

if (flag('preview')) {
  const seed = value('seed', config.allocationSeed || 'preview');
  for (const s of generateSlots(seed, 'main', blockSize, n)) console.log(`${s.seq_no}\tblock ${s.block_no}\t${s.arm}`);
  process.exit(0);
}

const { db, warnings } = bootstrap(config);
for (const w of warnings.filter((w) => !w.includes('not approved') && !w.includes('placeholder') && !w.includes('PLACEHOLDER'))) {
  console.warn(`[warning] ${w}`);
}
const rows = db.prepare('SELECT list, seq_no, block_no, arm, claimed_by FROM allocation_slots ORDER BY list, seq_no').all();
console.log(`Seed: ${getMeta(db, 'allocation_seed')} (source: ${getMeta(db, 'allocation_seed_source')})`);
console.log(`Block size: ${getMeta(db, 'allocation_block_size')}`);
for (const list of ['main', 'pilot']) {
  const slots = rows.filter((r) => r.list === list);
  if (!slots.length) continue;
  const claimed = slots.filter((s) => s.claimed_by).length;
  console.log(`\n${list} list: ${slots.length} slots, ${claimed} claimed`);
  console.log(slots.map((s) => (s.arm === 'control' ? 'C' : 'E')).join(''));
}
db.close();
