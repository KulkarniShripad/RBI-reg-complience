import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContentError, loadContent } from '../../server/services/content.js';
import { itemsForPhase } from '../../server/services/surveyScoring.js';
import { compareWithAppendix, loadAppendix } from '../../scripts/lib/appendix.js';
import { CONTENT_DIR, contentCopy } from '../helpers.js';

const problemsFor = (dir) => {
  try {
    loadContent(dir);
    return [];
  } catch (err) {
    if (err instanceof ContentError) return err.problems;
    throw err;
  }
};

describe('content files', () => {
  it('load and validate', () => {
    const content = loadContent(CONTENT_DIR);
    expect(content.questions).toHaveLength(9);
    expect(Object.keys(content.answerKey)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']);
  });

  it('questions.json and answer_key.json match Appendix A exactly', () => {
    const content = loadContent(CONTENT_DIR);
    expect(compareWithAppendix(content)).toEqual([]);
    const source = loadAppendix(CONTENT_DIR);
    expect(source.questions).toHaveLength(9);
    expect(source.answerKey).toEqual({ Q1: 'D', Q2: 'C', Q3: 'A', Q4: 'B', Q5: 'D', Q6: 'A', Q7: 'B', Q8: 'C', Q9: 'D' });
    for (const [i, q] of source.questions.entries()) {
      const json = content.questions[i];
      expect({ ...json, options_format: undefined }).toEqual({ ...q, options_format: undefined });
    }
  });

  it('keeps code whitespace exactly (indentation and trailing comment)', () => {
    const q6 = loadContent(CONTENT_DIR).questionsById.Q6;
    expect(q6.code).toContain('\n        a[mid], a[hi] = a[hi], a[mid]; hi -= 1; mid += 1   # bug\n');
  });

  it('a silent edit to a question is caught', () => {
    const dir = contentCopy({
      'questions.json': (json) => {
        json.questions[4].options[1].text = '[[-2, 0, 2]] ';
      },
    });
    expect(compareWithAppendix(loadContent(dir))).toEqual([expect.stringContaining('Q5.options.B')]);
  });

  it('pre and post use the same confidence items and wording', () => {
    const { survey } = loadContent(CONTENT_DIR);
    const conf = (phase) => itemsForPhase(survey, phase).filter((i) => i.measure === 'confidence').map((i) => `${i.id}:${i.text}`);
    expect(conf('pre')).toEqual(conf('post'));
    expect(conf('pre').length).toBeGreaterThan(0);
  });

  it('fails if a confidence item is only asked in one phase', () => {
    const dir = contentCopy({
      'survey.json': (json) => {
        json.items[1].phases = ['post'];
      },
    });
    expect(problemsFor(dir)).toEqual([expect.stringMatching(/^survey\.json: items\[1\]\.phases: .*both "pre" and "post"/)]);
  });

  it('names the file and field for each kind of problem', () => {
    const missing = contentCopy();
    fs.rmSync(path.join(missing, 'gamification.json'));
    expect(problemsFor(missing)).toEqual([expect.stringMatching(/^gamification\.json: file is missing/)]);

    const badJson = contentCopy();
    fs.writeFileSync(path.join(badJson, 'study.json'), '{ not json');
    expect(problemsFor(badJson)).toEqual([expect.stringMatching(/^study\.json: not valid JSON/)]);

    const badKey = contentCopy({ 'answer_key.json': (json) => ({ ...json, Q3: 'E' }) });
    expect(problemsFor(badKey)).toEqual([expect.stringMatching(/^answer_key\.json: Q3: /)]);

    const missingAnswer = contentCopy({
      'answer_key.json': (json) => {
        delete json.Q9;
      },
    });
    expect(problemsFor(missingAnswer)).toEqual(['answer_key.json: Q9: missing answer for question Q9']);

    const badScale = contentCopy({
      'survey.json': (json) => {
        json.default_scale.max = 'seven';
      },
    });
    expect(problemsFor(badScale)).toEqual([expect.stringMatching(/^survey\.json: default_scale\.max: /)]);

    const badBadge = contentCopy({
      'gamification.json': (json) => {
        json.badges.definitions[0].criteria = { type: 'speed_demon', gte: 1 };
      },
    });
    expect(problemsFor(badBadge)).toEqual([expect.stringMatching(/^gamification\.json: badges\.definitions\.0\.criteria\.type: /)]);

    const badSection = contentCopy({
      'gamification.json': (json) => {
        json.badges.definitions.push({ key: 'arrays', name: 'Arrays', criteria: { type: 'section_all_correct', section: 'Graphs' } });
      },
    });
    expect(problemsFor(badSection)).toEqual([expect.stringMatching(/badges\.definitions\[1\]\.criteria\.section: no section called "Graphs"/)]);

    const oddBlock = contentCopy({
      'study.json': (json) => {
        json.allocation.block_size = 3;
      },
    });
    expect(problemsFor(oddBlock)).toEqual([expect.stringMatching(/^study\.json: allocation\.block_size: must be an even number/)]);
  });

  it('warns while texts and rules are still placeholders', () => {
    const { warnings } = loadContent(CONTENT_DIR);
    expect(warnings.join('\n')).toMatch(/D9/);
    expect(warnings.join('\n')).toMatch(/D4-D7/);
  });
});
