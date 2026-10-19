import { h, heading, mount, paragraphs } from '../dom.js';

// S7. Completing is idempotent, so a reload shows the same page and code.
export async function renderDebrief(ctx) {
  let d;
  try {
    d = await ctx.api('POST', '/api/complete', {});
  } catch (err) {
    return ctx.handleError(err);
  }
  mount(
    ctx.root,
    heading(d.title),
    ...paragraphs(d.paragraphs),
    h(
      'div',
      { class: 'code-box' },
      h('p', { class: 'code-label' }, d.code_label),
      h('p', { class: 'participant-code', 'data-testid': 'participant-code' }, d.participant_code),
      d.code_help ? h('p', { class: 'muted' }, d.code_help) : null,
    ),
    ...paragraphs(d.withdraw_paragraphs),
  );
  ctx.root.querySelector('h1').focus();
}
