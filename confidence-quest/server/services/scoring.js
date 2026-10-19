import { DONT_KNOW, OPTION_KEYS } from './content.js';

export function allowedOptions(study) {
  return study.questions.dont_know_option.enabled ? [...OPTION_KEYS, DONT_KNOW] : OPTION_KEYS;
}

// The only place the answer key is compared. The key never leaves the server.
export function isCorrect(answerKey, questionId, selectedOption) {
  return answerKey[questionId] === selectedOption;
}

// Raw score: number of correct answers, 0 to the number of questions.
export function scoreRaw(responses) {
  return responses.reduce((sum, r) => sum + (r.is_correct === 1 ? 1 : 0), 0);
}
