// Derived measures stored on the participant (section 8, `derived`).

import { LANG_IDS, type Content, type LangId } from '../content/types';
import { gapLabel } from './assignment';
import { topicAccuracy } from './feedback';
import type { BlockData, Derived, Participant, TopicRecord } from './model';
import { mean, r4 } from './util';

export interface BlockMeasures {
  score: number;
  meanConf: number | null;
  confGap: number | null; // mean confidence − % correct
  absGap: number | null;
  brier: number | null;
  scoreGap: number | null; // scoreGuess − score
  resolution: number | null; // mean conf (correct) − mean conf (wrong)
  topicAcc: TopicRecord<number | null>;
  topicConf: TopicRecord<number | null>;
}

export function blockMeasures(block: BlockData, c: Content): BlockMeasures {
  const answers = block.answers;
  const score = answers.filter((a) => a.correct).length;
  const meanConf = mean(answers.map((a) => a.confidence));
  const confGap = meanConf === null ? null : meanConf - (score / c.config.questionsPerBlock) * 100;
  const confRight = mean(answers.filter((a) => a.correct).map((a) => a.confidence));
  const confWrong = mean(answers.filter((a) => !a.correct).map((a) => a.confidence));
  const brier = mean(answers.map((a) => (a.confidence / 100 - (a.correct ? 1 : 0)) ** 2));
  const topicConf: TopicRecord<number | null> = {};
  const acc = topicAccuracy(answers, c);
  for (const t of c.topics) {
    topicConf[t] = r4(mean(answers.filter((a) => a.topic === t).map((a) => a.confidence)));
    acc[t] = r4(acc[t]);
  }
  return {
    score,
    meanConf: r4(meanConf),
    confGap: r4(confGap),
    absGap: r4(confGap === null ? null : Math.abs(confGap)),
    brier: r4(brier),
    scoreGap: block.scoreGuess === null ? null : block.scoreGuess - score,
    resolution: r4(confRight === null || confWrong === null ? null : confRight - confWrong),
    topicAcc: acc,
    topicConf,
  };
}

/** Ranks with ties averaged (1-based). */
function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation; null when either side has no spread (or fewer than 2 pairs). */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) return null;
  const rx = ranks(x);
  const ry = ranks(y);
  const mx = mean(rx)!;
  const my = mean(ry)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return r4(sxy / Math.sqrt(sxx * syy));
}

/** Topic-level alignment of a per-topic judgement (rating or confidence) with per-topic accuracy. */
function align(judged: TopicRecord<number | null> | null, acc: TopicRecord<number | null> | null, c: Content): number | null {
  if (!judged || !acc) return null;
  const pairs = c.topics.filter((t) => judged[t] != null && acc[t] != null);
  return spearman(
    pairs.map((t) => judged[t] as number),
    pairs.map((t) => acc[t] as number),
  );
}

type DerivedInput = Pick<
  Participant,
  'block1' | 'block2' | 'ratingStart' | 'ratingMid' | 'beliefStart' | 'scoreGuessStart' | 'endSurvey' | 'packTopic'
>;

export function computeDerived(p: Partial<DerivedInput>, c: Content): Derived {
  const m1 = p.block1 && p.block1.answers.length ? blockMeasures(p.block1, c) : null;
  const m2 = p.block2 && p.block2.answers.length ? blockMeasures(p.block2, c) : null;
  const answers = [...(p.block1?.answers ?? []), ...(p.block2?.answers ?? [])];
  const used = new Set(answers.map((a) => a.langAtAnswer));
  const fastAnswers = answers.filter((a) => a.timeMs < c.config.fastAnswerMs).length;
  const awayAnswers = answers.filter((a) => (a.awayCount ?? 0) > 0).length;

  // Lowest-accuracy topic(s) over the whole session, for the practice-pack choice.
  const accAll = topicAccuracy(answers, c);
  const accValues = c.topics.map((t) => accAll[t]).filter((v): v is number => v != null);
  const minAcc = accValues.length ? Math.min(...accValues) : null;

  const qualityFlags: string[] = [];
  if (p.endSurvey && !p.endSurvey.serious) qualityFlags.push('notSerious');
  if (fastAnswers > c.config.quality.maxFastAnswers) qualityFlags.push('fast');
  if (awayAnswers > c.config.quality.maxAwayAnswers) qualityFlags.push('away');

  return {
    score1: m1?.score ?? null,
    score2: m2?.score ?? null,
    meanConf1: m1?.meanConf ?? null,
    meanConf2: m2?.meanConf ?? null,
    confGap1: m1?.confGap ?? null,
    confGap2: m2?.confGap ?? null,
    absGap1: m1?.absGap ?? null,
    absGap2: m2?.absGap ?? null,
    brier1: m1?.brier ?? null,
    brier2: m2?.brier ?? null,
    scoreGap1: m1?.scoreGap ?? null,
    scoreGap2: m2?.scoreGap ?? null,
    scoreGapStart: m1 && p.scoreGuessStart != null ? p.scoreGuessStart - m1.score : null,
    resolution1: m1?.resolution ?? null,
    resolution2: m2?.resolution ?? null,
    topicAcc1: m1?.topicAcc ?? null,
    topicAcc2: m2?.topicAcc ?? null,
    topicConf1: m1?.topicConf ?? null,
    topicConf2: m2?.topicConf ?? null,
    ratingAlign1: align(p.ratingStart ?? null, m1?.topicAcc ?? null, c),
    ratingAlign2: align(p.ratingMid ?? null, m2?.topicAcc ?? null, c),
    confAlign1: align(m1?.topicConf ?? null, m1?.topicAcc ?? null, c),
    confAlign2: align(m2?.topicConf ?? null, m2?.topicAcc ?? null, c),
    gapLabel1: m1?.confGap != null ? gapLabel(m1.confGap, c.config) : null,
    beliefChange: p.endSurvey && p.beliefStart != null ? p.endSurvey.beliefEnd - p.beliefStart : null,
    packIsWeakest: p.packTopic && minAcc !== null ? accAll[p.packTopic] === minAcc : null,
    fastAnswers,
    awayAnswers,
    awayMs: answers.reduce((s, a) => s + (a.awayMs ?? 0), 0),
    qualityFlags,
    languagesUsed: LANG_IDS.filter((l): l is LangId => used.has(l)),
  };
}
