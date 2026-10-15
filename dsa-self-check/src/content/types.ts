// Types for the five content files in this folder. The files are validated at
// startup (see validate.ts) before being used through these types.

export type LangId = 'python' | 'cpp' | 'java';
export type TopicId = 'arrays' | 'window' | 'recursion' | 'dp';
export type QType = 'trace' | 'complete' | 'pattern' | 'debug';
export type SetId = 'S1' | 'S2';

export const LANG_IDS: LangId[] = ['python', 'cpp', 'java'];
export const TOPIC_IDS: TopicId[] = ['arrays', 'window', 'recursion', 'dp'];
export const QTYPES: QType[] = ['trace', 'complete', 'pattern', 'debug'];
export const SET_IDS: SetId[] = ['S1', 'S2'];

export type PerLang<T> = Record<LangId, T>;

// ---------- questions.json ----------
export interface QuestionOption {
  id: string;
  text: string | PerLang<string>;
}

export interface Question {
  id: string;
  set: SetId;
  topic: TopicId;
  type: QType;
  basedOn?: string;
  stem: string;
  code: PerLang<string> | null;
  showLineNumbers: boolean;
  options: QuestionOption[];
  correct: string;
}

export interface QuestionsFile {
  version: string;
  languages: { id: LangId; label: string }[];
  blank: string;
  sets: Record<SetId, string[]>;
  questions: Question[];
}

// ---------- ui-text.json ----------
export interface IdLabel {
  id: string;
  label: string;
}
export interface IdText {
  id: string;
  text: string;
}

export interface UiText {
  consent: {
    title: string;
    body: string;
    points: string;
    checkbox: string;
    button: string;
    alreadyDone: string;
  };
  profile: {
    title: string;
    year: { label: string; options: IdLabel[] };
    platform: { label: string; options: string[] };
    solvedCount: string;
    streak: string;
    ownPct: string;
    language: { label: string; options: { id: LangId; label: string }[] };
  };
  rateSelf: {
    title: string;
    sub: string;
    low: string;
    high: string;
    topics: { id: TopicId; label: string }[];
  };
  rateAgain: { title: string; sub: string };
  statements: {
    title: string;
    low: string;
    high: string;
    items: IdText[];
    rankGuess: string;
    scoreGuess: string;
  };
  howItWorks: { title: string; line: string; langNote: string; button: string };
  question: { counter: string; confidence: string; confLow: string; confHigh: string; button: string };
  questionFeedback: { correct: string; wrong: string; soFar: string; button: string };
  blockEnd: { scoreGuess: string; rankGuess: string };
  endRatings: { title: string; low: string; high: string; items: IdText[] };
  pack: { title: string; sub: string; topicLabel: string; easy: string; medium: string };
  close: {
    title: string;
    M1: { text: string; dontRemember: string };
    M2: { text: string; options: (IdLabel & { groupBOnly?: boolean })[] };
    O1: { text: string; low: string; high: string };
    O2: { text: string; options: IdLabel[] };
    O3: { text: string; low: string; high: string };
  };
  report: {
    title: string;
    blockLine: string;
    topicsTitle: string;
    legend: string;
    packTitle: string;
    aboutTitle: string;
    about: string;
    withdraw: string;
    withdrawn: string;
  };
  preference: { title: string; options: IdLabel[] };
  thanks: string;
  saving: string;
  leaveWarning: string;
}

// ---------- feedback.json ----------
export interface FeedbackFile {
  topics: Record<TopicId, { name: string; short: string }>;
  symbols: { strong: string; mid: string; weak: string };
  encouragements: string[];
  lines: {
    title: string;
    score: string;
    profile: string;
    profileNoStreak: string;
    strong: string;
    workOn: string;
    tip: string;
    strongNone: string;
    workOnNone: string;
  };
  templates: Record<TopicId, Record<QType, { skill: string; tip: string }>>;
}

// ---------- packs.json ----------
export interface PackProblem {
  slug: string;
  url: string;
}
export type PackType = 'easy' | 'medium';
export type PacksFile = Record<PackType, Record<TopicId, PackProblem[]>>;

// ---------- config.json ----------
export interface ConfigFile {
  appVersion: string;
  studyName: string;
  questionsPerBlock: number;
  confidence: { min: number; max: number; step: number; default: number };
  rating: { min: number; max: number };
  feedbackMinSeconds: number;
  /** Blocks (1 and/or 2) that show right/wrong feedback after every question. */
  questionFeedbackBlocks: number[];
  /** Show the "8 questions, then a short break, then 8 more" screen before Block 1. */
  showHowItWorks: boolean;
  gapLabel: { overAbove: number; underBelow: number };
  stratification: { scoreBandLowMax: number };
  fastAnswerMs: number;
  attentionCheck: { itemId: string; passValue: number };
  beatsPctFallback: number;
  report: { topicStrongMin: number; topicMidMin: number };
  feedbackTopicRow: { strong: number; mid: number };
  pilotPrefix: string;
  defaultLanguage: LangId;
  profileLimits: { solvedCountMax: number; streakMax: number };
}

export interface Content {
  questions: QuestionsFile;
  ui: UiText;
  feedback: FeedbackFile;
  packs: PacksFile;
  config: ConfigFile;
  /** questions by id */
  byId: Record<string, Question>;
}
