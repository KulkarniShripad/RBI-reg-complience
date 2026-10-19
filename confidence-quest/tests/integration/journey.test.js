import { beforeEach, describe, expect, it } from 'vitest';
import { ANSWER_KEY, allKeys, armOf, contentCopy, fullRun, makeApp, wrongLetter } from '../helpers.js';

// Block size 2 means participants 1 and 2 always land in different arms.
async function oneOfEach(app, content, options) {
  const a = await fullRun(app, content, options);
  const b = await fullRun(app, content, options);
  return { runs: [a, b] };
}

const GAME_KEYS = ['game', 'tokens', 'badges', 'leaderboard', 'rank', 'leaderboard_name'];
const KEY_LIKE = ['answer_key', 'answerKey', 'correct_option', 'correctOption', 'correct_answer', 'answer'];

let ctx;
beforeEach(() => {
  ctx = makeApp();
});

describe('full runs, both arms', () => {
  it('a Control run never receives any game field (leak hunt)', async () => {
    const { runs } = await oneOfEach(ctx.app, ctx.content);
    const control = runs.find((r) => armOf(ctx.db, r.code) === 'control');
    const experimental = runs.find((r) => armOf(ctx.db, r.code) === 'experimental');
    expect(control).toBeDefined();
    expect(experimental).toBeDefined();

    const controlKeys = new Set(control.p.log.flatMap((entry) => [...allKeys(entry.body)]));
    for (const k of GAME_KEYS) expect(controlKeys.has(k), `control saw "${k}"`).toBe(false);
    const expKeys = new Set(experimental.p.log.flatMap((entry) => [...allKeys(entry.body)]));
    expect(expKeys.has('game')).toBe(true);
  });

  it('no response in either arm ever contains the answer key or the arm label', async () => {
    const { runs } = await oneOfEach(ctx.app, ctx.content, { choose: (id) => wrongLetter(ANSWER_KEY[id]) });
    for (const run of runs) {
      for (const entry of run.p.log) {
        const keys = allKeys(entry.body);
        for (const k of [...KEY_LIKE, 'arm', 'is_correct', 'selected_option']) expect(keys.has(k), `saw "${k}"`).toBe(false);
        expect(entry.text).not.toMatch(/"(control|experimental)"/);
      }
      // Wrong answers say "Incorrect" and nothing about which option was right.
      for (const a of run.answers) expect(Object.keys(a).sort()).toEqual(
        armOf(ctx.db, run.code) === 'experimental'
          ? ['correct', 'expired', 'game', 'n', 'next', 'next_button', 'text']
          : ['correct', 'expired', 'n', 'next', 'next_button', 'text'],
      );
    }
  });

  it('all correct scores 9 and all wrong scores 0 in both arms', async () => {
    const right = await oneOfEach(ctx.app, ctx.content);
    for (const r of right.runs) expect(r.results.score.correct).toBe(9);
    const wrong = await oneOfEach(ctx.app, ctx.content, { choose: (id) => wrongLetter(ANSWER_KEY[id]) });
    for (const r of wrong.runs) expect(r.results.score.correct).toBe(0);
    const scores = ctx.db
      .prepare('SELECT p.participant_code, SUM(q.is_correct) AS s FROM question_responses q JOIN participants p ON p.id = q.participant_id GROUP BY p.id')
      .all();
    expect(scores.map((s) => s.s).sort()).toEqual([0, 0, 9, 9]);
  });

  it('the experimental arm sees tokens, the badge and a leaderboard of real participants', async () => {
    const { runs } = await oneOfEach(ctx.app, ctx.content);
    const exp = runs.find((r) => armOf(ctx.db, r.code) === 'experimental');
    expect(exp.answers.map((a) => a.game.tokens.earned)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    expect(exp.answers[8].game.badges.new.map((b) => b.key)).toEqual(['finisher']);
    expect(exp.results.game.tokens.total).toBe(18);
    expect(exp.results.game.leaderboard.rows).toHaveLength(1);
    expect(exp.results.game.leaderboard.rows[0]).toMatchObject({ rank: 1, value: 18, is_self: true });
    expect(exp.results.game.rank.lines[0]).toBe('You are ranked 1 of 1.');

    const events = ctx.db.prepare('SELECT type, key, value FROM gamification_events ORDER BY id').all();
    expect(events.filter((e) => e.type === 'tokens').reduce((s, e) => s + e.value, 0)).toBe(18);
    expect(events.filter((e) => e.type === 'badge')).toEqual([{ type: 'badge', key: 'finisher', value: 1 }]);
    expect(events.filter((e) => e.type === 'leaderboard_view')).toEqual([
      { type: 'leaderboard_view', key: 'rank', value: 1 },
      { type: 'leaderboard_view', key: 'pool_size', value: 1 },
    ]);
  });

  it('the leaderboard grows with real finishers only and ranks them', async () => {
    const runs = [];
    for (let i = 0; i < 6; i++) {
      // Participant i gets i questions wrong.
      runs.push(await fullRun(ctx.app, ctx.content, { choose: (id, n) => (n <= i ? wrongLetter(ANSWER_KEY[id]) : ANSWER_KEY[id]) }));
    }
    const exp = runs.filter((r) => armOf(ctx.db, r.code) === 'experimental');
    expect(exp).toHaveLength(3);
    const last = exp.at(-1).results.game.leaderboard;
    expect(last.rows).toHaveLength(3);
    expect(last.rows.map((r) => r.value)).toEqual([...last.rows.map((r) => r.value)].sort((a, b) => b - a));
    const names = ctx.db.prepare("SELECT leaderboard_name FROM participants WHERE arm = 'experimental'").all().map((r) => r.leaderboard_name);
    expect(new Set(last.rows.map((r) => r.name))).toEqual(new Set(names));
    // Control participants never get a leaderboard name.
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM participants WHERE arm = 'control' AND leaderboard_name IS NOT NULL").get().n).toBe(0);
  });

  it('experimental output follows gamification.json (changed points, rank switched off)', async () => {
    const dir = contentCopy({
      'gamification.json': (g) => {
        g.tokens.points_by_difficulty = { Easy: 10, Medium: 10, Hard: 10 };
        g.rank.show = 'none';
        g.leaderboard.enabled = false;
      },
    });
    const custom = makeApp({ contentDir: dir });
    const { runs } = await oneOfEach(custom.app, custom.content);
    const exp = runs.find((r) => armOf(custom.db, r.code) === 'experimental');
    expect(exp.answers[0].game.tokens.earned).toBe(10);
    expect(exp.results.game.tokens.total).toBe(90);
    expect(exp.results.game).not.toHaveProperty('leaderboard');
    expect(exp.results.game).not.toHaveProperty('rank');
  });

  it('instructions differ only by the one extra line for the experimental arm', async () => {
    const { runs } = await oneOfEach(ctx.app, ctx.content);
    const instructionsOf = (run) => run.p.log.find((e) => e.body?.state?.step === 'INSTRUCTIONS').body.state.instructions.paragraphs;
    const control = instructionsOf(runs.find((r) => armOf(ctx.db, r.code) === 'control'));
    const exp = instructionsOf(runs.find((r) => armOf(ctx.db, r.code) === 'experimental'));
    expect(exp.slice(0, -1)).toEqual(control);
    expect(exp.at(-1)).toBe(ctx.content.gamification.instructions_extra);
  });

  it('questions are served in the fixed order Q1..Q9 to both arms', async () => {
    const { runs } = await oneOfEach(ctx.app, ctx.content);
    for (const run of runs) {
      const ids = run.p.log.filter((e) => e.body?.prompt !== undefined && e.body?.options).map((e) => e.body.id);
      expect(ids).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']);
    }
  });
});
