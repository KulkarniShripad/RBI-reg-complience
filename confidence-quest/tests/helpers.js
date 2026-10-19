import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { ROOT, loadConfig } from '../server/config.js';
import { bootstrap } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';

export const ADMIN_TOKEN = 'test-admin-token-0123456789';
export const CONTENT_DIR = path.join(ROOT, 'server', 'content');
export const ANSWER_KEY = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'answer_key.json'), 'utf8'));
export const wrongLetter = (letter) => ({ A: 'B', B: 'C', C: 'D', D: 'A' })[letter];

export function tmpDir(prefix = 'cq-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A copy of the content folder with JSON edits applied: { 'study.json': (json) => { ... } }.
export function contentCopy(edits = {}) {
  const dir = tmpDir('cq-content-');
  fs.cpSync(CONTENT_DIR, dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) {
    const full = path.join(dir, file);
    const json = JSON.parse(fs.readFileSync(full, 'utf8'));
    fs.writeFileSync(full, JSON.stringify(edit(json) ?? json, null, 2));
  }
  return dir;
}

export function makeApp({ contentDir, env = {}, dbPath } = {}) {
  const config = loadConfig({
    DB_PATH: dbPath ?? path.join(tmpDir(), 'test.sqlite'),
    ADMIN_TOKEN,
    ALLOCATION_SEED: 'test-seed',
    BACKUP_DIR: path.join(tmpDir(), 'backups'),
    ...(contentDir ? { CONTENT_DIR: contentDir } : {}),
    ...env,
  });
  const { db, content } = bootstrap(config);
  const { app, study } = createApp({ db, content, config });
  return { app, db, content, config, study };
}

// Supertest agent (keeps the cookie, like one browser) that records every response.
export function participant(app) {
  const agent = request.agent(app);
  const log = [];
  const record = (res) => {
    log.push({ status: res.status, body: res.body, text: res.text });
    return res;
  };
  return {
    agent,
    log,
    get: (url) => agent.get(url).then(record),
    post: (url, body = {}) => agent.post(url).send(body).then(record),
  };
}

export function surveyAnswers(content, phase, value) {
  const answers = {};
  for (const item of content.survey.items.filter((i) => i.enabled && i.phases.includes(phase))) {
    const scale = item.scale ?? content.survey.default_scale;
    answers[item.id] = Math.min(scale.max, Math.max(scale.min, value ?? Math.ceil((scale.min + scale.max) / 2)));
  }
  return answers;
}

let keyCounter = 0;
export const key = () => `test-key-${Date.now()}-${keyCounter++}`;

export async function consent(p) {
  const res = await p.post('/api/session', { consent: true });
  if (res.status !== 201) throw new Error(`session failed: ${res.status} ${res.text}`);
  return res;
}

export async function toQuestions(p, content, preValue) {
  await consent(p);
  const pre = await p.post('/api/survey/pre', { answers: surveyAnswers(content, 'pre', preValue), idempotencyKey: key() });
  if (pre.status !== 200) throw new Error(`pre survey failed: ${pre.status} ${pre.text}`);
  const ack = await p.post('/api/instructions/ack');
  if (ack.status !== 200) throw new Error(`instructions failed: ${ack.status} ${ack.text}`);
}

// choose(questionId, n) -> letter. Defaults to the correct answer.
export async function answerAll(p, content, choose = (id) => ANSWER_KEY[id]) {
  const results = [];
  for (let n = 1; n <= content.questions.length; n++) {
    const q = await p.get(`/api/question/${n}`);
    if (q.status !== 200) throw new Error(`question ${n} failed: ${q.status} ${q.text}`);
    const a = await p.post('/api/answer', { questionId: q.body.id, selectedOption: choose(q.body.id, n), idempotencyKey: key() });
    if (a.status !== 200) throw new Error(`answer ${n} failed: ${a.status} ${a.text}`);
    results.push(a.body);
    const next = await p.post('/api/next', { n });
    if (next.status !== 200) throw new Error(`next ${n} failed: ${next.status} ${next.text}`);
  }
  return results;
}

export async function finish(p, content, postValue) {
  const results = await p.get('/api/results');
  if (results.status !== 200) throw new Error(`results failed: ${results.status} ${results.text}`);
  await p.post('/api/results/ack');
  const post = await p.post('/api/survey/post', { answers: surveyAnswers(content, 'post', postValue), idempotencyKey: key() });
  if (post.status !== 200) throw new Error(`post survey failed: ${post.status} ${post.text}`);
  const done = await p.post('/api/complete');
  if (done.status !== 200) throw new Error(`complete failed: ${done.status} ${done.text}`);
  return { results: results.body, debrief: done.body };
}

export async function fullRun(app, content, { choose, preValue, postValue } = {}) {
  const p = participant(app);
  await toQuestions(p, content, preValue);
  const answers = await answerAll(p, content, choose);
  const { results, debrief } = await finish(p, content, postValue);
  return { p, answers, results, debrief, code: debrief.participant_code };
}

export const armOf = (db, code) => db.prepare('SELECT arm FROM participants WHERE participant_code = ?').get(code)?.arm;

// Every key that appears anywhere in a JSON value.
export function allKeys(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}
