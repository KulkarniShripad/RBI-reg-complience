import { describe, expect, it } from 'vitest';
import questions from '../src/content/questions.json';
import ui from '../src/content/ui-text.json';
import feedback from '../src/content/feedback.json';
import packs from '../src/content/packs.json';
import config from '../src/content/config.json';
import { ContentError, validateContent } from '../src/content/validate';
import { LANG_IDS } from '../src/content/types';

const raw = () => structuredClone({ questions, ui, feedback, packs, config }) as Record<string, any>;

function problems(mutate: (r: Record<string, any>) => void): string[] {
  const r = raw();
  mutate(r);
  try {
    validateContent(r as never);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ContentError);
    return (e as ContentError).problems;
  }
}

const qIndex = (id: string) => (questions.questions as { id: string }[]).findIndex((q) => q.id === id);

describe('content files', () => {
  it('the shipped content is valid', () => {
    const c = validateContent(raw() as never);
    expect(Object.keys(c.byId)).toHaveLength(12);
    expect(c.topics).toEqual(['arrays', 'window', 'dp']);
  });

  it('every code snippet and per-language option has python, cpp and java', () => {
    const c = validateContent(raw() as never);
    for (const q of c.questions.questions) {
      if (q.code) for (const l of LANG_IDS) expect(q.code[l]).toBeTruthy();
      for (const o of q.options) if (typeof o.text !== 'string') for (const l of LANG_IDS) expect(o.text[l]).toBeTruthy();
    }
  });

  it('every fill-the-blank question shows the blank exactly once in every language', () => {
    const c = validateContent(raw() as never);
    for (const q of c.questions.questions.filter((q) => q.type === 'complete')) {
      for (const l of LANG_IDS) expect(q.code![l].split(c.questions.blank)).toHaveLength(2);
    }
  });

  it('keeps questions short (at most 11 code lines, stems under 140 characters)', () => {
    const c = validateContent(raw() as never);
    for (const q of c.questions.questions) {
      expect(q.stem.length).toBeLessThan(140);
      if (q.code) for (const l of LANG_IDS) expect(q.code[l].split('\n').length).toBeLessThanOrEqual(11);
    }
  });

  it('fails when a set lists an unknown question', () => {
    expect(problems((r) => (r.questions.sets.S1[0] = 'S9-99')).join('\n')).toMatch(/S9-99/);
  });

  it('fails when "correct" matches no option id', () => {
    expect(problems((r) => (r.questions.questions[0].correct = 'z')).join('\n')).toMatch(/correct/);
  });

  it('fails when a code language is missing', () => {
    expect(problems((r) => delete r.questions.questions[0].code.java).join('\n')).toMatch(/code\.java/);
  });

  it('fails when a per-language option text misses a language', () => {
    expect(problems((r) => delete r.questions.questions[qIndex('S2-01')].options[0].text.cpp).join('\n')).toMatch(/option "a"/);
  });

  it('fails when a ui string is missing', () => {
    expect(problems((r) => delete r.ui.question.counter).join('\n')).toMatch(/question\.counter/);
  });

  it('fails when a question has no feedback template for its topic and type', () => {
    expect(problems((r) => delete r.feedback.templates.dp.trace).join('\n')).toMatch(/templates\.dp\.trace/);
  });

  it('fails when a config number is not a number', () => {
    expect(problems((r) => (r.config.feedbackMinSeconds = '8')).join('\n')).toMatch(/feedbackMinSeconds/);
  });

  it('fails when a question uses a topic that is not in ui-text topics', () => {
    expect(problems((r) => (r.questions.questions[0].topic = 'graphs')).join('\n')).toMatch(/topic/);
  });

  it('fails when the two sets are not matched on topic and type', () => {
    expect(problems((r) => (r.questions.questions[qIndex('S2-05')].type = 'complete')).join('\n')).toMatch(/matched sets/);
  });

  it('fails when a **bold** marker is not closed', () => {
    expect(problems((r) => (r.feedback.lines.tip = '**{tip}')).join('\n')).toMatch(/unclosed \*\*/);
  });

  it('fails when questionFeedbackBlocks is not a list of block numbers', () => {
    expect(problems((r) => (r.config.questionFeedbackBlocks = [3])).join('\n')).toMatch(/questionFeedbackBlocks/);
  });

  it('fails when the confidence labels do not match the levels', () => {
    expect(problems((r) => r.ui.question.confLevels.pop()).join('\n')).toMatch(/confLevels/);
  });
});
