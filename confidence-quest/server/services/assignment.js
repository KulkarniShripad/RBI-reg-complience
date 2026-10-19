import crypto from 'node:crypto';
import { getMeta, setMeta } from '../db/connection.js';
import { nowIso } from '../util.js';

export const ARMS = ['control', 'experimental'];

// sfc32 seeded from sha256(seed|list|block), so every block of the list can be
// regenerated from the seed alone and the list can be extended reproducibly.
function blockRandom(seed, list, blockNo) {
  const h = crypto.createHash('sha256').update(`${seed}|${list}|${blockNo}`).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// One permuted block: half control, half experimental, shuffled with Fisher-Yates.
export function generateBlock(seed, list, blockNo, blockSize) {
  if (!Number.isInteger(blockSize) || blockSize < 2 || blockSize % 2 !== 0) {
    throw new Error('block_size must be an even number of at least 2');
  }
  const arms = Array.from({ length: blockSize }, (_, i) => (i < blockSize / 2 ? 'control' : 'experimental'));
  const rand = blockRandom(seed, list, blockNo);
  for (let i = arms.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arms[i], arms[j]] = [arms[j], arms[i]];
  }
  return arms;
}

// At least `count` slots, rounded up to whole blocks.
export function generateSlots(seed, list, blockSize, count, firstBlock = 1, firstSeq = 1) {
  const slots = [];
  let blockNo = firstBlock;
  let seqNo = firstSeq;
  while (slots.length < count) {
    for (const arm of generateBlock(seed, list, blockNo, blockSize)) slots.push({ list, seq_no: seqNo++, block_no: blockNo, arm });
    blockNo++;
  }
  return slots;
}

export function listFor(isPilot, allocationConfig) {
  return isPilot && allocationConfig.separate_pilot_list ? 'pilot' : 'main';
}

function insertSlots(db, slots) {
  const insert = db.prepare('INSERT INTO allocation_slots (list, seq_no, block_no, arm) VALUES (@list, @seq_no, @block_no, @arm)');
  for (const slot of slots) insert.run(slot);
}

// Creates the allocation lists on first start. The seed and block size are stored in meta
// and win over later config changes, because slots may already have been claimed.
export function ensureAllocation(db, allocationConfig, envSeed) {
  const warnings = [];
  db.transaction(() => {
    let seed = getMeta(db, 'allocation_seed');
    if (!seed) {
      seed = envSeed || crypto.randomBytes(16).toString('hex');
      setMeta(db, 'allocation_seed', seed);
      setMeta(db, 'allocation_seed_source', envSeed ? 'ALLOCATION_SEED' : 'random');
    } else if (envSeed && envSeed !== seed) {
      warnings.push('ALLOCATION_SEED differs from the seed stored in the database; the stored seed is kept.');
    }
    let blockSize = Number(getMeta(db, 'allocation_block_size'));
    if (!blockSize) {
      blockSize = allocationConfig.block_size;
      setMeta(db, 'allocation_block_size', blockSize);
    } else if (blockSize !== allocationConfig.block_size) {
      warnings.push(`study.json block_size is ${allocationConfig.block_size} but the stored list uses ${blockSize}; the stored list is kept.`);
    }
    const lists = allocationConfig.separate_pilot_list ? ['main', 'pilot'] : ['main'];
    for (const list of lists) {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM allocation_slots WHERE list = ?').get(list).n;
      if (existing === 0) {
        const count = list === 'main' ? allocationConfig.main_slots : allocationConfig.pilot_slots;
        insertSlots(db, generateSlots(seed, list, blockSize, count));
      }
    }
  }).immediate();
  return warnings;
}

// Adds one more block when a list runs out. Abandoned slots are never reused.
function extendList(db, list) {
  const seed = getMeta(db, 'allocation_seed');
  const blockSize = Number(getMeta(db, 'allocation_block_size'));
  const last = db.prepare('SELECT MAX(block_no) AS block, MAX(seq_no) AS seq FROM allocation_slots WHERE list = ?').get(list);
  insertSlots(db, generateSlots(seed, list, blockSize, blockSize, (last.block ?? 0) + 1, (last.seq ?? 0) + 1));
  db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (NULL, ?, ?, ?)').run(
    'allocation_extended',
    JSON.stringify({ list, block_no: (last.block ?? 0) + 1 }),
    nowIso(),
  );
}

// Must run inside an IMMEDIATE transaction so two requests can never take the same slot.
export function claimSlot(db, participantId, list) {
  const next = db.prepare(
    'SELECT id, arm, seq_no FROM allocation_slots WHERE list = ? AND claimed_by IS NULL ORDER BY seq_no LIMIT 1',
  );
  let slot = next.get(list);
  if (!slot) {
    extendList(db, list);
    slot = next.get(list);
  }
  const claimed = db
    .prepare('UPDATE allocation_slots SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL')
    .run(participantId, nowIso(), slot.id);
  if (claimed.changes !== 1) throw new Error(`allocation slot ${slot.id} was already claimed`);
  return slot;
}
