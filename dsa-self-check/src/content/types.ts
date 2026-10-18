// Types for the five content files in this folder. The files are validated at
// startup (see validate.ts) before being used through these types.
// Topics and question types are not fixed in code: they come from the files
// (ui-text.json → topics, feedback.json → templates).

export type LangId = 'python' | 'cpp' | 'java';
export type TopicId = string;
export type QType = string;
export type SetId = 'S1' | 'S2';

export const LANG_IDS: LangId[] = ['python', 'cpp', 'java'];
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

export interface UiText {
  consent: {
    title: string;
    body: string;
    points: string;
    honesty: string;
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
    ownPct: { label: string; options: IdLabel[] };
    language: { label: string; options: { id: LangId; label: string }[] };
  };
  /** The study's topics, in display order. Ids match feedback.json → topics. */
  topics: IdLabel[];
  before: {
    title: string;
    ratingQ: string;
    low: string;
    high: string;
    belief: string;
    beliefLow: string;
    beliefHigh: string;
    scoreGuess: string;
  };
  rateAgain: { title: string; sub: string };
  question: { counter: string; confidence: string; confLevels: string[]; button: string };
  questionFeedback: { correct: string; wrong: string; soFar: string; button: string };
  blockEnd: { scoreGuess: string };
  endSurvey: {
    title: string;
    judgedBy: { text: string; options: (IdLabel & { groupBOnly?: boolean })[] };
    serious: { text: string; options: IdLabel[] };
  };
  pack: { title: string; sub: string; topicLabel: string; easy: string; medium: string };
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
  thanks: string;
  saving: string;
  leaveWarning: string;
}

// ---------- feedback.json ----------
export interface FeedbackFile {
  topics: Record<TopicId, { name: string; short: string }>;
  symbols: { strong: string; mid: string; weak: string };
  lines: {
    title: string;
    score: string;
    profile: string;
    profileNoStreak: string;
    byTopic: string;
    topicCount: string;
    strong: string;
    workOn: string;
    tip: string;
    strongNone: string;
    workOnNone: string;
    qRight: string;
    qWrong: string;
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
  /** The confidence buttons, in %. With 4 options a pure guess is right 25% of the time. */
  confidence: { levels: number[] };
  rating: { min: number; max: number };
  feedbackMinSeconds: number;
  /** Blocks (1 and/or 2) that show right/wrong feedback after every question. */
  questionFeedbackBlocks: number[];
  gapLabel: { overAbove: number; underBelow: number };
  stratification: { scoreBandLowMax: number };
  fastAnswerMs: number;
  /** Data-quality flags: more fast answers / tab switches than this flags the participant. */
  quality: { maxFastAnswers: number; maxAwayAnswers: number };
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
  /** topic ids in display order (from ui-text.json → topics) */
  topics: TopicId[];
}
