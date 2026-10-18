// Flow helpers shared by the app and the debug step-jump menu.

import type { Content } from '../content/types';
import { setsForOrder } from './assignment';
import { computeDerived } from './derived';
import type { Answer, BlockData, Participant, ParticipantPatch, TopicRecord } from './model';
import { pick, shuffle, type Rng } from './util';

/** Draws the question order and every question's option order for a block. */
export function makeBlock(n: 1 | 2, p: Pick<Participant, 'blockOrder'>, c: Content, rng: Rng = Math.random): BlockData {
  if (!p.blockOrder) throw new Error('Block order is not assigned yet');
  const setId = setsForOrder(p.blockOrder)[n - 1];
  const qids = shuffle(c.questions.sets[setId], rng);
  return {
    setId,
    startedAt: new Date(),
    endedAt: null,
    plan: qids.map((qid) => ({ qid, optionOrder: shuffle(c.byId[qid].options.map((o) => o.id), rng) })),
    answers: [],
    score: null,
    scoreGuess: null,
  };
}

export function blockScore(b: BlockData | null): number {
  return b ? b.answers.filter((a) => a.correct).length : 0;
}

// ---------------------------------------------------------------------------
// Debug (?debug=1) only: fill the data a screen needs when a tester jumps ahead.
// These sessions are always marked pilot + debug, so none of this reaches real data.

const randInt = (min: number, max: number, rng: Rng) => min + Math.floor(rng() * (max - min + 1));

function randomRatings(c: Content, rng: Rng): TopicRecord<number> {
  const out: TopicRecord<number> = {};
  for (const t of c.topics) out[t] = randInt(c.config.rating.min, c.config.rating.max, rng);
  return out;
}

export function debugAnswers(block: BlockData, p: Participant, c: Content, rng: Rng = Math.random): Answer[] {
  const answers = block.answers.slice();
  for (let i = answers.length; i < block.plan.length; i++) {
    const { qid, optionOrder } = block.plan[i];
    const q = c.byId[qid];
    const chosen = rng() < 0.6 ? q.correct : optionOrder[randInt(0, optionOrder.length - 1, rng)];
    answers.push({
      qid,
      topic: q.topic,
      type: q.type,
      position: i + 1,
      optionOrder,
      chosen,
      correct: chosen === q.correct,
      confidence: pick(c.config.confidence.levels, rng),
      timeMs: randInt(3000, 60000, rng),
      awayCount: 0,
      awayMs: 0,
      langAtAnswer: p.lang,
      langSwitches: 0,
    });
  }
  return answers;
}

/** Data for the debug jump; returns a patch (block order and group are assigned by the caller). */
export function debugFill(target: number, p: Participant, c: Content, stepIndexOf: (id: string) => number, rng: Rng = Math.random): ParticipantPatch {
  const past = (id: string) => target > stepIndexOf(id);
  const patch: ParticipantPatch = {};
  const cur = () => ({ ...p, ...patch }) as Participant;

  if (past('profile') && !p.profile) {
    patch.profile = {
      year: c.ui.profile.year.options[0].id,
      platform: c.ui.profile.platform.options[0],
      solvedCount: randInt(0, 400, rng),
      streak: randInt(0, 30, rng),
      ownPct: pick(c.ui.profile.ownPct.options, rng).id,
      language: p.lang,
    };
  }
  if (past('before') && !p.ratingStart) {
    patch.ratingStart = randomRatings(c, rng);
    patch.beliefStart = randInt(c.config.rating.min, c.config.rating.max, rng);
    patch.scoreGuessStart = randInt(0, c.config.questionsPerBlock, rng);
  }
  for (const n of [1, 2] as const) {
    const key = n === 1 ? 'block1' : 'block2';
    const blockStep = stepIndexOf(key);
    if (target < blockStep || !cur().blockOrder) continue;
    let b = cur()[key];
    // Jumping to a block screen starts that block afresh.
    if (!b || target === blockStep) b = makeBlock(n, cur(), c, rng);
    if (target > blockStep && b.answers.length < b.plan.length) {
      const answers = debugAnswers(b, cur(), c, rng);
      b = { ...b, answers, endedAt: new Date(), score: answers.filter((a) => a.correct).length };
    }
    if (past(`${key}End`) && b.scoreGuess === null) b = { ...b, scoreGuess: randInt(0, c.config.questionsPerBlock, rng) };
    patch[key] = b;
  }
  if (past('rateMid') && !p.ratingMid) patch.ratingMid = randomRatings(c, rng);
  if (past('endSurvey') && !p.endSurvey) {
    patch.endSurvey = {
      beliefEnd: randInt(c.config.rating.min, c.config.rating.max, rng),
      judgedBy: c.ui.endSurvey.judgedBy.options[0].id,
      serious: true,
    };
  }
  if (past('pack') && !p.packTopic) {
    patch.packTopic = pick(c.topics, rng);
    patch.packType = rng() < 0.5 ? 'easy' : 'medium';
  }
  const merged = cur();
  if (merged.block1?.answers.length) patch.derived = computeDerived(merged, c);
  return patch;
}
