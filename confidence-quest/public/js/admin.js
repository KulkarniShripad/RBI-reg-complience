import { h, mount } from './dom.js';

// The one admin page: counts by arm and step, exports, backup, pilot/live switch.
// The token is kept in sessionStorage for this tab only.

const TOKEN_KEY = 'cq_admin_token';
const EXPORTS = ['participants', 'questions', 'surveys', 'events', 'gamification', 'allocation', 'meta'];
const STEPS = ['PRE_SURVEY', 'INSTRUCTIONS', 'QUESTION', 'FEEDBACK', 'FINAL', 'POST_SURVEY', 'DEBRIEF'];

const dashboard = document.getElementById('dashboard');
const login = document.getElementById('login');
const errorEl = document.getElementById('error');
const updated = document.getElementById('updated');
let refreshHandle = null;
let memoryToken = '';

const getToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
};

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Admin-Token': getToken(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new Error(data?.error?.message ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function stat(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'big' }, String(value)), h('div', { class: 'label' }, label));
}

function armTable(summary) {
  const arms = ['control', 'experimental', 'unassigned'];
  const cols = ['total', 'in_progress', 'completed', 'abandoned', 'withdrawn'];
  return h(
    'table',
    { class: 'status' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Arm'), cols.map((c) => h('th', {}, c.replace('_', ' '))))),
    h(
      'tbody',
      {},
      arms.map((arm) => h('tr', {}, h('td', {}, arm), cols.map((c) => h('td', {}, String(summary.by_arm[arm][c]))))),
    ),
  );
}

function stepTable(summary) {
  return h(
    'table',
    { class: 'status' },
    h('thead', {}, h('tr', {}, h('th', {}, 'In progress at step'), STEPS.map((s) => h('th', {}, s.replace('_', ' '))))),
    h('tbody', {}, h('tr', {}, h('td', {}, 'participants'), STEPS.map((s) => h('td', {}, String(summary.by_step[s] ?? 0))))),
  );
}

async function download(name, cohort) {
  try {
    const res = await call('GET', `/admin/api/export/${name}.csv${cohort === 'pilot' ? '?cohort=pilot' : ''}`);
    const blob = await res.blob();
    const filename = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${name}.csv`;
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    a.remove();
  } catch (err) {
    showError(err.message);
  }
}

async function action(fn) {
  try {
    showError('');
    await fn();
    await refresh();
  } catch (err) {
    showError(err.message);
  }
}

function render(s) {
  const live = s.live;
  const pilot = s.pilot;
  const lists = s.allocation.lists;
  const codeInput = h('input', { type: 'text', placeholder: 'Participant code', maxlength: '6' });
  dashboard.replaceChildren();
  mount(
    dashboard,
    h(
      'p',
      {},
      'Mode: ',
      h('span', { class: `mode mode-${s.study_mode}` }, s.study_mode.toUpperCase()),
      ' ',
      h('span', { class: 'muted' }, s.study_mode === 'pilot' ? '(new participants are pilot rows, excluded from exports)' : '(new participants are research data)'),
    ),
    s.content.warnings.length ? h('ul', { class: 'warnings' }, s.content.warnings.map((w) => h('li', {}, w))) : null,
    h(
      'div',
      { class: 'grid' },
      stat('live participants', live.total),
      stat('live completed', live.by_status.completed ?? 0),
      stat('main slots left', lists.main ? lists.main.remaining : 0),
      stat('pilot participants', pilot.total),
      stat('errors (last hour)', s.errors_last_hour),
    ),
    h('section', {}, h('h2', {}, 'Live participants by arm'), armTable(live), stepTable(live)),
    pilot.total ? h('section', {}, h('h2', {}, 'Pilot participants by arm'), armTable(pilot)) : null,
    h(
      'section',
      {},
      h('h2', {}, 'Exports (pilot rows excluded)'),
      h('div', { class: 'admin-row' }, EXPORTS.map((name) => h('button', { type: 'button', class: 'secondary small', onclick: () => download(name) }, `${name}.csv`))),
    ),
    pilot.total
      ? h(
          'section',
          {},
          h('h2', {}, 'Pilot exports (pilot rows only)'),
          h('div', { class: 'admin-row' }, EXPORTS.map((name) => h('button', { type: 'button', class: 'secondary small', onclick: () => download(name, 'pilot') }, `PILOT ${name}.csv`))),
        )
      : null,
    h(
      'section',
      {},
      h('h2', {}, 'Actions'),
      h(
        'div',
        { class: 'admin-row' },
        h('button', { type: 'button', class: 'secondary', onclick: () => action(async () => {
          const res = await call('POST', '/admin/api/backup');
          const data = await res.json();
          window.alert(`Backup saved: ${data.file}`);
        }) }, 'Back up database now'),
        h('button', { type: 'button', class: 'secondary', onclick: () => {
          const mode = s.study_mode === 'pilot' ? 'live' : 'pilot';
          if (window.confirm(`Switch to ${mode.toUpperCase()} mode?`)) action(() => call('POST', '/admin/api/mode', { mode }));
        } }, s.study_mode === 'pilot' ? 'Switch to LIVE mode' : 'Switch to PILOT mode'),
        h('button', { type: 'button', class: 'secondary', onclick: () => {
          const phrase = window.prompt('This deletes every pilot/rehearsal row. Type DELETE PILOT DATA to confirm.');
          if (phrase) action(() => call('POST', '/admin/api/purge-pilot', { confirm: phrase }));
        } }, 'Delete pilot data'),
      ),
      h(
        'div',
        { class: 'admin-row' },
        codeInput,
        h('button', { type: 'button', class: 'secondary', onclick: () => {
          const code = codeInput.value.trim().toUpperCase();
          if (code && window.confirm(`Remove all answers for participant ${code}? This cannot be undone.`)) {
            action(() => call('POST', '/admin/api/withdraw', { participant_code: code, confirm: true }));
          }
        } }, 'Withdraw a participant\'s data'),
      ),
    ),
    s.recent_errors.length
      ? h('section', {}, h('h2', {}, 'Recent errors'), h('ul', {}, s.recent_errors.map((e) => h('li', { class: 'small-print' }, `${e.at} · ${e.code} · ${e.method} ${e.route}`))))
      : null,
    h(
      'p',
      { class: 'small-print' },
      `Allocation: block size ${s.allocation.block_size}, seed from ${s.allocation.seed_source}. `,
      `Questions ${s.content.questions_version}. Uptime ${Math.round(s.uptime_s / 60)} min.`,
    ),
  );
}

async function refresh() {
  try {
    const res = await call('GET', '/admin/api/status');
    const status = await res.json();
    login.hidden = true;
    dashboard.hidden = false;
    render(status);
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    if (err.status === 403) {
      clearInterval(refreshHandle);
      login.hidden = false;
      dashboard.hidden = true;
      showError('Wrong or missing admin token.');
    } else {
      updated.textContent = `connection problem: ${err.message}`;
    }
  }
}

login.addEventListener('submit', (event) => {
  event.preventDefault();
  memoryToken = document.getElementById('token').value;
  try {
    sessionStorage.setItem(TOKEN_KEY, memoryToken);
  } catch {
    // Storage unavailable: the token lives only for this page load.
  }
  showError('');
  start();
});

function start() {
  clearInterval(refreshHandle);
  refresh();
  refreshHandle = setInterval(refresh, 5000);
}

if (getToken()) start();
