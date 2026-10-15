// The experiment's steps, in order. `currentStep` on the participant is the index
// into this list (and `currentStepName` the id), so never reorder or remove entries
// once data collection has started; only append.

export const STEPS = [
  'consent', // 0  Step 0
  'profile', // 1  Step 1
  'rateSelf', // 2  Step 2  → ratingStart
  'statements', // 3  Step 3
  'howItWorks', // 4  Step 4  (block order assigned on Begin)
  'block1', // 5  Step 5  8 questions
  'block1End', // 6         score/rank guess (group assigned on Continue, Step 6)
  'feedback1', // 7  Step 7
  'rateMid', // 8  Step 7b → ratingMid
  'block2', // 9  Step 8
  'block2End', // 10
  'feedback2', // 11 Step 9
  'rateEnd', // 12 Step 10 → ratingEnd
  'endRatings', // 13 Step 10 (PC, CF, SC, KN1, KN2, AC)
  'pack', // 14 Step 11
  'close', // 15 Step 12
  'report', // 16 Step 13
  'preference', // 17 Step 14
  'thanks', // 18
] as const;

export type StepId = (typeof STEPS)[number];

export const stepIndex = (id: StepId) => STEPS.indexOf(id);

/** Overall progress 0-1; each question counts as one screen, hidden steps count as none. */
export function progressOf(step: StepId, answeredInBlock: number, perBlock: number, hidden: StepId[] = []): number {
  const weight = (s: StepId) => (s === 'block1' || s === 'block2' ? perBlock : s === 'thanks' || hidden.includes(s) ? 0 : 1);
  const total = STEPS.reduce((sum, s) => sum + weight(s), 0);
  const idx = stepIndex(step);
  let done = 0;
  for (let i = 0; i < idx; i++) done += weight(STEPS[i]);
  if (step === 'block1' || step === 'block2') done += answeredInBlock;
  return step === 'thanks' ? 1 : done / total;
}
