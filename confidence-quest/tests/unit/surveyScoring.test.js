import { describe, expect, it } from 'vitest';
import { confidenceMean, scoredValue, validateSurveySubmission } from '../../server/services/surveyScoring.js';

const survey = {
  default_scale: { min: 1, max: 7, labels: {} },
  items: [
    { id: 'a', measure: 'confidence', phases: ['pre', 'post'], reverse: false, enabled: true, text: 'A' },
    { id: 'b', measure: 'confidence', phases: ['pre', 'post'], reverse: true, enabled: true, text: 'B' },
    { id: 'c', measure: 'enjoyment', phases: ['post'], reverse: false, enabled: true, text: 'C', scale: { min: 1, max: 5, labels: {} } },
    { id: 'off', measure: 'pressure', phases: ['post'], reverse: false, enabled: false, text: 'D' },
  ],
};
const item = (id) => survey.items.find((i) => i.id === id);

describe('survey scoring', () => {
  it('reverse-codes on the item scale', () => {
    expect(scoredValue(survey, item('b'), 2)).toBe(6);
    expect(scoredValue(survey, item('b'), 7)).toBe(1);
    expect(scoredValue(survey, item('a'), 2)).toBe(2);
  });

  it('confidence score is the mean after reverse-coding', () => {
    // a = 5, b = 3 reversed to 5 -> mean 5
    expect(confidenceMean(survey, 'pre', { a: 5, b: 3 })).toBe(5);
    expect(confidenceMean(survey, 'pre', { a: 4, b: 4 })).toBe(4);
  });

  it('gives conf_change of +1.0 for the illustration (4.0 pre, 5.0 post)', () => {
    const pre = confidenceMean(survey, 'pre', { a: 4, b: 4 });
    const post = confidenceMean(survey, 'post', { a: 5, b: 3 });
    expect(post - pre).toBe(1);
  });

  it('returns null when an item is missing', () => {
    expect(confidenceMean(survey, 'pre', { a: 4 })).toBeNull();
  });

  it('accepts a complete submission and ignores disabled items', () => {
    expect(validateSurveySubmission(survey, 'post', { a: 1, b: 7, c: 5 })).toEqual([
      { item_id: 'a', value: 1 },
      { item_id: 'b', value: 7 },
      { item_id: 'c', value: 5 },
    ]);
  });

  it('rejects a missing item', () => {
    expect(() => validateSurveySubmission(survey, 'pre', { a: 4 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(() => validateSurveySubmission(survey, 'pre', { a: 8, b: 4 })).toThrow(/outside the allowed range/);
    expect(() => validateSurveySubmission(survey, 'pre', { a: 0, b: 4 })).toThrow(/outside the allowed range/);
    expect(() => validateSurveySubmission(survey, 'post', { a: 4, b: 4, c: 6 })).toThrow(/1 to 5/);
    expect(() => validateSurveySubmission(survey, 'pre', { a: 4.5, b: 4 })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });

  it('rejects answers to items that are not in this phase', () => {
    expect(() => validateSurveySubmission(survey, 'pre', { a: 4, b: 4, c: 3 })).toThrow(/unknown statement/);
    expect(() => validateSurveySubmission(survey, 'post', { a: 4, b: 4, c: 3, off: 2 })).toThrow(/unknown statement/);
  });
});
