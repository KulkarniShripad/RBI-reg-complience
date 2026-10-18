// The experiment's steps, in order (about 12 minutes in total). `currentStep` on the
// participant is the index into this list (and `currentStepName` the id), so once
// data collection has started never reorder or remove entries; only append.

export const STEPS = [
  'consent', // 0   consent + honesty request
  'profile', // 1   year, platform, solved count, streak, % on own, language
  'before', // 2    topic self-ratings, belief in the solved count, score prediction
  'block1', // 3    6 questions, no feedback (baseline)
  'block1End', // 4 "How many did you get right?"; Continue assigns the group
  'feedback1', // 5 feedback screen (Group A: numbers; Group B: numbers + topics + next step)
  'rateMid', // 6   topic self-ratings again
  'block2', // 7    6 matched questions, feedback after each one
  'block2End', // 8 "How many did you get right?"
  'endSurvey', // 9 belief again, what they used to judge, seriousness check
  'pack', // 10     practice-pack choice (a real choice)
  'report', // 11   personal report + debrief + withdraw
  'thanks', // 12
] as const;

export type StepId = (typeof STEPS)[number];

export const stepIndex = (id: StepId) => STEPS.indexOf(id);

/** Overall progress 0-1; each question counts as one screen. */
export function progressOf(step: StepId, answeredInBlock: number, perBlock: number): number {
  const weight = (s: StepId) => (s === 'block1' || s === 'block2' ? perBlock : s === 'thanks' ? 0 : 1);
  const total = STEPS.reduce((sum, s) => sum + weight(s), 0);
  const idx = stepIndex(step);
  let done = 0;
  for (let i = 0; i < idx; i++) done += weight(STEPS[i]);
  if (step === 'block1' || step === 'block2') done += answeredInBlock;
  return step === 'thanks' ? 1 : done / total;
}
