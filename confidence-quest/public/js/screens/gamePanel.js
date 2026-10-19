import { h } from '../dom.js';

// Experimental arm only. Everything shown here comes from the server, which computes it
// from stored answers using gamification.json.
export function renderGamePanel(game) {
  const parts = [];
  if (game.tokens) {
    const t = game.tokens;
    const line = [];
    if ('earned' in t) line.push(h('span', { class: 'token-earned' }, `+${t.earned} ${t.label}`));
    if ('total' in t) line.push(h('span', { class: 'token-total' }, `${t.total} ${t.label} in total`));
    parts.push(h('div', { class: 'game-tokens' }, h('span', { class: 'token-icon', 'aria-hidden': 'true' }, '◆'), ...line));
  }
  if (game.badges) {
    const fresh = game.badges.new ?? [];
    for (const badge of fresh) {
      parts.push(
        h(
          'div',
          { class: 'game-badge new' },
          h('span', { class: 'badge-icon', 'aria-hidden': 'true' }, '★'),
          h('strong', {}, `New badge: ${badge.name}`),
          badge.description ? h('span', { class: 'muted' }, ` — ${badge.description}`) : null,
        ),
      );
    }
    const earlier = (game.badges.earned ?? []).filter((b) => !fresh.some((f) => f.key === b.key));
    if (earlier.length) {
      parts.push(
        h(
          'div',
          { class: 'game-badges' },
          earlier.map((b) => h('span', { class: 'badge-chip' }, h('span', { 'aria-hidden': 'true' }, '★ '), b.name)),
        ),
      );
    }
  }
  if (game.rank) parts.push(h('div', { class: 'game-rank' }, game.rank.lines.map((line) => h('p', {}, line))));
  if (game.leaderboard) parts.push(renderLeaderboard(game.leaderboard));
  return h('section', { class: 'game-panel', 'data-testid': 'game-panel', 'aria-label': 'Game progress' }, parts);
}

function renderLeaderboard(lb) {
  const row = (r) =>
    h(
      'tr',
      { class: r.is_self ? 'self' : null },
      h('td', {}, String(r.rank)),
      h('td', {}, r.is_self ? `${r.name} (${lb.self_label})` : r.name),
      h('td', { class: 'num' }, String(r.value)),
    );
  const body = lb.rows.map(row);
  if (lb.self_row) body.push(h('tr', { class: 'gap' }, h('td', { colspan: '3' }, '…')), row(lb.self_row));
  return h(
    'div',
    { class: 'leaderboard', 'data-testid': 'leaderboard' },
    h('h2', {}, lb.title),
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Name'), h('th', { class: 'num' }, lb.metric_label))),
      h('tbody', {}, body),
    ),
    lb.empty_text ? h('p', { class: 'muted' }, lb.empty_text) : null,
  );
}
