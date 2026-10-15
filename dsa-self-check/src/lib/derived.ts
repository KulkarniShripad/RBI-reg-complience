// Derived measures stored on the participant (section 8, `derived`).

import { LANG_IDS, TOPIC_IDS, type Content, type LangId } from '../content/types';
import { gapLabel } from './assignment';
import { topicAccuracy } from './feedback';
import type { Answer, BlockData, Derived, Participant, TopicRecord } from './model';
import { mean, r4 } from './util';

export interface BlockMeasures {
  score: number;
  meanConf: number | null;
  confGap: number | null; // mean confidence − % correct
  absGap: number | null;
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
  const topicConf = {} as TopicRecord<number | null>;
  const acc = topicAccuracy(answers);
  for (const t of TOPIC_IDS) {
    topicConf[t] = r4(mean(answers.filter((a) => a.topic === t).map((a) => a.confidence)));
    acc[t] = r4(acc[t]);
  }
  return {
    score,
    meanConf: r4(meanConf),
    confGap: r4(confGap),
    absGap: r4(confGap === null ? null : Math.abs(confGap)),
    scoreGap: block.scoreGuess === null ? null : block.scoreGuess - score,
    resolution: r4(confRight === null || confWrong === null ? null : confRight - confWrong),
    topicAcc: acc,
    topicConf,
  };
}

function allAnswers(p: Pick<Participant, 'block1' | 'block2'>): Answer[] {
  return [...(p.block1?.answers ?? []), ...(p.block2?.answers ?? [])];
}

export function computeDerived(p: Pick<Participant, 'block1' | 'block2'>, c: Content): Derived {
  const m1 = p.block1 && p.block1.answers.length ? blockMeasures(p.block1, c) : null;
  const m2 = p.block2 && p.block2.answers.length ? blockMeasures(p.block2, c) : null;
  const answers = allAnswers(p);
  const used = new Set(answers.map((a) => a.langAtAnswer));
  return {
    score1: m1?.score ?? null,
    score2: m2?.score ?? null,
    meanConf1: m1?.meanConf ?? null,
    meanConf2: m2?.meanConf ?? null,
    confGap1: m1?.confGap ?? null,
    confGap2: m2?.confGap ?? null,
    absGap1: m1?.absGap ?? null,
    absGap2: m2?.absGap ?? null,
    scoreGap1: m1?.scoreGap ?? null,
    scoreGap2: m2?.scoreGap ?? null,
    resolution1: m1?.resolution ?? null,
    resolution2: m2?.resolution ?? null,
    topicAcc1: m1?.topicAcc ?? null,
    topicAcc2: m2?.topicAcc ?? null,
    topicConf1: m1?.topicConf ?? null,
    topicConf2: m2?.topicConf ?? null,
    gapLabel1: m1?.confGap != null ? gapLabel(m1.confGap, c.config) : null,
    fastAnswers: answers.filter((a) => a.timeMs < c.config.fastAnswerMs).length,
    languagesUsed: LANG_IDS.filter((l): l is LangId => used.has(l)),
  };
}
