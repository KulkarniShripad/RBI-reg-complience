import { describe, expect, it } from 'vitest';
import { loadContent } from '../../server/services/content.js';
import { allowedOptions, isCorrect, scoreRaw } from '../../server/services/scoring.js';
import { CONTENT_DIR, wrongLetter } from '../helpers.js';

const content = loadContent(CONTENT_DIR);
const { answerKey, questions } = content;
const responsesFor = (choose) =>
  questions.map((q) => ({ question_id: q.id, is_correct: isCorrect(answerKey, q.id, choose(q.id)) ? 1 : 0 }));

describe('scoring', () => {
  it('all correct letters score 9', () => {
    expect(scoreRaw(responsesFor((id) => answerKey[id]))).toBe(9);
  });

  it('all wrong letters score 0', () => {
    expect(scoreRaw(responsesFor((id) => wrongLetter(answerKey[id])))).toBe(0);
  });

  it('matches the worked example: D on Q1 is correct, B on Q5 is not', () => {
    expect(isCorrect(answerKey, 'Q1', 'D')).toBe(true);
    expect(isCorrect(answerKey, 'Q5', 'B')).toBe(false);
  });

  it("'I don't know' is never correct and is only allowed when switched on", () => {
    expect(isCorrect(answerKey, 'Q1', 'IDK')).toBe(false);
    expect(allowedOptions(content.study)).toEqual(['A', 'B', 'C', 'D']);
    const withIdk = { ...content.study, questions: { ...content.study.questions, dont_know_option: { enabled: true, label: 'x' } } };
    expect(allowedOptions(withIdk)).toEqual(['A', 'B', 'C', 'D', 'IDK']);
  });
});
