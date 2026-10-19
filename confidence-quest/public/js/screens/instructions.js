import { h, heading, mount, paragraphs, whileBusy } from '../dom.js';

// S2. The same neutral text for both arms (plus at most one extra line for the experimental arm).
export function renderInstructions(ctx, state) {
  const text = state.instructions;
  const start = h('button', { type: 'button', class: 'primary' }, text.start_button);
  start.addEventListener('click', () =>
    whileBusy(start, async () => {
      const result = await ctx.api('POST', '/api/instructions/ack', {});
      ctx.show(result.state.step, result.state);
    }).catch(ctx.handleError),
  );
  mount(ctx.root, heading(text.title), ...paragraphs(text.paragraphs), h('div', { class: 'actions' }, start));
}
