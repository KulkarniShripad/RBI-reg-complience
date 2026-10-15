// Startup validation of the content JSON. Collects every problem it finds and
// throws one error listing them all, so a broken edit is caught on the first
// page load (and by `npm test`) instead of halfway through a participant's session.

import {
  LANG_IDS,
  QTYPES,
  SET_IDS,
  TOPIC_IDS,
  type ConfigFile,
  type Content,
  type FeedbackFile,
  type PacksFile,
  type Question,
  type QuestionsFile,
  type UiText,
} from './types';

export class ContentError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Content files are invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'ContentError';
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function get(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function isPerLangString(v: unknown): boolean {
  return isObj(v) && LANG_IDS.every((l) => isStr(v[l]));
}

function checkQuestions(q: unknown, cfg: unknown, p: string[]) {
  const f = 'questions.json';
  if (!isObj(q)) return p.push(`${f}: not an object`);
  if (!isStr(q.version)) p.push(`${f}: "version" must be a non-empty string`);
  if (!isStr(q.blank)) p.push(`${f}: "blank" must be a non-empty string`);

  const langs = q.languages;
  if (!Array.isArray(langs)) p.push(`${f}: "languages" must be an array`);
  else {
    const ids = langs.map((l) => (isObj(l) ? l.id : undefined));
    for (const id of LANG_IDS) if (!ids.includes(id)) p.push(`${f}: "languages" is missing "${id}"`);
    langs.forEach((l, i) => {
      if (!isObj(l) || !isStr(l.label)) p.push(`${f}: languages[${i}] needs an id and a label`);
    });
  }

  const perBlock = get(cfg, 'questionsPerBlock');
  const questions = Array.isArray(q.questions) ? (q.questions as unknown[]) : [];
  if (!Array.isArray(q.questions)) p.push(`${f}: "questions" must be an array`);

  const byId = new Map<string, Obj>();
  questions.forEach((raw, i) => {
    const where = `${f}: questions[${i}]`;
    if (!isObj(raw)) return p.push(`${where} is not an object`);
    const id = raw.id;
    if (!isStr(id)) return p.push(`${where} has no "id"`);
    const at = `${f}: question ${id}`;
    if (byId.has(id)) p.push(`${at}: duplicate id`);
    byId.set(id, raw);

    if (!SET_IDS.includes(raw.set as never)) p.push(`${at}: "set" must be one of ${SET_IDS.join(', ')}`);
    if (!TOPIC_IDS.includes(raw.topic as never)) p.push(`${at}: "topic" must be one of ${TOPIC_IDS.join(', ')}`);
    if (!QTYPES.includes(raw.type as never)) p.push(`${at}: "type" must be one of ${QTYPES.join(', ')}`);
    if (!isStr(raw.stem)) p.push(`${at}: "stem" must be a non-empty string`);
    if (typeof raw.showLineNumbers !== 'boolean') p.push(`${at}: "showLineNumbers" must be true or false`);

    if (raw.code !== null) {
      if (!isObj(raw.code)) p.push(`${at}: "code" must be null or an object with python, cpp and java`);
      else for (const l of LANG_IDS) if (!isStr(raw.code[l])) p.push(`${at}: "code.${l}" is missing`);
    }

    const opts = raw.options;
    if (!Array.isArray(opts) || opts.length < 2) {
      p.push(`${at}: "options" must be an array of at least 2 options`);
    } else {
      const optIds = new Set<string>();
      opts.forEach((o, j) => {
        if (!isObj(o) || !isStr(o.id)) return p.push(`${at}: options[${j}] has no "id"`);
        if (optIds.has(o.id)) p.push(`${at}: duplicate option id "${o.id}"`);
        optIds.add(o.id);
        if (!isStr(o.text) && !isPerLangString(o.text)) {
          p.push(`${at}: option "${o.id}" text must be a string or an object with python, cpp and java`);
        }
      });
      if (!isStr(raw.correct) || !optIds.has(raw.correct)) {
        p.push(`${at}: "correct" (${String(raw.correct)}) does not match any option id`);
      }
    }
  });

  if (!isObj(q.sets)) p.push(`${f}: "sets" must be an object`);
  else {
    const seen = new Set<string>();
    for (const s of SET_IDS) {
      const ids = q.sets[s];
      if (!Array.isArray(ids)) {
        p.push(`${f}: sets.${s} is missing`);
        continue;
      }
      if (isNum(perBlock) && ids.length !== perBlock) {
        p.push(`${f}: sets.${s} has ${ids.length} questions but config.questionsPerBlock is ${perBlock}`);
      }
      const topicCount: Record<string, number> = {};
      const typeCount: Record<string, number> = {};
      for (const id of ids) {
        const qq = isStr(id) ? byId.get(id) : undefined;
        if (!qq) {
          p.push(`${f}: sets.${s} lists "${String(id)}", which is not a question`);
          continue;
        }
        if (seen.has(id as string)) p.push(`${f}: "${String(id)}" appears in more than one set or twice`);
        seen.add(id as string);
        if (qq.set !== s) p.push(`${f}: question ${String(id)} is listed in sets.${s} but its "set" is ${String(qq.set)}`);
        topicCount[String(qq.topic)] = (topicCount[String(qq.topic)] ?? 0) + 1;
        typeCount[String(qq.type)] = (typeCount[String(qq.type)] ?? 0) + 1;
      }
      // The feedback topic row (✔ = 2, △ = 1, ✘ = 0) assumes 2 questions per topic per block.
      if (isNum(perBlock) && perBlock === ids.length) {
        const per = perBlock / TOPIC_IDS.length;
        for (const t of TOPIC_IDS) {
          if ((topicCount[t] ?? 0) !== per) p.push(`${f}: sets.${s} should have ${per} "${t}" questions, has ${topicCount[t] ?? 0}`);
        }
        for (const t of QTYPES) {
          if ((typeCount[t] ?? 0) !== per) p.push(`${f}: sets.${s} should have ${per} "${t}" questions, has ${typeCount[t] ?? 0}`);
        }
      }
    }
  }
}

const UI_STRINGS = [
  'consent.title', 'consent.body', 'consent.points', 'consent.checkbox', 'consent.button', 'consent.alreadyDone',
  'profile.title', 'profile.year.label', 'profile.platform.label', 'profile.solvedCount', 'profile.streak',
  'profile.ownPct', 'profile.language.label',
  'rateSelf.title', 'rateSelf.sub', 'rateSelf.low', 'rateSelf.high',
  'rateAgain.title', 'rateAgain.sub',
  'statements.title', 'statements.low', 'statements.high', 'statements.rankGuess', 'statements.scoreGuess',
  'howItWorks.title', 'howItWorks.line', 'howItWorks.langNote', 'howItWorks.button',
  'question.counter', 'question.confidence', 'question.confLow', 'question.confHigh', 'question.button',
  'questionFeedback.correct', 'questionFeedback.wrong', 'questionFeedback.soFar', 'questionFeedback.button',
  'blockEnd.scoreGuess', 'blockEnd.rankGuess',
  'endRatings.title', 'endRatings.low', 'endRatings.high',
  'pack.title', 'pack.sub', 'pack.topicLabel', 'pack.easy', 'pack.medium',
  'close.title', 'close.M1.text', 'close.M1.dontRemember', 'close.M2.text', 'close.O1.text', 'close.O1.low',
  'close.O1.high', 'close.O2.text', 'close.O3.text', 'close.O3.low', 'close.O3.high',
  'report.title', 'report.blockLine', 'report.topicsTitle', 'report.legend', 'report.packTitle',
  'report.aboutTitle', 'report.about', 'report.withdraw', 'report.withdrawn',
  'preference.title', 'thanks', 'saving', 'leaveWarning',
];

const UI_ID_LISTS: [path: string, labelKey: 'label' | 'text'][] = [
  ['profile.year.options', 'label'],
  ['profile.language.options', 'label'],
  ['rateSelf.topics', 'label'],
  ['statements.items', 'text'],
  ['endRatings.items', 'text'],
  ['close.M2.options', 'label'],
  ['close.O2.options', 'label'],
  ['preference.options', 'label'],
];

function checkUi(ui: unknown, cfg: unknown, p: string[]) {
  const f = 'ui-text.json';
  if (!isObj(ui)) return p.push(`${f}: not an object`);
  for (const path of UI_STRINGS) if (!isStr(get(ui, path))) p.push(`${f}: "${path}" must be a non-empty string`);
  for (const [path, key] of UI_ID_LISTS) {
    const list = get(ui, path);
    if (!Array.isArray(list) || list.length === 0) {
      p.push(`${f}: "${path}" must be a non-empty array`);
      continue;
    }
    list.forEach((it, i) => {
      if (!isObj(it) || !isStr(it.id) || !isStr(it[key])) p.push(`${f}: ${path}[${i}] needs "id" and "${key}"`);
    });
  }
  const platforms = get(ui, 'profile.platform.options');
  if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every(isStr)) {
    p.push(`${f}: "profile.platform.options" must be a non-empty array of strings`);
  }
  const langIds = (get(ui, 'profile.language.options') as Obj[] | undefined)?.map((o) => o?.id) ?? [];
  for (const l of LANG_IDS) if (!langIds.includes(l)) p.push(`${f}: profile.language.options is missing "${l}"`);
  const topicIds = (get(ui, 'rateSelf.topics') as Obj[] | undefined)?.map((o) => o?.id) ?? [];
  for (const t of TOPIC_IDS) if (!topicIds.includes(t)) p.push(`${f}: rateSelf.topics is missing "${t}"`);
  const prefIds = (get(ui, 'preference.options') as Obj[] | undefined)?.map((o) => o?.id) ?? [];
  for (const id of ['A', 'B', 'Either']) if (!prefIds.includes(id)) p.push(`${f}: preference.options is missing "${id}"`);
  const acId = get(cfg, 'attentionCheck.itemId');
  const endIds = (get(ui, 'endRatings.items') as Obj[] | undefined)?.map((o) => o?.id) ?? [];
  if (isStr(acId) && !endIds.includes(acId)) p.push(`${f}: endRatings.items has no "${acId}" (config.attentionCheck.itemId)`);
}

function checkFeedback(fb: unknown, p: string[]) {
  const f = 'feedback.json';
  if (!isObj(fb)) return p.push(`${f}: not an object`);
  for (const t of TOPIC_IDS) {
    if (!isStr(get(fb, `topics.${t}.name`))) p.push(`${f}: "topics.${t}.name" is missing`);
    if (!isStr(get(fb, `topics.${t}.short`))) p.push(`${f}: "topics.${t}.short" is missing`);
    for (const ty of QTYPES) {
      if (!isStr(get(fb, `templates.${t}.${ty}.skill`))) p.push(`${f}: "templates.${t}.${ty}.skill" is missing`);
      if (!isStr(get(fb, `templates.${t}.${ty}.tip`))) p.push(`${f}: "templates.${t}.${ty}.tip" is missing`);
    }
  }
  for (const s of ['strong', 'mid', 'weak']) if (!isStr(get(fb, `symbols.${s}`))) p.push(`${f}: "symbols.${s}" is missing`);
  const enc = fb.encouragements;
  if (!Array.isArray(enc) || enc.length === 0 || !enc.every(isStr)) p.push(`${f}: "encouragements" must be a non-empty array of strings`);
  for (const k of ['title', 'score', 'profile', 'profileNoStreak', 'strong', 'workOn', 'tip', 'strongNone', 'workOnNone']) {
    if (!isStr(get(fb, `lines.${k}`))) p.push(`${f}: "lines.${k}" is missing`);
  }
}

function checkPacks(packs: unknown, p: string[]) {
  const f = 'packs.json';
  if (!isObj(packs)) return p.push(`${f}: not an object`);
  for (const kind of ['easy', 'medium']) {
    for (const t of TOPIC_IDS) {
      const list = get(packs, `${kind}.${t}`);
      if (!Array.isArray(list) || list.length === 0) {
        p.push(`${f}: "${kind}.${t}" must be a non-empty array`);
        continue;
      }
      list.forEach((it, i) => {
        if (!isObj(it) || !isStr(it.slug) || !isStr(it.url)) p.push(`${f}: ${kind}.${t}[${i}] needs "slug" and "url"`);
        else if (!/^https?:\/\//.test(it.url)) p.push(`${f}: ${kind}.${t}[${i}].url must start with http(s)://`);
      });
    }
  }
}

const CONFIG_NUMBERS = [
  'questionsPerBlock', 'confidence.min', 'confidence.max', 'confidence.step', 'confidence.default',
  'rating.min', 'rating.max', 'feedbackMinSeconds', 'gapLabel.overAbove', 'gapLabel.underBelow',
  'stratification.scoreBandLowMax', 'fastAnswerMs', 'attentionCheck.passValue', 'beatsPctFallback',
  'report.topicStrongMin', 'report.topicMidMin', 'feedbackTopicRow.strong', 'feedbackTopicRow.mid',
  'profileLimits.solvedCountMax', 'profileLimits.streakMax',
];

function checkConfig(cfg: unknown, p: string[]) {
  const f = 'config.json';
  if (!isObj(cfg)) return p.push(`${f}: not an object`);
  for (const k of CONFIG_NUMBERS) if (!isNum(get(cfg, k))) p.push(`${f}: "${k}" must be a number`);
  for (const k of ['appVersion', 'studyName', 'pilotPrefix', 'attentionCheck.itemId']) {
    if (!isStr(get(cfg, k))) p.push(`${f}: "${k}" must be a non-empty string`);
  }
  if (!LANG_IDS.includes(cfg.defaultLanguage as never)) p.push(`${f}: "defaultLanguage" must be one of ${LANG_IDS.join(', ')}`);
  const qfb = cfg.questionFeedbackBlocks;
  if (!Array.isArray(qfb) || !qfb.every((b) => b === 1 || b === 2)) p.push(`${f}: "questionFeedbackBlocks" must be a list of block numbers (1, 2), e.g. [2] or []`);
  if (typeof cfg.showHowItWorks !== 'boolean') p.push(`${f}: "showHowItWorks" must be true or false`);
  const c = cfg.confidence as Obj | undefined;
  if (c && isNum(c.min) && isNum(c.max) && isNum(c.default) && (c.default < c.min || c.default > c.max || c.min >= c.max)) {
    p.push(`${f}: confidence needs min < max and min ≤ default ≤ max`);
  }
  const r = cfg.rating as Obj | undefined;
  if (r && isNum(r.min) && isNum(r.max) && r.min >= r.max) p.push(`${f}: rating.min must be below rating.max`);
}

/** Every **bold** marker in the text files must be closed. */
function checkBold(value: unknown, where: string, p: string[]) {
  if (typeof value === 'string') {
    if ((value.match(/\*\*/g) ?? []).length % 2 !== 0) p.push(`${where}: unclosed ** (bold) marker in "${value}"`);
  } else if (Array.isArray(value)) value.forEach((v, i) => checkBold(v, `${where}[${i}]`, p));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) checkBold(v, `${where}.${k}`, p);
}

/** Validates the raw JSON and returns it typed. Throws ContentError listing every problem. */
export function validateContent(raw: {
  questions: unknown;
  ui: unknown;
  feedback: unknown;
  packs: unknown;
  config: unknown;
}): Content {
  const p: string[] = [];
  checkConfig(raw.config, p);
  checkQuestions(raw.questions, raw.config, p);
  checkUi(raw.ui, raw.config, p);
  checkFeedback(raw.feedback, p);
  checkPacks(raw.packs, p);
  checkBold(raw.ui, 'ui-text.json', p);
  checkBold(raw.feedback, 'feedback.json', p);
  if (p.length) throw new ContentError(p);

  const questions = raw.questions as QuestionsFile;
  const byId: Record<string, Question> = {};
  for (const q of questions.questions) byId[q.id] = q;
  return {
    questions,
    ui: raw.ui as UiText,
    feedback: raw.feedback as FeedbackFile,
    packs: raw.packs as PacksFile,
    config: raw.config as ConfigFile,
    byId,
  };
}
