import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content';
import { beatsPct, counterId, gapLabel, nextBlockOrder, nextGroup, stratumKey } from '../src/lib/assignment';
import { blockMeasures, computeDerived } from '../src/lib/derived';
import { buildFeedback, chooseStrong, chooseWorkOn, questionFeedbackLines, reportTopicRow } from '../src/lib/feedback';
import { makeBlock } from '../src/lib/flow';
import type { Answer, BlockData } from '../src/lib/model';
import { fill, plain, slugTitle } from '../src/lib/util';
import { splitHtmlLines, highlightLines } from '../src/components/CodeBlock';
import { progressOf } from '../src/lib/steps';

const c = loadContent();

function seq(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

function answer(qid: string, correct: boolean, confidence = 50, timeMs = 10000): Answer {
  const q = c.byId[qid];
  return {
    qid, topic: q.topic, type: q.type, position: 1, optionOrder: q.options.map((o) => o.id),
    chosen: correct ? q.correct : q.options.find((o) => o.id !== q.correct)!.id,
    correct, confidence, timeMs, langAtAnswer: 'python', langSwitches: 0,
  };
}

function block(setId: 'S1' | 'S2', correctIds: string[], conf = 50, scoreGuess: number | null = null): BlockData {
  const answers = c.questions.sets[setId].map((id) => answer(id, correctIds.includes(id), conf));
  return { setId, startedAt: null, endedAt: null, plan: [], answers, score: answers.filter((a) => a.correct).length, scoreGuess, rankGuess: null };
}

describe('text helpers', () => {
  it('fills placeholders', () => {
    expect(fill('Question {n} of {total}', { n: 3, total: 8 })).toBe('Question 3 of 8');
    expect(fill('{x} stays', {})).toBe('{x} stays');
  });
  it('derives titles from slugs', () => {
    expect(slugTitle('top-k-frequent-elements')).toBe('Top K Frequent Elements');
    expect(slugTitle('3sum')).toBe('3sum');
  });
});

describe('block order counter', () => {
  it('pairs every random draw with its opposite', () => {
    let counter = undefined as any;
    const values: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = nextBlockOrder(counter, seq([0.1, 0.9, 0.7])); // varied draws
      counter = r.counter;
      values.push(r.value);
    }
    for (let i = 0; i < 10; i += 2) expect(values[i]).not.toBe(values[i + 1]);
    expect(counter.n).toBe(10);
    expect(values.filter((v) => v === '12')).toHaveLength(5);
  });
});

describe('group counter', () => {
  it('keeps A and B equal after every pair', () => {
    let counter = undefined as any;
    for (let i = 0; i < 9; i++) counter = nextGroup(counter, Math.random).counter;
    expect(Math.abs(counter.countA - counter.countB)).toBe(1);
    counter = nextGroup(counter, Math.random).counter;
    expect(counter.countA).toBe(counter.countB);
    expect(counter.n).toBe(10);
  });
});

describe('stratification', () => {
  it('labels the gap with the ±15 thresholds', () => {
    expect(gapLabel(15.1, c.config)).toBe('over');
    expect(gapLabel(15, c.config)).toBe('accurate');
    expect(gapLabel(-15, c.config)).toBe('accurate');
    expect(gapLabel(-15.1, c.config)).toBe('under');
  });
  it('builds the stratum key', () => {
    expect(stratumKey('3rd', 4, 'over', c.config)).toBe('3rd_low_over');
    expect(stratumKey('final', 5, 'under', c.config)).toBe('final_high_notover');
    expect(stratumKey('final', 5, 'accurate', c.config)).toBe('final_high_notover');
  });
  it('prefixes pilot counters', () => {
    expect(counterId('blockOrder', true, c.config)).toBe('pilot_blockOrder');
    expect(counterId('S1', false, c.config)).toBe('S1');
  });
});

describe('beats %', () => {
  it('counts earlier participants below the score', () => {
    expect(beatsPct([0, 0, 0, 0, 0, 0, 0, 0, 0], 5, 50)).toBe(50);
    expect(beatsPct([1, 1, 1, 1, 0, 0, 0, 0, 0], 4, 50)).toBe(100);
    expect(beatsPct([1, 1, 1, 1, 0, 0, 0, 0, 0], 2, 50)).toBe(50);
    expect(beatsPct([0, 0, 3, 0, 0, 0, 0, 0, 0], 2, 50)).toBe(0);
  });
});

describe('derived measures', () => {
  it('computes gap, resolution and topic accuracy', () => {
    const b = block('S1', ['S1-01', 'S1-02', 'S1-03', 'S1-04'], 70, 6);
    b.answers[0].confidence = 90; // S1-01 correct
    b.answers[7].confidence = 30; // S1-08 wrong
    const m = blockMeasures(b, c);
    expect(m.score).toBe(4);
    expect(m.meanConf).toBe(67.5); // (90 + 6×70 + 30) / 8
    expect(m.confGap).toBe(17.5); // 67.5 − 50% correct
    expect(m.scoreGap).toBe(2);
    expect(m.topicAcc.arrays).toBe(1);
    expect(m.topicAcc.window).toBe(1);
    expect(m.topicAcc.dp).toBe(0);
    expect(m.resolution).toBe(75 - 60); // correct: 90,70,70,70 / wrong: 70,70,70,30
  });
  it('has null resolution when every answer is right', () => {
    const m = blockMeasures(block('S1', c.questions.sets.S1), c);
    expect(m.resolution).toBeNull();
  });
  it('labels gapLabel1 and counts fast answers', () => {
    const b1 = block('S1', [], 80);
    b1.answers[0].timeMs = 1200;
    const d = computeDerived({ block1: b1, block2: null }, c);
    expect(d.confGap1).toBe(80);
    expect(d.gapLabel1).toBe('over');
    expect(d.fastAnswers).toBe(1);
    expect(d.languagesUsed).toEqual(['python']);
  });
});

describe('Group B feedback lines', () => {
  it('Strong comes from the most accurate topic, Work on from the least', () => {
    // arrays 2/2, window 1/2, recursion 1/2, dp 0/2
    const b = block('S1', ['S1-01', 'S1-02', 'S1-03', 'S1-05']);
    for (let i = 0; i < 20; i++) {
      expect(chooseStrong(b.answers, Math.random)!.topic).toBe('arrays');
      expect(chooseWorkOn(b.answers, Math.random)!.topic).toBe('dp');
    }
  });
  it('shows "none" lines for all-correct and all-wrong blocks', () => {
    const allRight = buildFeedback({ block: 1, group: 'B', answers: block('S2', c.questions.sets.S2).answers, beatsPct: 50, profile: null, sessionCorrect: 8, rng: Math.random }, c);
    expect(allRight.workOn).toBeNull();
    expect(allRight.tip).toBeNull();
    expect(allRight.linesShown).toContain(c.feedback.lines.workOnNone);
    const allWrong = buildFeedback({ block: 1, group: 'B', answers: block('S2', []).answers, beatsPct: 50, profile: null, sessionCorrect: 0, rng: Math.random }, c);
    expect(allWrong.strong).toBeNull();
    expect(allWrong.linesShown).toContain(c.feedback.lines.strongNone);
    expect(allWrong.topicRow).toEqual({ arrays: '✘', window: '✘', recursion: '✘', dp: '✘' });
  });
  it('fills the templates from the chosen question', () => {
    const b = block('S1', ['S1-01']); // only arrays/trace right
    const fb = buildFeedback({ block: 1, group: 'B', answers: b.answers, beatsPct: 40, profile: { year: '3rd', platform: 'LeetCode', solvedCount: 120, streak: 7, ownPct: 50, language: 'python' }, sessionCorrect: 1, rng: Math.random }, c);
    expect(fb.strong!.text).toBe('✔ Strong: Arrays & Hashing, tracking the map');
    expect(fb.profileLine).toBe('Profile: 120 + 1 solved · 7-day streak');
    expect(fb.topicRow).toEqual({ arrays: '△', window: '✘', recursion: '✘', dp: '✘' });
  });
  it('Group A gets numbers only', () => {
    const fb = buildFeedback({ block: 2, group: 'A', answers: block('S1', ['S1-01']).answers, beatsPct: 40, profile: { year: '3rd', platform: 'LeetCode', solvedCount: 10, streak: 0, ownPct: 50, language: 'cpp' }, sessionCorrect: 3, rng: Math.random }, c);
    expect(fb.strong).toBeNull();
    expect(fb.workOn).toBeNull();
    expect(fb.tip).toBeNull();
    expect(fb.topicRow).toBeNull();
    expect(fb.profileLine).toBe('Profile: 10 + 3 solved');
  });
});

describe('per-question feedback', () => {
  it('gives everyone right/wrong and the running score', () => {
    const a1 = answer('S2-01', true);
    const a2 = answer('S2-05', false);
    expect(questionFeedbackLines(a2, [a1, a2], 'A', c)).toEqual(['✘ Not quite', '**1 / 2** correct so far']);
    expect(questionFeedbackLines(a1, [a1], null, c)).toEqual(['✔ Correct', '**1 / 1** correct so far']);
  });
  it('adds the concept lines for Group B, with bold focus words', () => {
    const wrong = answer('S2-05', false); // recursion / debug
    const lines = questionFeedbackLines(wrong, [wrong], 'B', c);
    expect(lines.slice(2)).toEqual(['✘ Work on: **Recursion**, **undo order**', '→ Tip: **Undo a pick right after exploring with it.**']);
    expect(lines.map(plain)[2]).toBe('✘ Work on: Recursion, undo order');
    const right = answer('S2-01', true); // arrays / trace
    expect(questionFeedbackLines(right, [right], 'B', c).slice(2)).toEqual(['✔ Strong: **Arrays & Hashing**, **tracking the map**']);
  });
  it('stores feedback screen text without the bold markers', () => {
    const fb = buildFeedback({ block: 1, group: 'B', answers: block('S1', ['S1-01']).answers, beatsPct: 40, profile: null, sessionCorrect: 1, rng: Math.random }, c);
    expect(fb.linesShown.join(' ')).not.toContain('**');
    expect(fb.tip).not.toContain('**');
  });
});

describe('report topic row', () => {
  it('uses the 3 / 2 thresholds over all 16 questions', () => {
    const answers = [...block('S1', ['S1-01', 'S1-02', 'S1-03']).answers, ...block('S2', ['S2-01', 'S2-03', 'S2-04']).answers];
    // arrays 3/4 ✔, window 3/4 ✔ … recursion 0 ✘, dp 0 ✘
    expect(reportTopicRow(answers, c)).toEqual({ arrays: '✔', window: '✔', recursion: '✘', dp: '✘' });
  });
});

describe('block plan', () => {
  it('uses S1 first for order 12 and shuffles options', () => {
    const b = makeBlock(1, { blockOrder: '12' }, c);
    expect(b.setId).toBe('S1');
    expect([...b.plan.map((x) => x.qid)].sort()).toEqual([...c.questions.sets.S1].sort());
    for (const pq of b.plan) expect([...pq.optionOrder].sort()).toEqual(c.byId[pq.qid].options.map((o) => o.id).sort());
    expect(makeBlock(1, { blockOrder: '21' }, c).setId).toBe('S2');
    expect(makeBlock(2, { blockOrder: '21' }, c).setId).toBe('S1');
  });
});

describe('code highlighting', () => {
  it('keeps spans valid across line breaks', () => {
    expect(splitHtmlLines('<span class="a">x\ny</span>z')).toEqual(['<span class="a">x</span>', '<span class="a">y</span>z']);
  });
  it('marks the blank and keeps one entry per line', () => {
    for (const q of c.questions.questions.filter((q) => q.code)) {
      for (const l of ['python', 'cpp', 'java'] as const) {
        const lines = highlightLines(q.code![l], l, c.questions.blank);
        expect(lines).toHaveLength(q.code![l].split('\n').length);
        if (q.type === 'complete') expect(lines.join('\n')).toContain('class="code-blank"');
      }
    }
  });
});

describe('progress', () => {
  it('runs from 0 to 1', () => {
    expect(progressOf('consent', 0, 8)).toBe(0);
    expect(progressOf('block1', 4, 8)).toBeGreaterThan(progressOf('block1', 0, 8));
    expect(progressOf('thanks', 0, 8)).toBe(1);
    // a hidden step adds nothing: statements → block 1 is one step
    expect(progressOf('block1', 0, 8, ['howItWorks'])).toBe(progressOf('howItWorks', 0, 8, ['howItWorks']));
  });
});
