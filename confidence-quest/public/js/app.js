import { api, ApiError } from './api.js';
import { h, mount } from './dom.js';
import { renderConsent } from './screens/consent.js';
import { renderSurvey } from './screens/survey.js';
import { renderInstructions } from './screens/instructions.js';
import { renderQuestion } from './screens/question.js';
import { renderFeedback } from './screens/feedback.js';
import { renderFinal } from './screens/final.js';
import { renderDebrief } from './screens/debrief.js';
import { renderWithdrawn } from './screens/withdrawn.js';

// The browser only renders what the server says. The server stores the step,
// so a refresh or a reopened tab always lands on the same screen.

const SCREENS = {
  CONSENT: renderConsent,
  PRE_SURVEY: renderSurvey,
  INSTRUCTIONS: renderInstructions,
  QUESTION: renderQuestion,
  FEEDBACK: renderFeedback,
  FINAL: renderFinal,
  POST_SURVEY: renderSurvey,
  DEBRIEF: renderDebrief,
  WITHDRAWN: renderWithdrawn,
};
const STEPS_WITH_WITHDRAW = new Set(['PRE_SURVEY', 'INSTRUCTIONS', 'QUESTION', 'FEEDBACK', 'FINAL', 'POST_SURVEY']);

const root = document.getElementById('app');
const banner = document.getElementById('banner');
const progressEl = document.getElementById('progress');
const timerEl = document.getElementById('timer');
const withdrawBtn = document.getElementById('withdraw');
let timerHandle = null;

const ctx = { api, root, texts: null, go, show, handleError, setProgress };

function setProgress(text) {
  progressEl.hidden = !text;
  progressEl.textContent = text ?? '';
}

function setTimer(state) {
  clearInterval(timerHandle);
  timerHandle = null;
  if (!('time_remaining_s' in state)) {
    timerEl.hidden = true;
    return;
  }
  const endsAt = Date.now() + state.time_remaining_s * 1000;
  const tick = () => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    timerEl.textContent = `${ctx.texts.ui.time_left_label}: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    timerEl.classList.toggle('urgent', left <= 60);
    if (left === 0) {
      clearInterval(timerHandle);
      go();
    }
  };
  timerEl.hidden = false;
  tick();
  timerHandle = setInterval(tick, 1000);
}

function hideBanner() {
  banner.hidden = true;
  banner.replaceChildren();
}

function showBanner(message, retry) {
  banner.replaceChildren();
  mount(
    banner,
    h('span', {}, message),
    retry ? h('button', { type: 'button', class: 'secondary small', onclick: retry }, ctx.texts?.ui.retry_button ?? 'Try again') : null,
  );
  banner.hidden = false;
}

export function show(step, state = {}) {
  hideBanner();
  setTimer(state);
  if (step !== 'QUESTION' && step !== 'FEEDBACK') setProgress(null);
  withdrawBtn.hidden = !STEPS_WITH_WITHDRAW.has(step);
  root.replaceChildren();
  window.scrollTo(0, 0);
  const render = SCREENS[step];
  if (!render) {
    root.append(h('p', {}, ctx.texts?.ui.generic_error ?? 'Something went wrong.'));
    return;
  }
  render(ctx, state);
  root.querySelector('h1')?.focus();
}

// Asks the server where the participant is and shows that screen.
export async function go() {
  try {
    const state = await api('GET', '/api/state');
    show(state.step, state);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NO_SESSION') show('CONSENT');
    else handleError(err);
  }
}

// NOT_YOUR_TURN means this tab is out of date: resync with the server.
// VALIDATION errors are shown by the screen itself; everything else gets the banner.
export function handleError(err) {
  if (!(err instanceof ApiError)) {
    console.error(err);
    showBanner(ctx.texts?.ui.generic_error ?? 'Something went wrong.', go);
    return;
  }
  if (err.code === 'NOT_YOUR_TURN') return go();
  if (err.code === 'NO_SESSION') return show('CONSENT');
  if (err.code === 'FORBIDDEN') return go();
  if (err.code === 'NETWORK') return showBanner(ctx.texts?.ui.connection_lost ?? err.message, go);
  showBanner(err.message || ctx.texts?.ui.generic_error, go);
}

async function onWithdraw() {
  if (!window.confirm(ctx.texts.withdraw.confirm_text)) return;
  try {
    const state = await api('POST', '/api/withdraw', { confirm: true });
    show(state.step, state);
  } catch (err) {
    handleError(err);
  }
}

async function boot() {
  try {
    ctx.texts = await api('GET', '/api/texts');
  } catch (err) {
    root.replaceChildren(h('p', {}, 'Connection lost. Please raise your hand and tell the proctor.'));
    return;
  }
  document.title = ctx.texts.study_title;
  document.getElementById('study-title').textContent = ctx.texts.study_title;
  withdrawBtn.textContent = ctx.texts.withdraw.link_label;
  withdrawBtn.addEventListener('click', onWithdraw);
  await go();
}

boot();
