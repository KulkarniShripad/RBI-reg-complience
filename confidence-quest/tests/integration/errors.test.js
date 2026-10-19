import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../server/config.js';
import { ANSWER_KEY, answerAll, contentCopy, finish, key, makeApp, participant, tmpDir, toQuestions } from '../helpers.js';

const startServer = (env) =>
  spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, DB_PATH: path.join(tmpDir(), 'x.sqlite'), PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 10000,
  });

describe('startup', () => {
  it('refuses to start when a content file is missing, naming the file', () => {
    const dir = contentCopy();
    fs.rmSync(path.join(dir, 'survey.json'));
    const run = startServer({ CONTENT_DIR: dir });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Refusing to start/);
    expect(run.stderr).toMatch(/survey\.json: file is missing/);
  });

  it('refuses to start when a field is invalid, naming the file and field', () => {
    const dir = contentCopy({
      'questions.json': (q) => {
        q.questions[2].options[0].key = 'X';
      },
    });
    const run = startServer({ CONTENT_DIR: dir });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/questions\.json: questions\.2\.options\.0\.key/);
  });

  it('refuses to start in production without an admin token', () => {
    const run = startServer({ NODE_ENV: 'production', ADMIN_TOKEN: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ADMIN_TOKEN/);
  });

  it('builds the database from schema.sql when it is missing', () => {
    const { db } = makeApp();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
    expect(tables).toEqual(['allocation_slots', 'events', 'gamification_events', 'meta', 'participants', 'question_responses', 'survey_responses']);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('logs a content change between starts', () => {
    const dbPath = path.join(tmpDir(), 'hash.sqlite');
    makeApp({ dbPath }).db.close();
    const dir = contentCopy({
      'study.json': (s) => {
        s.instructions.title = 'Read this first';
      },
    });
    const { db } = makeApp({ dbPath, contentDir: dir });
    const event = db.prepare("SELECT payload FROM events WHERE event_type = 'content_changed'").get();
    expect(JSON.parse(event.payload)).toEqual({ files: ['study.json'] });
  });
});

describe('database rules', () => {
  it('unique constraints reject duplicate answers and duplicate survey rows', async () => {
    const { app, db } = makeApp();
    const p = participant(app);
    await p.post('/api/session', { consent: true });
    const id = db.prepare('SELECT id FROM participants').get().id;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'pre', 'conf_1', 3, ?)").run(id, now);
    expect(() =>
      db.prepare("INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, 'pre', 'conf_1', 4, ?)").run(id, now),
    ).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO question_responses (participant_id, question_id, position, shown_at) VALUES (?, 'Q1', 1, ?)").run(id, now);
    expect(() =>
      db.prepare("INSERT INTO question_responses (participant_id, question_id, position, shown_at) VALUES (?, 'Q1', 1, ?)").run(id, now),
    ).toThrow(/UNIQUE/);
  });

  it('the events table is append-only', async () => {
    const { app, db } = makeApp();
    await participant(app).post('/api/session', { consent: true });
    expect(() => db.prepare("UPDATE events SET event_type = 'x'").run()).toThrow(/append-only/);
  });
});

describe('time limit (D10, off by default)', () => {
  it('closes the test at the deadline: unanswered questions count as wrong', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.time_limit = { enabled: true, total_seconds: 60, on_expiry: 'end_test' };
      },
    });
    const { app, db, content } = makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    const q1 = await p.get('/api/question/1');
    expect(q1.body.time_remaining_s).toBeGreaterThan(55);
    await p.post('/api/answer', { questionId: 'Q1', selectedOption: ANSWER_KEY.Q1, idempotencyKey: key() });
    await p.post('/api/next', { n: 1 });
    await p.get('/api/question/2');

    // Move the start back two minutes, as if time ran out.
    db.prepare('UPDATE participants SET questions_started_at = ?').run(new Date(Date.now() - 120000).toISOString());
    const state = await p.get('/api/state');
    expect(state.body.step).toBe('FINAL');
    const late = await p.post('/api/answer', { questionId: 'Q2', selectedOption: ANSWER_KEY.Q2, idempotencyKey: key() });
    expect(late.body).toMatchObject({ correct: false, expired: true });

    const rows = db.prepare('SELECT question_id, selected_option, is_correct, expired FROM question_responses ORDER BY position').all();
    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({ question_id: 'Q1', selected_option: 'D', is_correct: 1, expired: 0 });
    expect(rows.slice(1).every((r) => r.expired === 1 && r.is_correct === 0 && r.selected_option === null)).toBe(true);
    const { results } = await finish(p, content);
    expect(results.score.correct).toBe(1);
  });

  it('does not touch a participant who already answered all nine', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.time_limit = { enabled: true, total_seconds: 60, on_expiry: 'end_test' };
      },
    });
    const { app, db, content } = makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    for (let n = 1; n <= 9; n++) {
      const q = await p.get(`/api/question/${n}`);
      await p.post('/api/answer', { questionId: q.body.id, selectedOption: ANSWER_KEY[q.body.id], idempotencyKey: key() });
      if (n < 9) await p.post('/api/next', { n });
    }
    const finishedAt = db.prepare('SELECT questions_finished_at FROM participants').get().questions_finished_at;
    db.prepare('UPDATE participants SET questions_started_at = ?').run(new Date(Date.now() - 120000).toISOString());
    expect((await p.get('/api/state')).body).toMatchObject({ step: 'FEEDBACK', n: 9 });
    expect(db.prepare('SELECT questions_finished_at FROM participants').get().questions_finished_at).toBe(finishedAt);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'time_expired'").get().n).toBe(0);
  });
});

describe('survey content', () => {
  it('renders entirely from survey.json: editing the file changes the survey', async () => {
    const dir = contentCopy({
      'survey.json': (s) => {
        s.items[0].text = 'I enjoy debugging other people’s code.';
        s.default_scale = { min: 1, max: 5, labels: { 1: 'Not at all', 5: 'Completely' } };
        s.items.find((i) => i.id === 'competitiveness').enabled = true;
        s.items.find((i) => i.id === 'competitiveness').text = 'I like to win.';
      },
    });
    const { app, content } = makeApp({ contentDir: dir });
    const p = participant(app);
    await p.post('/api/session', { consent: true });
    const survey = (await p.get('/api/survey/pre')).body;
    expect(survey.items[0]).toEqual({ id: 'conf_1', text: 'I enjoy debugging other people’s code.', scale: { min: 1, max: 5, labels: { 1: 'Not at all', 5: 'Completely' } } });
    expect(survey.items.map((i) => i.id)).toEqual(['conf_1', 'conf_2', 'conf_3', 'conf_4', 'conf_5', 'competitiveness']);
    const tooHigh = await p.post('/api/survey/pre', { answers: { ...Object.fromEntries(survey.items.map((i) => [i.id, 3])), conf_2: 6 } });
    expect(tooHigh.body.error.message).toMatch(/1 to 5/);
    expect(content.survey.items[0].text).toBe('I enjoy debugging other people’s code.');
  });
});

describe("'I don't know' option (D3, off by default)", () => {
  it('is offered and stored as IDK, scored incorrect', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.dont_know_option.enabled = true;
      },
    });
    const { app, db, content } = makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    const q = await p.get('/api/question/1');
    expect(q.body.dont_know).toEqual({ key: 'IDK', label: "I don't know" });
    const res = await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'IDK', idempotencyKey: key() });
    expect(res.body.correct).toBe(false);
    expect(db.prepare('SELECT selected_option, is_correct FROM question_responses').get()).toEqual({ selected_option: 'IDK', is_correct: 0 });
  });
});

describe('random question order (D12, fixed by default)', () => {
  it('serves each participant all nine questions once, in their stored order', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.questions.order = 'random_per_participant';
      },
    });
    const { app, db, content } = makeApp({ contentDir: dir });
    const p = participant(app);
    await toQuestions(p, content);
    await answerAll(p, content);
    const order = JSON.parse(db.prepare('SELECT question_order FROM participants').get().question_order);
    const served = p.log.filter((e) => e.body?.options && e.body?.id).map((e) => e.body.id);
    expect(served).toEqual(order);
    expect([...order].sort()).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Q9']);
  });
});

describe('allocation list running out', () => {
  it('extends the list by a whole new block instead of failing', async () => {
    const dir = contentCopy({
      'study.json': (s) => {
        s.allocation.main_slots = 2;
      },
    });
    const { app, db, content } = makeApp({ contentDir: dir });
    for (let i = 0; i < 5; i++) await toQuestions(participant(app), content);
    expect(db.prepare("SELECT COUNT(*) AS n FROM allocation_slots WHERE list = 'main'").get().n).toBe(6);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'allocation_extended'").get().n).toBe(2);
  });
});

describe('static client', () => {
  it('every screen module referenced by app.js exists', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    for (const [, file] of app.matchAll(/from '\.\/(screens\/\w+\.js)'/g)) {
      expect(fs.existsSync(path.join(ROOT, 'public', 'js', file)), file).toBe(true);
    }
  });

  it('serves security headers and no-store on the API', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/texts');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
