import { AppError } from '../middleware/errors.js';

export function scaleOf(survey, item) {
  return item.scale ?? survey.default_scale;
}

export function itemsForPhase(survey, phase) {
  return survey.items.filter((item) => item.enabled && item.phases.includes(phase));
}

// Checks a full submission: every item answered, whole numbers in range, nothing extra.
// Returns [{ item_id, value }] or throws a VALIDATION error with a plain message.
export function validateSurveySubmission(survey, phase, answers, missingMessage = 'Please answer every statement.') {
  const items = itemsForPhase(survey, phase);
  const known = new Set(items.map((i) => i.id));
  for (const id of Object.keys(answers)) {
    if (!known.has(id)) throw new AppError('VALIDATION', 'The survey contained an answer to an unknown statement.');
  }
  return items.map((item) => {
    const value = answers[item.id];
    if (value === undefined || value === null) throw new AppError('VALIDATION', missingMessage);
    const { min, max } = scaleOf(survey, item);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AppError('VALIDATION', `An answer was outside the allowed range (${min} to ${max}).`);
    }
    return { item_id: item.id, value };
  });
}

export function scoredValue(survey, item, value) {
  const { min, max } = scaleOf(survey, item);
  return item.reverse ? min + max - value : value;
}

// Mean of one measure's items in one phase, after reverse-coding.
// `values` maps item_id -> raw value. Returns null if any item is missing.
export function measureMean(survey, measure, phase, values) {
  const items = itemsForPhase(survey, phase).filter((item) => item.measure === measure);
  if (!items.length) return null;
  let sum = 0;
  for (const item of items) {
    if (values[item.id] === undefined) return null;
    sum += scoredValue(survey, item, values[item.id]);
  }
  return sum / items.length;
}

export const confidenceMean = (survey, phase, values) => measureMean(survey, 'confidence', phase, values);
