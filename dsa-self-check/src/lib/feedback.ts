// Builds the feedback screens (section 6) and the report topic row.
// Every value comes from the participant's own answers and profile.

import { TOPIC_IDS, type Content, type TopicId } from '../content/types';
import type { Answer, FeedbackData, FeedbackLine, Group, Profile, TopicRecord } from './model';
import { fill, pick, type Rng } from './util';

export function topicAccuracy(answers: Answer[]): TopicRecord<number | null> {
  const out = {} as TopicRecord<number | null>;
  for (const t of TOPIC_IDS) {
    const inTopic = answers.filter((a) => a.topic === t);
    out[t] = inTopic.length ? inTopic.filter((a) => a.correct).length / inTopic.length : null;
  }
  return out;
}

function correctByTopic(answers: Answer[]): TopicRecord<number> {
  const out = {} as TopicRecord<number>;
  for (const t of TOPIC_IDS) out[t] = answers.filter((a) => a.topic === t && a.correct).length;
  return out;
}

/** Group B "Strong": a correct answer from the topic with the highest block accuracy (ties at random). */
export function chooseStrong(answers: Answer[], rng: Rng): Answer | null {
  const right = answers.filter((a) => a.correct);
  if (!right.length) return null;
  const acc = topicAccuracy(answers);
  const best = Math.max(...right.map((a) => acc[a.topic] ?? 0));
  return pick(right.filter((a) => (acc[a.topic] ?? 0) === best), rng);
}

/** Group B "Work on": a wrong answer from the topic with the lowest block accuracy (ties at random). */
export function chooseWorkOn(answers: Answer[], rng: Rng): Answer | null {
  const wrong = answers.filter((a) => !a.correct);
  if (!wrong.length) return null;
  const acc = topicAccuracy(answers);
  const worst = Math.min(...wrong.map((a) => acc[a.topic] ?? 0));
  return pick(wrong.filter((a) => (acc[a.topic] ?? 0) === worst), rng);
}

export function symbolFor(count: number, strongMin: number, midMin: number, c: Content): string {
  const s = c.feedback.symbols;
  if (count >= strongMin) return s.strong;
  if (count >= midMin) return s.mid;
  return s.weak;
}

/** ✔ / △ / ✘ per topic for one block (2 questions per topic). */
export function blockTopicRow(answers: Answer[], c: Content): TopicRecord<string> {
  const counts = correctByTopic(answers);
  const { strong, mid } = c.config.feedbackTopicRow;
  const out = {} as TopicRecord<string>;
  for (const t of TOPIC_IDS) out[t] = symbolFor(counts[t], strong, mid, c);
  return out;
}

/** ✔ / △ / ✘ per topic over all answers of the session (report). */
export function reportTopicRow(answers: Answer[], c: Content): TopicRecord<string> {
  const counts = correctByTopic(answers);
  const { topicStrongMin, topicMidMin } = c.config.report;
  const out = {} as TopicRecord<string>;
  for (const t of TOPIC_IDS) out[t] = symbolFor(counts[t], topicStrongMin, topicMidMin, c);
  return out;
}

export function profileLine(profile: Profile | null, sessionCorrect: number, c: Content): string {
  const L = c.feedback.lines;
  const solved = profile?.solvedCount ?? 0;
  const streak = profile?.streak ?? 0;
  return streak > 0
    ? fill(L.profile, { solved, sessionCorrect, streak })
    : fill(L.profileNoStreak, { solved, sessionCorrect });
}

function line(a: Answer, template: string, c: Content): FeedbackLine {
  const t = c.feedback.topics[a.topic as TopicId];
  const skill = c.feedback.templates[a.topic][a.type].skill;
  return { qid: a.qid, topic: a.topic, type: a.type, text: fill(template, { topic: t.name, skill }) };
}

/** Group B extras: Strong / Work on / Tip / topic row. */
export function groupBExtras(answers: Answer[], c: Content, rng: Rng) {
  const L = c.feedback.lines;
  const s = chooseStrong(answers, rng);
  const w = chooseWorkOn(answers, rng);
  return {
    strong: s ? line(s, L.strong, c) : null,
    workOn: w ? line(w, L.workOn, c) : null,
    tip: w ? fill(L.tip, { tip: c.feedback.templates[w.topic][w.type].tip }) : null,
    topicRow: blockTopicRow(answers, c),
  };
}

export interface FeedbackInput {
  block: 1 | 2;
  group: Group;
  answers: Answer[];
  beatsPct: number;
  profile: Profile | null;
  /** Correct answers so far in the session (block 1, or block 1 + block 2). */
  sessionCorrect: number;
  rng: Rng;
}

export function buildFeedback(input: FeedbackInput, c: Content): FeedbackData {
  const L = c.feedback.lines;
  const blockScore = input.answers.filter((a) => a.correct).length;
  const total = c.config.questionsPerBlock;
  const pLine = profileLine(input.profile, input.sessionCorrect, c);
  const encouragement = pick(c.feedback.encouragements, input.rng);
  const lines = [fill(L.title, { block: input.block }), fill(L.score, { score: blockScore, total, beatsPct: input.beatsPct }), pLine];

  let extras: ReturnType<typeof groupBExtras> | null = null;
  if (input.group === 'B') {
    extras = groupBExtras(input.answers, c, input.rng);
    lines.push(extras.strong ? extras.strong.text : L.strongNone);
    lines.push(extras.workOn ? extras.workOn.text : L.workOnNone);
    if (extras.tip) lines.push(extras.tip);
    lines.push(TOPIC_IDS.map((t) => `${extras!.topicRow[t]} ${c.feedback.topics[t].short}`).join('  '));
  }
  lines.push(encouragement);

  return {
    shownAt: new Date(),
    timeOnScreenMs: null,
    blockScore,
    beatsPct: input.beatsPct,
    profileLine: pLine,
    encouragement,
    strong: extras?.strong ?? null,
    workOn: extras?.workOn ?? null,
    tip: extras?.tip ?? null,
    topicRow: extras?.topicRow ?? null,
    linesShown: lines,
  };
}
