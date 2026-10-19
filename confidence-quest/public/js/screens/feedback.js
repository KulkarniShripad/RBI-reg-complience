import { h, heading, mount, whileBusy } from '../dom.js';
import { renderGamePanel } from './gamePanel.js';

// S4. 'Correct' or 'Incorrect' only; the right option is never revealed.
// The game panel is mounted only when the server sends a game object (experimental arm).
export function renderFeedback(ctx, state) {
  const fb = state.feedback;
  ctx.setProgress(null);
  const next = h('button', { type: 'button', class: 'primary' }, fb.next_button);
  next.addEventListener('click', () =>
    whileBusy(next, async () => {
      const result = await ctx.api('POST', '/api/next', { n: fb.n });
      ctx.show(result.state.step, result.state);
    }).catch(ctx.handleError),
  );
  mount(
    ctx.root,
    h('p', { class: 'eyebrow' }, `${fb.n} / ${state.total ?? state.total_questions}`),
    h(
      'div',
      { class: `result ${fb.correct ? 'result-correct' : 'result-incorrect'}`, 'data-testid': 'result' },
      heading(fb.text),
    ),
    fb.game ? renderGamePanel(fb.game) : null,
    h('div', { class: 'actions' }, next),
  );
  ctx.root.querySelector('h1').focus();
}
