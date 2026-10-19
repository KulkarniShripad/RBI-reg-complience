import { ApiError, newKey } from '../api.js';
import { h, heading, mount, whileBusy } from '../dom.js';

// S1 and S6. Rendered entirely from survey.json via the server; every item is required.
export async function renderSurvey(ctx, state) {
  const phase = state.step === 'PRE_SURVEY' ? 'pre' : 'post';
  let survey;
  try {
    survey = await ctx.api('GET', `/api/survey/${phase}`);
  } catch (err) {
    return ctx.handleError(err);
  }

  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const fieldsets = survey.items.map((item, index) => {
    const values = [];
    for (let v = item.scale.min; v <= item.scale.max; v++) values.push(v);
    const name = `item-${item.id}`;
    return h(
      'fieldset',
      { class: 'likert', 'data-item': item.id },
      h('legend', {}, h('span', { class: 'item-number' }, `${index + 1}.`), ' ', item.text),
      h(
        'div',
        { class: 'likert-options' },
        values.map((v) =>
          h(
            'label',
            { class: 'likert-option' },
            h('input', { type: 'radio', name, value: String(v) }),
            h('span', { class: 'likert-value' }, String(v)),
            item.scale.labels[String(v)] ? h('span', { class: 'likert-label' }, item.scale.labels[String(v)]) : null,
          ),
        ),
      ),
    );
  });

  for (const fs of fieldsets) {
    fs.addEventListener('change', () => {
      fs.classList.remove('missing');
      if (!fieldsets.some((f) => f.classList.contains('missing'))) errorBox.hidden = true;
    });
  }

  const submit = h('button', { type: 'submit', class: 'primary' }, survey.submit_button);
  const form = h('form', { novalidate: true }, ...fieldsets, errorBox, h('div', { class: 'actions' }, submit));
  const key = newKey();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const answers = {};
    let firstMissing = null;
    for (const fs of fieldsets) {
      const checked = fs.querySelector('input:checked');
      fs.classList.toggle('missing', !checked);
      if (checked) answers[fs.dataset.item] = Number(checked.value);
      else firstMissing ??= fs;
    }
    if (firstMissing) {
      errorBox.textContent = survey.missing_message;
      errorBox.hidden = false;
      firstMissing.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    errorBox.hidden = true;
    whileBusy(submit, async () => {
      const result = await ctx.api('POST', `/api/survey/${phase}`, { answers, idempotencyKey: key });
      ctx.show(result.state.step, result.state);
    }).catch((err) => {
      if (err instanceof ApiError && err.code === 'VALIDATION') {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
      } else ctx.handleError(err);
    });
  });

  mount(ctx.root, heading(survey.title), survey.intro ? h('p', { class: 'muted' }, survey.intro) : null, form);
  ctx.root.querySelector('h1').focus();
}
