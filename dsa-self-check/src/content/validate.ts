// Startup validation of the content JSON. Collects every problem it finds and
// throws one error listing them all, so a broken edit is caught on the first
// page load (and by `npm test`) instead of halfway through a participant's session.

import {
  LANG_IDS,
  SET_IDS,
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

/** Topic ids from ui-text.json → topics (empty if malformed; checkUi reports that). */
function topicIds(ui: unknown): string[] {
  const list = get(ui, 'topics');
  return Array.isArray(list) ? list.filter(isObj).map((t) => t.id).filter(isStr) : [];
}

function checkQuestions(q: unknown, cfg: unknown, fb: unknown, topics: string[], p: string[]) {
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
    if (!topics.includes(raw.topic as string)) p.push(`${at}: "topic" must be one of ui-text.json → topics (${topics.join(', ')})`);
    else if (!isObj(get(fb, `templates.${String(raw.topic)}.${String(raw.type)}`))) {
      p.push(`${at}: feedback.json has no templates.${String(raw.topic)}.${String(raw.type)} for this question's topic and type`);
    }
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
    const shapes: string[] = [];
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
      const shape: string[] = [];
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
        shape.push(`${String(qq.topic)}/${String(qq.type)}`);
      }
      shapes.push(shape.sort().join(','));
      // The topic rows (✔ / △ / ✘) assume the same number of questions per topic in each block.
      if (isNum(perBlock) && perBlock === ids.length && topics.length && perBlock % topics.length === 0) {
        const per = perBlock / topics.length;
        for (const t of topics) {
          if ((topicCount[t] ?? 0) !== per) p.push(`${f}: sets.${s} should have ${per} "${t}" questions, has ${topicCount[t] ?? 0}`);
        }
      } else if (isNum(perBlock) && topics.length && perBlock % topics.length !== 0) {
        p.push(`${f}: config.questionsPerBlock (${perBlock}) must be a multiple of the number of topics (${topics.length})`);
      }
    }
    // Block 1 and Block 2 are compared, so both sets must have the same topic × type mix.
    if (shapes.length === 2 && shapes[0] !== shapes[1]) p.push(`${f}: sets S1 and S2 must have the same topic/type mix (matched sets)`);
  }
}

const UI_STRINGS = [
  'consent.title', 'consent.body', 'consent.points', 'consent.honesty', 'consent.checkbox', 'consent.button', 'consent.alreadyDone',
  'profile.title', 'profile.year.label', 'profile.platform.label', 'profile.solvedCount', 'profile.streak',
  'profile.ownPct.label', 'profile.language.label',
  'before.title', 'before.ratingQ', 'before.low', 'before.high', 'before.belief', 'before.beliefLow', 'before.beliefHigh', 'before.scoreGuess',
  'rateAgain.title', 'rateAgain.sub',
  'question.counter', 'question.confidence', 'question.button',
  'questionFeedback.correct', 'questionFeedback.wrong', 'questionFeedback.soFar', 'questionFeedback.button',
  'blockEnd.scoreGuess',
  'endSurvey.title', 'endSurvey.judgedBy.text', 'endSurvey.serious.text',
  'pack.title', 'pack.sub', 'pack.topicLabel', 'pack.easy', 'pack.medium',
  'report.title', 'report.blockLine', 'report.topicsTitle', 'report.legend', 'report.packTitle',
  'report.aboutTitle', 'report.about', 'report.withdraw', 'report.withdrawn',
  'thanks', 'saving', 'leaveWarning',
];

const UI_ID_LISTS = [
  'profile.year.options',
  'profile.ownPct.options',
  'profile.language.options',
  'topics',
  'endSurvey.judgedBy.options',
  'endSurvey.serious.options',
];

function checkUi(ui: unknown, cfg: unknown, p: string[]) {
  const f = 'ui-text.json';
  if (!isObj(ui)) return p.push(`${f}: not an object`);
  for (const path of UI_STRINGS) if (!isStr(get(ui, path))) p.push(`${f}: "${path}" must be a non-empty string`);
  for (const path of UI_ID_LISTS) {
    const list = get(ui, path);
    if (!Array.isArray(list) || list.length === 0) {
      p.push(`${f}: "${path}" must be a non-empty array`);
      continue;
    }
    list.forEach((it, i) => {
      if (!isObj(it) || !isStr(it.id) || !isStr(it.label)) p.push(`${f}: ${path}[${i}] needs "id" and "label"`);
    });
  }
  const platforms = get(ui, 'profile.platform.options');
  if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every(isStr)) {
    p.push(`${f}: "profile.platform.options" must be a non-empty array of strings`);
  }
  const langIds = (get(ui, 'profile.language.options') as Obj[] | undefined)?.map((o) => o?.id) ?? [];
  for (const l of LANG_IDS) if (!langIds.includes(l)) p.push(`${f}: profile.language.options is missing "${l}"`);
  const serious = (get(ui, 'endSurvey.serious.options') as Obj[] | undefined)?.map((o) => o?.id) ?? [];
  for (const id of ['yes', 'no']) if (!serious.includes(id)) p.push(`${f}: endSurvey.serious.options needs ids "yes" and "no"`);
  const levels = get(ui, 'question.confLevels');
  const cfgLevels = get(cfg, 'confidence.levels');
  if (!Array.isArray(levels) || !levels.every(isStr)) p.push(`${f}: "question.confLevels" must be a list of labels`);
  else if (Array.isArray(cfgLevels) && levels.length !== cfgLevels.length) {
    p.push(`${f}: "question.confLevels" has ${levels.length} labels but config.confidence.levels has ${cfgLevels.length} values`);
  }
}

function checkFeedback(fb: unknown, topics: string[], p: string[]) {
  const f = 'feedback.json';
  if (!isObj(fb)) return p.push(`${f}: not an object`);
  for (const t of topics) {
    if (!isStr(get(fb, `topics.${t}.name`))) p.push(`${f}: "topics.${t}.name" is missing`);
    if (!isStr(get(fb, `topics.${t}.short`))) p.push(`${f}: "topics.${t}.short" is missing`);
    const tmpl = get(fb, `templates.${t}`);
    if (!isObj(tmpl)) p.push(`${f}: "templates.${t}" is missing`);
    else {
      for (const [ty, v] of Object.entries(tmpl)) {
        if (!isStr(get(v, 'skill'))) p.push(`${f}: "templates.${t}.${ty}.skill" is missing`);
        if (!isStr(get(v, 'tip'))) p.push(`${f}: "templates.${t}.${ty}.tip" is missing`);
      }
    }
  }
  for (const s of ['strong', 'mid', 'weak']) if (!isStr(get(fb, `symbols.${s}`))) p.push(`${f}: "symbols.${s}" is missing`);
  for (const k of ['title', 'score', 'profile', 'profileNoStreak', 'byTopic', 'topicCount', 'strong', 'workOn', 'tip', 'strongNone', 'workOnNone', 'qRight', 'qWrong']) {
    if (!isStr(get(fb, `lines.${k}`))) p.push(`${f}: "lines.${k}" is missing`);
  }
}

function checkPacks(packs: unknown, topics: string[], p: string[]) {
  const f = 'packs.json';
  if (!isObj(packs)) return p.push(`${f}: not an object`);
  for (const kind of ['easy', 'medium']) {
    for (const t of topics) {
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
  'questionsPerBlock', 'rating.min', 'rating.max', 'feedbackMinSeconds', 'gapLabel.overAbove', 'gapLabel.underBelow',
  'stratification.scoreBandLowMax', 'fastAnswerMs', 'quality.maxFastAnswers', 'quality.maxAwayAnswers', 'beatsPctFallback',
  'report.topicStrongMin', 'report.topicMidMin', 'feedbackTopicRow.strong', 'feedbackTopicRow.mid',
  'profileLimits.solvedCountMax', 'profileLimits.streakMax',
];

function checkConfig(cfg: unknown, p: string[]) {
  const f = 'config.json';
  if (!isObj(cfg)) return p.push(`${f}: not an object`);
  for (const k of CONFIG_NUMBERS) if (!isNum(get(cfg, k))) p.push(`${f}: "${k}" must be a number`);
  for (const k of ['appVersion', 'studyName', 'pilotPrefix']) {
    if (!isStr(get(cfg, k))) p.push(`${f}: "${k}" must be a non-empty string`);
  }
  if (!LANG_IDS.includes(cfg.defaultLanguage as never)) p.push(`${f}: "defaultLanguage" must be one of ${LANG_IDS.join(', ')}`);
  const levels = get(cfg, 'confidence.levels');
  if (!Array.isArray(levels) || levels.length < 2 || !levels.every((v) => isNum(v) && v >= 0 && v <= 100)) {
    p.push(`${f}: "confidence.levels" must be a list of at least 2 percentages, e.g. [25, 50, 75, 100]`);
  } else if (levels.some((v, i) => i > 0 && v <= levels[i - 1])) p.push(`${f}: "confidence.levels" must go up`);
  const qfb = cfg.questionFeedbackBlocks;
  if (!Array.isArray(qfb) || !qfb.every((b) => b === 1 || b === 2)) p.push(`${f}: "questionFeedbackBlocks" must be a list of block numbers (1, 2), e.g. [2] or []`);
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
  const topics = topicIds(raw.ui);
  checkConfig(raw.config, p);
  checkUi(raw.ui, raw.config, p);
  checkQuestions(raw.questions, raw.config, raw.feedback, topics, p);
  checkFeedback(raw.feedback, topics, p);
  checkPacks(raw.packs, topics, p);
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
    topics,
  };
}
