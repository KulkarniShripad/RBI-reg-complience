import { h, heading, mount, paragraphs, whileBusy } from '../dom.js';
import { renderGamePanel } from './gamePanel.js';

// S5. Shown before the post-survey so the manipulation reaches the measure.
export async function renderFinal(ctx) {
  let r;
  try {
    r = await ctx.api('GET', '/api/results');
  } catch (err) {
    return ctx.handleError(err);
  }
  const next = h('button', { type: 'button', class: 'primary' }, r.continue_button);
  next.addEventListener('click', () =>
    whileBusy(next, async () => {
      const result = await ctx.api('POST', '/api/results/ack', {});
      ctx.show(result.state.step, result.state);
    }).catch(ctx.handleError),
  );
  mount(
    ctx.root,
    heading(r.title),
    r.score ? h('p', { class: 'score', 'data-testid': 'score' }, r.score.text) : null,
    r.game ? renderGamePanel(r.game) : null,
    ...paragraphs(r.paragraphs),
    h('div', { class: 'actions' }, next),
  );
  ctx.root.querySelector('h1').focus();
}
