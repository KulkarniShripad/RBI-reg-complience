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
  ownPct: number;
  language: LangId;
}

export interface Answer {
  qid: string;
  topic: TopicId;
  type: QType;
  position: number; // 1-8
  optionOrder: string[];
  chosen: string;
  correct: boolean;
  confidence: number;
  timeMs: number;
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
  rankGuess: number | null;
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
  encouragement: string;
  strong: FeedbackLine | null; // Group B only
  workOn: FeedbackLine | null; // Group B only
  tip: string | null; // Group B only
  topicRow: TopicRecord<string> | null; // Group B only: the symbol shown per topic
  /** Every line exactly as displayed, top to bottom. */
  linesShown: string[];
}

export interface CloseAnswers {
  M1: string | null; // Group A: null
  M2: string;
  O1: number;
  O2: string;
  O3: number;
}

export interface Derived {
  score1: number | null;
  score2: number | null;
  meanConf1: number | null;
  meanConf2: number | null;
  confGap1: number | null;
  confGap2: number | null;
  absGap1: number | null;
  absGap2: number | null;
  scoreGap1: number | null;
  scoreGap2: number | null;
  resolution1: number | null;
  resolution2: number | null;
  topicAcc1: TopicRecord<number | null> | null;
  topicAcc2: TopicRecord<number | null> | null;
  topicConf1: TopicRecord<number | null> | null;
  topicConf2: TopicRecord<number | null> | null;
  gapLabel1: GapLabel | null;
  fastAnswers: number;
  languagesUsed: LangId[];
}

export type Preference = 'A' | 'B' | 'Either';

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
  ratingEnd: TopicRecord<number> | null;
  statements: Record<string, number> | null;
  rankGuessStart: number | null;
  scoreGuessStart: number | null;

  block1: BlockData | null;
  block2: BlockData | null;
  feedback1: FeedbackData | null;
  feedback2: FeedbackData | null;

  endItems: Record<string, number> | null;
  endItemsOrder: string[] | null;
  attentionPassed: boolean | null;
  packTopic: TopicId | null;
  packType: PackType | null;
  close: CloseAnswers | null;
  preference: Preference | null;
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
