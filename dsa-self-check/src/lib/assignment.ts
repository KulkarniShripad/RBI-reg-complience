// Balanced assignment rules (section 7). Pure functions: the stores run them
// inside a transaction against the stored counter document.

import type { BlockOrder, GapLabel, Group } from './model';
import type { ConfigFile, SetId } from '../content/types';
import type { Rng } from './util';

export interface BlockOrderCounter {
  n: number;
  last: BlockOrder | null;
}

export interface GroupCounter {
  n: number;
  last: Group | null;
  countA: number;
  countB: number;
}

const flipOrder = (o: BlockOrder): BlockOrder => (o === '12' ? '21' : '12');
const flipGroup = (g: Group): Group => (g === 'A' ? 'B' : 'A');

/** Even n: draw at random and remember it. Odd n: the opposite of the last draw. Then n++. */
export function nextBlockOrder(
  counter: Partial<BlockOrderCounter> | undefined,
  rng: Rng,
): { value: BlockOrder; counter: BlockOrderCounter } {
  const n = counter?.n ?? 0;
  let last = counter?.last ?? null;
  let value: BlockOrder;
  if (n % 2 === 0 || !last) {
    value = rng() < 0.5 ? '12' : '21';
    last = value;
  } else {
    value = flipOrder(last);
  }
  return { value, counter: { n: n + 1, last } };
}

/** Same pairing rule as the block order, plus running totals per group. */
export function nextGroup(counter: Partial<GroupCounter> | undefined, rng: Rng): { value: Group; counter: GroupCounter } {
  const n = counter?.n ?? 0;
  let last = counter?.last ?? null;
  let value: Group;
  if (n % 2 === 0 || !last) {
    value = rng() < 0.5 ? 'A' : 'B';
    last = value;
  } else {
    value = flipGroup(last);
  }
  return {
    value,
    counter: {
      n: n + 1,
      last,
      countA: (counter?.countA ?? 0) + (value === 'A' ? 1 : 0),
      countB: (counter?.countB ?? 0) + (value === 'B' ? 1 : 0),
    },
  };
}

export function setsForOrder(order: BlockOrder): [SetId, SetId] {
  return order === '12' ? ['S1', 'S2'] : ['S2', 'S1'];
}

export function gapLabel(confGap: number, cfg: ConfigFile): GapLabel {
  if (confGap > cfg.gapLabel.overAbove) return 'over';
  if (confGap < cfg.gapLabel.underBelow) return 'under';
  return 'accurate';
}

/** {year}_{scoreBand}_{overFlag}, e.g. "final_low_over". */
export function stratumKey(year: string, score1: number, label: GapLabel, cfg: ConfigFile): string {
  const band = score1 <= cfg.stratification.scoreBandLowMax ? 'low' : 'high';
  return `${year}_${band}_${label === 'over' ? 'over' : 'notover'}`;
}

/** Counter / stats document ids, with the pilot prefix for pilot sessions. */
export function counterId(base: string, pilot: boolean, cfg: ConfigFile): string {
  return pilot ? `${cfg.pilotPrefix}${base}` : base;
}

/** % of earlier participants on this set who scored lower. */
export function beatsPct(counts: number[], score: number, fallback: number): number {
  const total = counts.reduce((s, c) => s + (c || 0), 0);
  if (total === 0) return fallback;
  const below = counts.slice(0, score).reduce((s, c) => s + (c || 0), 0);
  return Math.round((100 * below) / total);
}
