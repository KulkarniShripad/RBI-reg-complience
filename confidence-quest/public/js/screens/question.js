import { ApiError, newKey } from '../api.js';
import { h, heading, mount, whileBusy } from '../dom.js';
import { renderFeedback } from './feedback.js';

// S3. One question, no skipping, no going back. Code keeps its exact whitespace.
export async function renderQuestion(ctx, state) {
  let q;
  try {
    q = await ctx.api('GET', `/api/question/${state.n}`);
  } catch (err) {
    return ctx.handleError(err);
  }
  ctx.setProgress(q.progress_text);

  const choices = [...q.options];
  if (q.dont_know) choices.push({ key: q.dont_know.key, text: q.dont_know.label, dontKnow: true });
  const submit = h('button', { type: 'submit', class: 'primary', disabled: true }, q.submit_button);
  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const list = h(
    'div',
    { class: 'options', role: 'radiogroup', 'aria-label': 'Answer options' },
    choices.map((choice) =>
      h(
        'label',
        { class: `option${choice.dontKnow ? ' option-idk' : ''}` },
        h('input', {
          type: 'radio',
          name: 'answer',
          value: choice.key,
          onchange: () => {
            submit.disabled = false;
          },
        }),
        choice.dontKnow ? null : h('span', { class: 'option-key' }, `${choice.key})`),
        h('span', { class: `option-text${q.options_format === 'code' && !choice.dontKnow ? ' mono' : ''}` }, choice.text),
      ),
    ),
  );

  const meta = [q.section, q.difficulty_label].filter(Boolean).join(' · ');
  const form = h('form', { novalidate: true }, list, errorBox, h('div', { class: 'actions' }, submit));
  const key = newKey();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const selected = form.querySelector('input[name="answer"]:checked');
    if (!selected) return;
    for (const input of form.querySelectorAll('input')) input.disabled = true;
    whileBusy(submit, async () => {
      const result = await ctx.api('POST', '/api/answer', {
        questionId: q.id,
        selectedOption: selected.value,
        idempotencyKey: key,
      });
      ctx.root.replaceChildren();
      renderFeedback(ctx, { n: q.n, total: q.total, feedback: result });
    }).catch((err) => {
      for (const input of form.querySelectorAll('input')) input.disabled = false;
      if (err instanceof ApiError && err.code === 'VALIDATION') {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      } else ctx.handleError(err);
    });
  });

  mount(
    ctx.root,
    meta ? h('p', { class: 'eyebrow' }, meta) : null,
    heading(q.progress_text),
    q.prompt ? h('p', { class: 'prompt', 'data-testid': 'prompt' }, q.prompt) : null,
    q.code !== undefined
      ? h('pre', { class: 'code', 'data-testid': 'code' }, h('code', { class: q.language ? `language-${q.language}` : null }, q.code))
      : null,
    q.note ? h('p', { class: 'note' }, q.note) : null,
    form,
  );
  ctx.root.querySelector('h1').focus();
}
