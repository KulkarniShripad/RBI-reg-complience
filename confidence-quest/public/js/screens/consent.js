import { h, heading, mount, paragraphs, whileBusy } from '../dom.js';

// S0. Declining never contacts the server, so nothing is stored.
export function renderConsent(ctx) {
  const c = ctx.texts.consent;
  const box = h('input', { type: 'checkbox', id: 'consent-box' });
  const agree = h('button', { type: 'button', class: 'primary', disabled: true }, c.agree_button);
  box.addEventListener('change', () => {
    agree.disabled = !box.checked;
  });
  agree.addEventListener('click', () =>
    whileBusy(agree, async () => {
      const state = await ctx.api('POST', '/api/session', { consent: true });
      ctx.show(state.step, state);
    }).catch(ctx.handleError),
  );
  const decline = h(
    'button',
    {
      type: 'button',
      class: 'secondary',
      onclick: () => {
        ctx.root.replaceChildren(heading(c.declined_title), ...paragraphs(c.declined_paragraphs));
        ctx.root.querySelector('h1').focus();
      },
    },
    c.decline_button,
  );
  mount(
    ctx.root,
    heading(c.title),
    ...paragraphs(c.paragraphs),
    h('label', { class: 'check', for: 'consent-box' }, box, h('span', {}, c.checkbox_label)),
    h('div', { class: 'actions' }, agree, decline),
  );
}
