// Builds elements with textContent only, so content is always HTML-escaped.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Like Element.append, but skips null/false (native append would render them as "null").
export function mount(parent, ...children) {
  parent.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return parent;
}

export const paragraphs = (list) => (list ?? []).map((text) => h('p', {}, text));

export function heading(text) {
  return h('h1', { tabindex: '-1' }, text);
}

// Disables a button while an async action runs; re-enables it only if the action fails.
export async function whileBusy(button, action) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    return await action();
  } catch (err) {
    button.disabled = false;
    throw err;
  } finally {
    button.removeAttribute('aria-busy');
  }
}
