// The participant document (participants/{uid}) and its parts. See README → Data model.

import type { LangId, PackType, QType, SetId, TopicId } from '../content/types';

export type Group = 'A' | 'B';
export type BlockOrder = '12' | '21';
export type GapLabel = 'over' | 'under' | 'accurate';
export type TopicRecord<T> = Record<TopicId, T>;

export interface Profile {
  year: string;
  platform: string;
  solvedCount: number;
  streak: number;
  /** Band id from ui-text.json → profile.ownPct.options, e.g. "25-50". */
  ownPct: string;
  language: LangId;
}

export interface Answer {
  qid: string;
  topic: TopicId;
  type: QType;
  position: number; // 1..questionsPerBlock
  optionOrder: string[];
  chosen: string;
  correct: boolean;
  /** One of config.confidence.levels (%). */
  confidence: number;
  timeMs: number;
  /** Times the participant left the tab/app while this question was open, and for how long. */
  awayCount: number;
  awayMs: number;
  langAtAnswer: LangId;
  langSwitches: number;
  /** Blocks with per-question feedback only: the lines shown after the answer, and the time spent on them. */
  feedbackShown?: string[];
  feedbackMs?: number;
}

export interface PlannedQuestion {
  qid: string;
  optionOrder: string[];
}

export interface BlockData {
  setId: SetId;
  startedAt: Date | null;
  endedAt: Date | null;
  /** The shuffled question and option order, fixed when the block starts so a reload shows the same order. */
  plan: PlannedQuestion[];
  answers: Answer[];
  score: number | null;
  scoreGuess: number | null;
}

export interface FeedbackLine {
  qid: string;
  topic: TopicId;
  type: QType;
  text: string;
}

export interface FeedbackData {
  shownAt: Date;
  timeOnScreenMs: number | null;
  blockScore: number;
  beatsPct: number;
  profileLine: string;
  strong: FeedbackLine | null; // Group B only
  workOn: FeedbackLine | null; // Group B only
  tip: string | null; // Group B only
  topicRow: TopicRecord<string> | null; // Group B only: the symbol shown per topic
  topicCorrect: TopicRecord<number> | null; // Group B only: correct answers per topic in the block
  /** Every line exactly as displayed, top to bottom. */
  linesShown: string[];
}

export interface EndSurvey {
  /** Same statement as beliefStart ("My solved count shows how good I really am"), 1-7. */
  beliefEnd: number;
  /** What they mostly used to judge how they were doing (ui-text.json → endSurvey.judgedBy). */
  judgedBy: string;
  /** Seriousness check: false = "I rushed, don't use my answers". */
  serious: boolean;
}

export interface Derived {
  score1: number | null;
  score2: number | null;
  meanConf1: number | null;
  meanConf2: number | null;
  /** Calibration bias: mean confidence − % correct. Positive = overconfident. */
  confGap1: number | null;
  confGap2: number | null;
  absGap1: number | null;
  absGap2: number | null;
  /** Brier score: mean of (confidence − correct)², 0 = perfect, lower is better. */
  brier1: number | null;
  brier2: number | null;
  scoreGap1: number | null; // scoreGuess − score
  scoreGap2: number | null;
  scoreGapStart: number | null; // scoreGuessStart − score1 (prediction before seeing any question)
  resolution1: number | null; // mean conf (correct) − mean conf (wrong)
  resolution2: number | null;
  topicAcc1: TopicRecord<number | null> | null;
  topicAcc2: TopicRecord<number | null> | null;
  topicConf1: TopicRecord<number | null> | null;
  topicConf2: TopicRecord<number | null> | null;
  /** Spearman correlation across topics: self-rating vs accuracy (null if either has no spread). */
  ratingAlign1: number | null; // ratingStart vs Block 1
  ratingAlign2: number | null; // ratingMid (after feedback) vs Block 2
  /** Spearman correlation across topics: per-question confidence vs accuracy. */
  confAlign1: number | null;
  confAlign2: number | null;
  gapLabel1: GapLabel | null;
  beliefChange: number | null; // beliefEnd − beliefStart
  /** The chosen practice topic is (one of) the participant's lowest-accuracy topics. */
  packIsWeakest: boolean | null;
  fastAnswers: number; // answers with timeMs < config.fastAnswerMs
  awayAnswers: number; // answers where the participant left the tab
  awayMs: number;
  /** Reasons to consider excluding this participant: notSerious, fast, away. */
  qualityFlags: string[];
  languagesUsed: LangId[];
}

export interface Participant {
  uid: string;
  status: 'started' | 'completed';
  withdrawn: boolean;
  pilot: boolean;
  /** Started with ?debug=1 (testers). Debug sessions always use the pilot counters and stats. */
  debug: boolean;
  appVersion: string;
  contentVersion: string;
  device: { userAgent: string; screenW: number; screenH: number; isMobile: boolean };
  currentStep: number;
  currentStepName: string;
  /** Increments on every save; used to reconcile the local copy with Firestore on resume. */
  rev: number;
  /** The code language tab currently selected; carries over between questions and across reloads. */
  lang: LangId;
  /** qid whose per-question feedback is on screen (so a reload shows it again), else null. */
  reviewing: string | null;

  blockOrder: BlockOrder | null;
  group: Group | null;
  stratum: string | null;

  profile: Profile | null;
  ratingStart: TopicRecord<number> | null;
  ratingMid: TopicRecord<number> | null;
  beliefStart: number | null;
  scoreGuessStart: number | null;

  block1: BlockData | null;
  block2: BlockData | null;
  feedback1: FeedbackData | null;

  endSurvey: EndSurvey | null;
  packTopic: TopicId | null;
  packType: PackType | null;
  derived: Derived | null;

  // Set by the store with server timestamps.
  createdAt?: Date | null;
  updatedAt?: Date | null;
  completedAt?: Date | null;
  withdrawnAt?: Date | null;
}

export type ParticipantPatch = Partial<Participant>;

/** Marker replaced by the store with a server timestamp (Firestore) or the current time (local mode). */
export const SERVER_TIME = '__serverTime__' as unknown as Date;
