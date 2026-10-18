// Builds the feedback (section 6) and the report topic row. Every value comes
// from the participant's own answers and profile.
//
// Format (Hattie & Timperley 2007; Shute 2008): both groups get the platform-style
// numbers. Group B also gets task-level feedback on what they actually answered:
// "how am I doing" per topic (✔ / △ / ✘ with counts), one strength, and one
// "where to next" with a single concrete tip. No generic praise.

import type { Content, QType, TopicId } from '../content/types';
import type { Answer, FeedbackData, FeedbackLine, Group, Profile, TopicRecord } from './model';
import { fill, pick, plain, type Rng } from './util';

export function topicAccuracy(answers: Answer[], c: Content): TopicRecord<number | null> {
  const out: TopicRecord<number | null> = {};
  for (const t of c.topics) {
    const inTopic = answers.filter((a) => a.topic === t);
    out[t] = inTopic.length ? inTopic.filter((a) => a.correct).length / inTopic.length : null;
  }
  return out;
}

export function correctByTopic(answers: Answer[], c: Content): TopicRecord<number> {
  const out: TopicRecord<number> = {};
  for (const t of c.topics) out[t] = answers.filter((a) => a.topic === t && a.correct).length;
  return out;
}

export function countByTopic(answers: Answer[], c: Content): TopicRecord<number> {
  const out: TopicRecord<number> = {};
  for (const t of c.topics) out[t] = answers.filter((a) => a.topic === t).length;
  return out;
}

/** Group B "Strong": a correct answer from the topic with the highest block accuracy (ties at random). */
export function chooseStrong(answers: Answer[], c: Content, rng: Rng): Answer | null {
  const right = answers.filter((a) => a.correct);
  if (!right.length) return null;
  const acc = topicAccuracy(answers, c);
  const best = Math.max(...right.map((a) => acc[a.topic] ?? 0));
  return pick(right.filter((a) => (acc[a.topic] ?? 0) === best), rng);
}

/** Group B "Next": a wrong answer from the topic with the lowest block accuracy (ties at random). */
export function chooseWorkOn(answers: Answer[], c: Content, rng: Rng): Answer | null {
  const wrong = answers.filter((a) => !a.correct);
  if (!wrong.length) return null;
  const acc = topicAccuracy(answers, c);
  const worst = Math.min(...wrong.map((a) => acc[a.topic] ?? 0));
  return pick(wrong.filter((a) => (acc[a.topic] ?? 0) === worst), rng);
}

export function symbolFor(count: number, strongMin: number, midMin: number, c: Content): string {
  const s = c.feedback.symbols;
  if (count >= strongMin) return s.strong;
  if (count >= midMin) return s.mid;
  return s.weak;
}

/** ✔ / △ / ✘ per topic for one block. */
export function blockTopicRow(answers: Answer[], c: Content): TopicRecord<string> {
  const counts = correctByTopic(answers, c);
  const { strong, mid } = c.config.feedbackTopicRow;
  const out: TopicRecord<string> = {};
  for (const t of c.topics) out[t] = symbolFor(counts[t], strong, mid, c);
  return out;
}

/** ✔ / △ / ✘ per topic over all answers of the session (report). */
export function reportTopicRow(answers: Answer[], c: Content): TopicRecord<string> {
  const counts = correctByTopic(answers, c);
  const { topicStrongMin, topicMidMin } = c.config.report;
  const out: TopicRecord<string> = {};
  for (const t of c.topics) out[t] = symbolFor(counts[t], topicStrongMin, topicMidMin, c);
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

/** A topic + skill line for one question's topic and type, with its **bold** markers (for display). */
export function conceptLine(template: string, topic: TopicId, type: QType, c: Content): string {
  return fill(template, { topic: c.feedback.topics[topic].name, skill: c.feedback.templates[topic][type].skill });
}

/** The tip for one question's topic and type, with its **bold** markers (for display). */
export function tipLine(topic: TopicId, type: QType, c: Content): string {
  return fill(c.feedback.lines.tip, { tip: c.feedback.templates[topic][type].tip });
}

/** "Arrays  2/2" row text for one topic. */
export function topicRowText(topic: TopicId, correct: number, n: number, symbol: string, c: Content): string {
  return `${symbol} ${c.feedback.topics[topic].short} ${fill(c.feedback.lines.topicCount, { correct, n })}`;
}

function line(a: Answer, template: string, c: Content): FeedbackLine {
  return { qid: a.qid, topic: a.topic, type: a.type, text: plain(conceptLine(template, a.topic, a.type, c)) };
}

/** Group B extras for a block: topic row, Strong, Next + tip. */
export function groupBExtras(answers: Answer[], c: Content, rng: Rng) {
  const L = c.feedback.lines;
  const s = chooseStrong(answers, c, rng);
  const w = chooseWorkOn(answers, c, rng);
  return {
    strong: s ? line(s, L.strong, c) : null,
    workOn: w ? line(w, L.workOn, c) : null,
    tip: w ? plain(tipLine(w.topic, w.type, c)) : null,
    topicRow: blockTopicRow(answers, c),
    topicCorrect: correctByTopic(answers, c),
  };
}

export interface FeedbackInput {
  block: 1 | 2;
  group: Group;
  answers: Answer[];
  beatsPct: number;
  profile: Profile | null;
  /** Correct answers so far in the session. */
  sessionCorrect: number;
  rng: Rng;
}

export function buildFeedback(input: FeedbackInput, c: Content): FeedbackData {
  const L = c.feedback.lines;
  const blockScore = input.answers.filter((a) => a.correct).length;
  const total = c.config.questionsPerBlock;
  const pLine = profileLine(input.profile, input.sessionCorrect, c);
  const lines = [fill(L.title, { block: input.block }), fill(L.score, { score: blockScore, total, beatsPct: input.beatsPct }), pLine];

  let extras: ReturnType<typeof groupBExtras> | null = null;
  if (input.group === 'B') {
    extras = groupBExtras(input.answers, c, input.rng);
    const n = countByTopic(input.answers, c);
    lines.push(L.byTopic);
    for (const t of c.topics) lines.push(topicRowText(t, extras.topicCorrect[t], n[t], extras.topicRow[t], c));
    lines.push(extras.strong ? extras.strong.text : L.strongNone);
    lines.push(extras.workOn ? extras.workOn.text : L.workOnNone);
    if (extras.tip) lines.push(extras.tip);
  }

  return {
    shownAt: new Date(),
    timeOnScreenMs: null,
    blockScore,
    beatsPct: input.beatsPct,
    profileLine: pLine,
    strong: extras?.strong ?? null,
    workOn: extras?.workOn ?? null,
    tip: extras?.tip ?? null,
    topicRow: extras?.topicRow ?? null,
    topicCorrect: extras?.topicCorrect ?? null,
    linesShown: lines.map(plain),
  };
}

/**
 * Feedback shown right after one question (blocks in config.questionFeedbackBlocks):
 * right / wrong and the running score for everyone; Group B also gets the question's
 * topic + skill and, if wrong, its tip. Lines keep their **bold** markers.
 */
export function questionFeedbackLines(answer: Answer, answersSoFar: Answer[], group: Group | null, c: Content): string[] {
  const u = c.ui.questionFeedback;
  const L = c.feedback.lines;
  const score = answersSoFar.filter((a) => a.correct).length;
  const lines = [answer.correct ? u.correct : u.wrong, fill(u.soFar, { score, n: answersSoFar.length })];
  if (group === 'B') {
    if (answer.correct) lines.push(conceptLine(L.qRight, answer.topic, answer.type, c));
    else lines.push(conceptLine(L.qWrong, answer.topic, answer.type, c), tipLine(answer.topic, answer.type, c));
  }
  return lines;
}
