import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/content';
import { beatsPct, counterId, gapLabel, nextBlockOrder, nextGroup, stratumKey } from '../src/lib/assignment';
import { blockMeasures, computeDerived, spearman } from '../src/lib/derived';
import { buildFeedback, chooseStrong, chooseWorkOn, questionFeedbackLines, reportTopicRow } from '../src/lib/feedback';
import { makeBlock } from '../src/lib/flow';
import type { Answer, BlockData, Profile } from '../src/lib/model';
import { fill, plain, slugTitle } from '../src/lib/util';
import { splitHtmlLines, highlightLines } from '../src/components/CodeBlock';
import { progressOf } from '../src/lib/steps';

const c = loadContent();

function seq(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

function answer(qid: string, correct: boolean, confidence = 75, timeMs = 20000): Answer {
  const q = c.byId[qid];
  return {
    qid, topic: q.topic, type: q.type, position: 1, optionOrder: q.options.map((o) => o.id),
    chosen: correct ? q.correct : q.options.find((o) => o.id !== q.correct)!.id,
    correct, confidence, timeMs, awayCount: 0, awayMs: 0, langAtAnswer: 'python', langSwitches: 0,
  };
}

function block(setId: 'S1' | 'S2', correctIds: string[], conf = 75, scoreGuess: number | null = null): BlockData {
  const answers = c.questions.sets[setId].map((id) => answer(id, correctIds.includes(id), conf));
  return { setId, startedAt: null, endedAt: null, plan: [], answers, score: answers.filter((a) => a.correct).length, scoreGuess };
}

const profile: Profile = { year: '3rd', platform: 'LeetCode', solvedCount: 120, streak: 7, ownPct: '25-50', language: 'python' };

describe('text helpers', () => {
  it('fills placeholders', () => {
    expect(fill('Question {n} of {total}', { n: 3, total: 6 })).toBe('Question 3 of 6');
    expect(fill('{x} stays', {})).toBe('{x} stays');
  });
  it('derives titles from slugs', () => {
    expect(slugTitle('top-k-frequent-elements')).toBe('Top K Frequent Elements');
  });
});

describe('block order counter', () => {
  it('pairs every random draw with its opposite', () => {
    let counter = undefined as any;
    const values: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = nextBlockOrder(counter, seq([0.1, 0.9, 0.7]));
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
  });
});

describe('stratification', () => {
  it('labels the gap with the ±15 thresholds', () => {
    expect(gapLabel(15.1, c.config)).toBe('over');
    expect(gapLabel(15, c.config)).toBe('accurate');
    expect(gapLabel(-15.1, c.config)).toBe('under');
  });
  it('builds the stratum key (low = 3 or fewer of 6)', () => {
    expect(stratumKey('3rd', 3, 'over', c.config)).toBe('3rd_low_over');
    expect(stratumKey('final', 4, 'under', c.config)).toBe('final_high_notover');
  });
  it('prefixes pilot counters', () => {
    expect(counterId('blockOrder', true, c.config)).toBe('pilot_blockOrder');
    expect(counterId('S1', false, c.config)).toBe('S1');
  });
});

describe('beats %', () => {
  it('counts earlier participants below the score', () => {
    expect(beatsPct([0, 0, 0, 0, 0, 0, 0], 5, 50)).toBe(50);
    expect(beatsPct([1, 1, 1, 1, 0, 0, 0], 4, 50)).toBe(100);
    expect(beatsPct([1, 1, 1, 1, 0, 0, 0], 2, 50)).toBe(50);
  });
});

describe('derived measures', () => {
  it('computes gap, Brier score, resolution and topic accuracy', () => {
    const b = block('S1', ['S1-01', 'S1-02', 'S1-03'], 75, 5);
    b.answers[0].confidence = 100; // S1-01 right
    b.answers[5].confidence = 25; // S1-06 wrong
    const m = blockMeasures(b, c);
    expect(m.score).toBe(3);
    expect(m.meanConf).toBeCloseTo(425 / 6, 3);
    expect(m.confGap).toBeCloseTo(425 / 6 - 50, 3);
    expect(m.brier).toBeCloseTo(1.3125 / 6, 4); // 0 + .0625 + .0625 + .5625 + .5625 + .0625
    expect(m.scoreGap).toBe(2);
    expect(m.topicAcc).toEqual({ arrays: 1, window: 0.5, dp: 0 });
    expect(m.resolution).toBeCloseTo(250 / 3 - 175 / 3, 3); // right: 100,75,75 / wrong: 75,75,25
  });
  it('has null resolution when every answer is right', () => {
    expect(blockMeasures(block('S1', c.questions.sets.S1), c).resolution).toBeNull();
  });
  it('a pure guess (25%) on a 4-option question is perfectly calibrated on average', () => {
    const b = block('S2', ['S2-01'], 25); // 1 of 6 right… close to the 25% chance rate
    expect(blockMeasures(b, c).confGap).toBeCloseTo(25 - 100 / 6, 3);
  });
  it('Spearman correlation handles ties and no spread', () => {
    expect(spearman([1, 2, 3], [10, 20, 30])).toBe(1);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(spearman([4, 4, 4], [0, 0.5, 1])).toBeNull();
    expect(spearman([1, 2, 2], [0, 1, 1])).toBe(1);
  });
  it('topic alignment, belief change, pack choice and quality flags', () => {
    const b1 = block('S1', ['S1-01', 'S1-02', 'S1-03']); // arrays 2/2, window 1/2, dp 0/2
    b1.answers.forEach((a, i) => (a.timeMs = i < 5 ? 1000 : 20000)); // 5 fast answers
    b1.answers[0].awayCount = 1;
    const d = computeDerived(
      {
        block1: b1,
        ratingStart: { arrays: 6, window: 4, dp: 2 },
        beliefStart: 6,
        scoreGuessStart: 5,
        endSurvey: { beliefEnd: 3, judgedBy: 'numbers', serious: false },
        packTopic: 'dp',
      },
      c,
    );
    expect(d.ratingAlign1).toBe(1);
    expect(d.beliefChange).toBe(-3);
    expect(d.scoreGapStart).toBe(2);
    expect(d.packIsWeakest).toBe(true);
    expect(d.fastAnswers).toBe(5);
    expect(d.awayAnswers).toBe(1);
    expect(d.qualityFlags).toEqual(['notSerious', 'fast']);
    expect(d.gapLabel1).toBe('over'); // 75% sure, 50% right
  });
});

describe('Block 1 feedback', () => {
  it('Strong comes from the most accurate topic, Next from the least', () => {
    const b = block('S1', ['S1-01', 'S1-02', 'S1-03']); // arrays 2/2, window 1/2, dp 0/2
    for (let i = 0; i < 20; i++) {
      expect(chooseStrong(b.answers, c, Math.random)!.topic).toBe('arrays');
      expect(chooseWorkOn(b.answers, c, Math.random)!.topic).toBe('dp');
    }
  });
  it('Group B gets the topic breakdown, a strength and one next step, stored without ** markers', () => {
    const fb = buildFeedback({ block: 1, group: 'B', answers: block('S1', ['S1-01', 'S1-02', 'S1-03']).answers, beatsPct: 40, profile, sessionCorrect: 3, rng: Math.random }, c);
    expect(fb.topicCorrect).toEqual({ arrays: 2, window: 1, dp: 0 });
    expect(fb.topicRow).toEqual({ arrays: '✔', window: '△', dp: '✘' });
    expect(fb.strong!.text).toMatch(/^✔ Strong: Arrays & Hashing, /);
    expect(fb.workOn!.text).toMatch(/^→ Next: Dynamic Programming, /);
    expect(fb.tip).toBeTruthy();
    expect(fb.linesShown).toContain('✔ Arrays 2/2');
    expect(fb.linesShown.join(' ')).not.toContain('**');
    expect(fb.profileLine).toBe('Profile: 120 + 3 solved · 7-day streak');
  });
  it('shows the "none" lines for all-right and all-wrong blocks', () => {
    const allRight = buildFeedback({ block: 1, group: 'B', answers: block('S2', c.questions.sets.S2).answers, beatsPct: 50, profile, sessionCorrect: 6, rng: Math.random }, c);
    expect(allRight.workOn).toBeNull();
    expect(allRight.tip).toBeNull();
    expect(allRight.linesShown).toContain(plain(c.feedback.lines.workOnNone));
    const allWrong = buildFeedback({ block: 1, group: 'B', answers: block('S2', []).answers, beatsPct: 50, profile, sessionCorrect: 0, rng: Math.random }, c);
    expect(allWrong.strong).toBeNull();
    expect(allWrong.topicRow).toEqual({ arrays: '✘', window: '✘', dp: '✘' });
  });
  it('Group A gets the numbers only', () => {
    const fb = buildFeedback({ block: 1, group: 'A', answers: block('S1', ['S1-01']).answers, beatsPct: 40, profile: { ...profile, streak: 0 }, sessionCorrect: 1, rng: Math.random }, c);
    expect(fb.strong).toBeNull();
    expect(fb.workOn).toBeNull();
    expect(fb.topicRow).toBeNull();
    expect(fb.linesShown).toHaveLength(3);
    expect(fb.profileLine).toBe('Profile: 120 + 1 solved');
  });
});

describe('per-question feedback (Block 2)', () => {
  it('gives everyone right/wrong and the running score', () => {
    const a1 = answer('S2-01', true);
    const a2 = answer('S2-04', false);
    expect(questionFeedbackLines(a2, [a1, a2], 'A', c)).toEqual(['✘ Not quite', '**1/2** right so far']);
  });
  it('adds the topic line (and the tip when wrong) for Group B, with bold focus words', () => {
    const wrong = answer('S2-05', false); // dp / trace
    expect(questionFeedbackLines(wrong, [wrong], 'B', c).slice(2)).toEqual([
      '→ Work on **Dynamic Programming**: filling the table',
      '**Write dp[0], dp[1], dp[2] … before answering.**',
    ]);
    const right = answer('S2-01', true); // arrays / complete
    expect(questionFeedbackLines(right, [right], 'B', c).slice(2)).toEqual(['✔ **Arrays & Hashing**: map lookups']);
  });
});

describe('report topic row', () => {
  it('uses the 3 / 2 thresholds over all 12 questions', () => {
    const answers = [...block('S1', ['S1-01', 'S1-02', 'S1-03']).answers, ...block('S2', ['S2-01', 'S2-03'] ).answers];
    // arrays 3/4 ✔, window 2/4 △, dp 0/4 ✘
    expect(reportTopicRow(answers, c)).toEqual({ arrays: '✔', window: '△', dp: '✘' });
  });
});

describe('block plan', () => {
  it('uses S1 first for order 12 and shuffles options', () => {
    const b = makeBlock(1, { blockOrder: '12' }, c);
    expect(b.setId).toBe('S1');
    expect([...b.plan.map((x) => x.qid)].sort()).toEqual([...c.questions.sets.S1].sort());
    for (const pq of b.plan) expect([...pq.optionOrder].sort()).toEqual(c.byId[pq.qid].options.map((o) => o.id).sort());
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
    expect(progressOf('consent', 0, 6)).toBe(0);
    expect(progressOf('block1', 3, 6)).toBeGreaterThan(progressOf('block1', 0, 6));
    expect(progressOf('thanks', 0, 6)).toBe(1);
  });
});
