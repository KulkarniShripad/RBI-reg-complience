import { describe, expect, it } from 'vitest';
import { loadContent } from '../../server/services/content.js';
import { computeGameState, feedbackGame, finalGame, rankEntries } from '../../server/services/gamification.js';
import { CONTENT_DIR, wrongLetter } from '../helpers.js';

const content = loadContent(CONTENT_DIR);
const { questions, answerKey } = content;
const clone = (x) => JSON.parse(JSON.stringify(x));
const gam = () => clone(content.gamification);

const responses = (choose) =>
  questions.map((q, i) => {
    const option = choose(q.id, i + 1);
    return { question_id: q.id, position: i + 1, selected_option: option, is_correct: option === answerKey[q.id] ? 1 : 0 };
  });
const allCorrect = responses((id) => answerKey[id]);

describe('tokens and badges', () => {
  it('awards 1/2/3 by difficulty for correct answers (current config)', () => {
    const state = computeGameState(gam(), questions, allCorrect);
    expect(state.tokens_total).toBe(3 * (1 + 2 + 3));
    expect(state.steps.map((s) => s.tokens)).toEqual([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    expect(computeGameState(gam(), questions, responses((id) => wrongLetter(answerKey[id]))).tokens_total).toBe(0);
  });

  it('changes only when gamification.json changes', () => {
    const g = gam();
    g.tokens.points_by_difficulty = { Easy: 5, Medium: 5, Hard: 5 };
    expect(computeGameState(g, questions, allCorrect).tokens_total).toBe(45);
    g.tokens.award_on = 'any_answer';
    expect(computeGameState(g, questions, responses((id) => wrongLetter(answerKey[id]))).tokens_total).toBe(45);
    g.tokens.enabled = false;
    expect(computeGameState(g, questions, allCorrect).tokens_total).toBe(0);
  });

  it('the effort badge appears on the ninth answer, right or wrong', () => {
    const state = computeGameState(gam(), questions, responses((id) => wrongLetter(answerKey[id])));
    expect(state.steps.slice(0, 8).every((s) => s.new_badges.length === 0)).toBe(true);
    expect(state.steps[8].new_badges).toEqual(['finisher']);
    const fb = feedbackGame(gam(), state, 9);
    expect(fb.badges.new).toEqual([{ key: 'finisher', name: 'Finisher', description: 'Answered all nine questions' }]);
  });

  it('supports streak, count and section badge rules from config', () => {
    const g = gam();
    g.badges.definitions = [
      { key: 'streak3', name: 'Three in a row', description: '', criteria: { type: 'correct_streak', gte: 3 } },
      { key: 'five', name: 'Five right', description: '', criteria: { type: 'correct_count', gte: 5 } },
      { key: 'arrays', name: 'Arrays master', description: '', criteria: { type: 'section_all_correct', section: 'Arrays' } },
    ];
    const state = computeGameState(g, questions, allCorrect);
    const earnedAt = Object.fromEntries(state.steps.flatMap((s) => s.new_badges.map((b) => [b, s.position])));
    expect(earnedAt).toEqual({ streak3: 3, five: 5, arrays: 9 });
  });

  it('the feedback panel follows its show_* switches', () => {
    const g = gam();
    g.feedback_panel = { show_tokens_earned: false, show_total_tokens: true, show_new_badges: false };
    const fb = feedbackGame(g, computeGameState(g, questions, allCorrect), 2);
    expect(fb).toEqual({ tokens: { label: 'tokens', total: 3 } });
  });
});

describe('leaderboard', () => {
  const entry = (id, tokens, finishedAt, totalTime = 1000) => ({
    id,
    name: `Name ${id}`,
    tokens,
    score_raw: tokens,
    finished_at: finishedAt,
    total_time_ms: totalTime,
  });

  it('ranks by tokens and breaks ties by earlier finish', () => {
    const ranked = rankEntries(gam(), [entry('a', 10, '2026-10-19T10:05:00Z'), entry('b', 10, '2026-10-19T10:01:00Z'), entry('c', 12, '2026-10-19T10:09:00Z')]);
    expect(ranked.map((e) => [e.id, e.rank])).toEqual([['c', 1], ['b', 2], ['a', 3]]);
  });

  it('supports shared ranks and less-total-time tie-breaking', () => {
    const entries = [entry('a', 10, 't1', 900), entry('b', 10, 't2', 500), entry('c', 4, 't3', 100)];
    const shared = gam();
    shared.leaderboard.tie_break = 'shared';
    expect(rankEntries(shared, entries).map((e) => e.rank)).toEqual([1, 1, 3]);
    const time = gam();
    time.leaderboard.tie_break = 'less_total_time';
    expect(rankEntries(time, entries).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });

  it('shows the top N plus the viewer row, and rank/percentile text', () => {
    const entries = Array.from({ length: 8 }, (_, i) => entry(`p${i}`, 20 - i, `2026-10-19T10:0${i}:00Z`));
    const state = { tokens_total: 13, badges: ['finisher'] };
    const { game, rank, poolSize } = finalGame(gam(), state, entries, 'p7');
    expect(game.leaderboard.rows.map((r) => r.name)).toEqual(['Name p0', 'Name p1', 'Name p2', 'Name p3', 'Name p4']);
    expect(game.leaderboard.self_row).toEqual({ rank: 8, name: 'Name p7', value: 13, is_self: true });
    expect([rank, poolSize]).toEqual([8, 8]);
    expect(game.rank.lines).toEqual(['You are ranked 8 of 8.', 'That puts you in the top 100%.']);

    const inTop = finalGame(gam(), state, entries, 'p1').game;
    expect(inTop.leaderboard.self_row).toBeNull();
    expect(inTop.leaderboard.rows[1].is_self).toBe(true);
  });

  it('never invents entries: a lone participant sees only themselves', () => {
    const { game } = finalGame(gam(), { tokens_total: 5, badges: [] }, [entry('solo', 5, 't')], 'solo');
    expect(game.leaderboard.rows).toHaveLength(1);
    expect(game.leaderboard.empty_text).toBe('No other results yet.');
  });

  it('rank can be switched off or limited to the percentile', () => {
    const g = gam();
    g.rank.show = 'none';
    expect(finalGame(g, { tokens_total: 1, badges: [] }, [entry('x', 1, 't')], 'x').game.rank).toBeUndefined();
    g.rank.show = 'percentile';
    expect(finalGame(g, { tokens_total: 1, badges: [] }, [entry('x', 1, 't')], 'x').game.rank.lines).toEqual(['That puts you in the top 100%.']);
  });
});
