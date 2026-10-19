import crypto from 'node:crypto';
import { fillTemplate } from '../util.js';

// Every rule lives in gamification.json. This file only knows how to apply rule *types*.

export function anyGameFeature(gam) {
  return gam.tokens.enabled || gam.badges.enabled || gam.leaderboard.enabled || gam.rank.show !== 'none';
}

export function tokensForResponse(gam, question, response) {
  if (!gam.tokens.enabled) return 0;
  const answered = response.selected_option !== null && response.selected_option !== undefined;
  const qualifies = gam.tokens.award_on === 'any_answer' ? answered : response.is_correct === 1;
  if (!qualifies) return 0;
  return gam.tokens.points_by_difficulty[question.difficulty_label] ?? gam.tokens.default_points;
}

function badgeMet(criteria, tally) {
  switch (criteria.type) {
    case 'answered_count':
      return tally.answered >= criteria.gte;
    case 'correct_count':
      return tally.correct >= criteria.gte;
    case 'correct_streak':
      return tally.bestStreak >= criteria.gte;
    case 'section_all_correct':
      return (tally.sectionCorrect[criteria.section] ?? 0) === tally.sectionSize[criteria.section];
    default:
      return false;
  }
}

// Replays the stored responses (in position order) and works out what was earned at each one.
// Because it runs on stored answers, what a participant sees always matches the data.
export function computeGameState(gam, questions, responses) {
  const byId = Object.fromEntries(questions.map((q) => [q.id, q]));
  const sectionSize = {};
  for (const q of questions) sectionSize[q.section] = (sectionSize[q.section] ?? 0) + 1;
  const tally = { answered: 0, correct: 0, streak: 0, bestStreak: 0, sectionCorrect: {}, sectionSize };
  const earned = new Set();
  const steps = [];
  let total = 0;
  for (const r of [...responses].sort((a, b) => a.position - b.position)) {
    const q = byId[r.question_id];
    const tokens = tokensForResponse(gam, q, r);
    total += tokens;
    if (r.selected_option !== null && r.selected_option !== undefined) tally.answered++;
    if (r.is_correct === 1) {
      tally.correct++;
      tally.streak++;
      tally.bestStreak = Math.max(tally.bestStreak, tally.streak);
      tally.sectionCorrect[q.section] = (tally.sectionCorrect[q.section] ?? 0) + 1;
    } else {
      tally.streak = 0;
    }
    const newBadges = [];
    if (gam.badges.enabled) {
      for (const badge of gam.badges.definitions) {
        if (!earned.has(badge.key) && badgeMet(badge.criteria, tally)) {
          earned.add(badge.key);
          newBadges.push(badge.key);
        }
      }
    }
    steps.push({ position: r.position, question_id: r.question_id, tokens, tokens_total: total, new_badges: newBadges });
  }
  return { steps, tokens_total: total, badges: [...earned], correct: tally.correct };
}

function describeBadges(gam, keys) {
  return keys.map((key) => {
    const badge = gam.badges.definitions.find((b) => b.key === key);
    return { key, name: badge.name, description: badge.description };
  });
}

// The game panel shown with the feedback for one question.
export function feedbackGame(gam, state, position) {
  const step = state.steps.find((s) => s.position === position);
  const game = {};
  if (!step) return game;
  if (gam.tokens.enabled && (gam.feedback_panel.show_tokens_earned || gam.feedback_panel.show_total_tokens)) {
    game.tokens = { label: gam.tokens.label };
    if (gam.feedback_panel.show_tokens_earned) game.tokens.earned = step.tokens;
    if (gam.feedback_panel.show_total_tokens) game.tokens.total = step.tokens_total;
  }
  if (gam.badges.enabled && gam.feedback_panel.show_new_badges) {
    const soFar = state.steps.filter((s) => s.position <= position).flatMap((s) => s.new_badges);
    game.badges = { new: describeBadges(gam, step.new_badges), earned: describeBadges(gam, soFar) };
  }
  return game;
}

function compareTie(tieBreak) {
  if (tieBreak === 'earlier_finish') return (a, b) => (a.finished_at < b.finished_at ? -1 : a.finished_at > b.finished_at ? 1 : 0);
  if (tieBreak === 'less_total_time') return (a, b) => a.total_time_ms - b.total_time_ms;
  return () => 0;
}

// Ranks real entries only: [{ id, name, tokens, score_raw, finished_at, total_time_ms }].
export function rankEntries(gam, entries) {
  const { metric, tie_break: tieBreak } = gam.leaderboard;
  const value = (e) => (metric === 'tokens' ? e.tokens : e.score_raw);
  const tie = compareTie(tieBreak);
  const sorted = entries
    .map((e) => ({ ...e, value: value(e) }))
    .sort((a, b) => b.value - a.value || tie(a, b) || (a.id < b.id ? -1 : 1));
  sorted.forEach((e, i) => {
    e.rank = tieBreak === 'shared' && i > 0 && e.value === sorted[i - 1].value ? sorted[i - 1].rank : i + 1;
  });
  return sorted;
}

// Everything the experimental final screen shows. `entries` must include the viewer.
export function finalGame(gam, state, entries, viewerId) {
  const game = {};
  if (gam.tokens.enabled) game.tokens = { label: gam.tokens.label, total: state.tokens_total };
  if (gam.badges.enabled) game.badges = { earned: describeBadges(gam, state.badges) };
  const ranked = rankEntries(gam, entries);
  const self = ranked.find((e) => e.id === viewerId);
  if (gam.leaderboard.enabled) {
    const row = (e) => ({ rank: e.rank, name: e.name, value: e.value, is_self: e.id === viewerId });
    const top = ranked.slice(0, gam.leaderboard.top_n).map(row);
    game.leaderboard = {
      title: gam.leaderboard.title,
      metric_label: gam.leaderboard.metric_label,
      self_label: gam.leaderboard.self_label,
      rows: top,
      self_row: gam.leaderboard.include_self_row && self && !top.some((r) => r.is_self) ? row(self) : null,
      empty_text: ranked.length <= 1 ? gam.leaderboard.empty_text : null,
    };
  }
  if (gam.rank.show !== 'none' && self) {
    const values = { rank: self.rank, of: ranked.length, top_percent: Math.ceil((100 * self.rank) / ranked.length) };
    game.rank = { ...values, lines: [] };
    if (gam.rank.show === 'rank' || gam.rank.show === 'both') game.rank.lines.push(fillTemplate(gam.rank.rank_text, values));
    if (gam.rank.show === 'percentile' || gam.rank.show === 'both') {
      game.rank.lines.push(fillTemplate(gam.rank.percentile_text, values));
    }
  }
  return { game, rank: self?.rank ?? null, poolSize: ranked.length };
}

export function pickLeaderboardName(gam, isTaken) {
  const { adjectives, nouns } = gam.leaderboard.names;
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${adjectives[crypto.randomInt(adjectives.length)]} ${nouns[crypto.randomInt(nouns.length)]}`;
    if (!isTaken(name)) return name;
  }
  for (let n = 2; ; n++) {
    const name = `${adjectives[crypto.randomInt(adjectives.length)]} ${nouns[crypto.randomInt(nouns.length)]} ${n}`;
    if (!isTaken(name)) return name;
  }
}
