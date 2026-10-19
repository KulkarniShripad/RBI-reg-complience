import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, answerAll, consent, finish, key, makeApp, participant, surveyAnswers, toQuestions } from '../helpers.js';

let ctx;
beforeEach(() => {
  ctx = makeApp();
});

const errorCode = (res) => res.body?.error?.code;

describe('public endpoints', () => {
  it('GET /healthz', async () => {
    const res = await request(ctx.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/texts returns consent and UI text without a session', async () => {
    const res = await request(ctx.app).get('/api/texts');
    expect(res.status).toBe(200);
    expect(res.body.consent.version).toBe(ctx.content.study.consent.version);
  });

  it('serves the participant page and the admin page', async () => {
    expect((await request(ctx.app).get('/')).text).toContain('<main id="app"');
    expect((await request(ctx.app).get('/admin')).text).toContain('Admin token');
  });

  it('unknown API routes are 404 and content files are not served', async () => {
    expect(errorCode(await request(ctx.app).get('/api/nope'))).toBe('NOT_FOUND');
    for (const file of ['answer_key.json', 'content/answer_key.json', 'server/content/answer_key.json']) {
      expect((await request(ctx.app).get(`/${file}`)).status).toBe(404);
    }
  });
});

describe('POST /api/session', () => {
  it('creates the participant and sets an HttpOnly SameSite cookie', async () => {
    const res = await request(ctx.app).post('/api/session').send({ consent: true });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ step: 'PRE_SURVEY', total_questions: 9 });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^cq_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const row = ctx.db.prepare('SELECT * FROM participants').get();
    expect(row.participant_code).toMatch(/^[ACDEFHJKMNPQRTUVWXY3479]{6}$/);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).not.toContain(row.token_hash);
  });

  it('VALIDATION without consent, and a refusal stores nothing', async () => {
    for (const body of [{}, { consent: false }, { consent: 'yes' }]) {
      const res = await request(ctx.app).post('/api/session').send(body);
      expect(res.status).toBe(400);
      expect(errorCode(res)).toBe('VALIDATION');
    }
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n).toBe(0);
  });

  it('VALIDATION for malformed JSON', async () => {
    const res = await request(ctx.app).post('/api/session').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION');
  });

  it('the same device starting again keeps its session', async () => {
    const p = participant(ctx.app);
    await consent(p);
    const again = await p.post('/api/session', { consent: true });
    expect(again.status).toBe(200);
    expect(again.body.step).toBe('PRE_SURVEY');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n).toBe(1);
  });
});

describe('without a session', () => {
  it('GET /api/state reports the consent step (S0) and logs no error', async () => {
    const res = await request(ctx.app).get('/api/state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ step: 'CONSENT' });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type = 'error'").get().n).toBe(0);
  });
});

describe('participant endpoints without a session return NO_SESSION', () => {
  const routes = [
    ['get', '/api/survey/pre'],
    ['post', '/api/survey/pre'],
    ['post', '/api/instructions/ack'],
    ['get', '/api/question/1'],
    ['post', '/api/answer'],
    ['post', '/api/next'],
    ['get', '/api/results'],
    ['post', '/api/results/ack'],
    ['post', '/api/complete'],
    ['post', '/api/withdraw'],
  ];
  it.each(routes)('%s %s', async (method, url) => {
    const res = await request(ctx.app)[method](url).set('Cookie', 'cq_session=not-a-real-token').send({});
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('NO_SESSION');
  });
});

describe('surveys', () => {
  it('GET /api/survey/:phase returns items for the current phase only', async () => {
    const p = participant(ctx.app);
    await consent(p);
    const pre = await p.get('/api/survey/pre');
    expect(pre.status).toBe(200);
    expect(pre.body.items.map((i) => i.id)).toEqual(['conf_1', 'conf_2', 'conf_3', 'conf_4', 'conf_5']);
    expect(pre.body.items[0]).not.toHaveProperty('reverse');
    expect(errorCode(await p.get('/api/survey/post'))).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.get('/api/survey/middle'))).toBe('VALIDATION');
  });

  it('rejects a missing item and an out-of-range value, saving nothing', async () => {
    const p = participant(ctx.app);
    await consent(p);
    const answers = surveyAnswers(ctx.content, 'pre');
    const missing = { ...answers };
    delete missing.conf_3;
    const r1 = await p.post('/api/survey/pre', { answers: missing });
    expect(r1.status).toBe(400);
    expect(r1.body.error.message).toBe('Please answer every statement before continuing.');
    const r2 = await p.post('/api/survey/pre', { answers: { ...answers, conf_2: 9 } });
    expect(r2.status).toBe(400);
    expect(r2.body.error.message).toMatch(/1 to 7/);
    expect(errorCode(await p.post('/api/survey/pre', { answers: 'nope' }))).toBe('VALIDATION');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n).toBe(0);
    expect(ctx.db.prepare('SELECT arm FROM participants').get().arm).toBeNull();
  });

  it('pre submit assigns the arm; a repeat submit is ignored', async () => {
    const p = participant(ctx.app);
    await consent(p);
    const body = { answers: surveyAnswers(ctx.content, 'pre'), idempotencyKey: key() };
    const first = await p.post('/api/survey/pre', body);
    expect(first.status).toBe(200);
    expect(first.body.state.step).toBe('INSTRUCTIONS');
    const repeat = await p.post('/api/survey/pre', body);
    expect(repeat.status).toBe(200);
    expect(repeat.body.already_submitted).toBe(true);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n).toBe(5);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM allocation_slots WHERE claimed_by IS NOT NULL').get().n).toBe(1);
    expect(['control', 'experimental']).toContain(ctx.db.prepare('SELECT arm FROM participants').get().arm);
  });

  it('the post survey is NOT_YOUR_TURN before all nine questions', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    const res = await p.post('/api/survey/post', { answers: surveyAnswers(ctx.content, 'post') });
    expect(errorCode(res)).toBe('NOT_YOUR_TURN');
  });
});

describe('questions', () => {
  it('cannot reach the questions without finishing the pre-survey', async () => {
    const p = participant(ctx.app);
    await consent(p);
    expect(errorCode(await p.post('/api/instructions/ack'))).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.get('/api/question/1'))).toBe('NOT_YOUR_TURN');
  });

  it('GET /api/question/5 while on question 3 is NOT_YOUR_TURN', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    for (let n = 1; n <= 2; n++) {
      const q = await p.get(`/api/question/${n}`);
      await p.post('/api/answer', { questionId: q.body.id, selectedOption: 'A', idempotencyKey: key() });
      await p.post('/api/next', { n });
    }
    expect((await p.get('/api/state')).body).toMatchObject({ step: 'QUESTION', n: 3 });
    const res = await p.get('/api/question/5');
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.get('/api/question/2'))).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.get('/api/question/three'))).toBe('VALIDATION');
  });

  it('serves the question without the answer key', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    const q = await p.get('/api/question/1');
    expect(q.status).toBe(200);
    expect(Object.keys(q.body).sort()).toEqual(
      ['code', 'id', 'language', 'n', 'options', 'options_format', 'progress_text', 'prompt', 'section', 'submit_button', 'total'].sort(),
    );
    expect(q.body.options.every((o) => Object.keys(o).join() === 'key,text')).toBe(true);
  });

  it('POST /api/answer validates, scores, and ignores repeats', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    expect(errorCode(await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'A', idempotencyKey: key() }))).toBe('NOT_YOUR_TURN');
    await p.get('/api/question/1');
    expect(errorCode(await p.post('/api/answer', { questionId: 'Q2', selectedOption: 'A', idempotencyKey: key() }))).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'E', idempotencyKey: key() }))).toBe('VALIDATION');
    expect(errorCode(await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'IDK', idempotencyKey: key() }))).toBe('VALIDATION');
    expect(errorCode(await p.post('/api/answer', { questionId: 'Q99', selectedOption: 'A', idempotencyKey: key() }))).toBe('VALIDATION');
    expect(errorCode(await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'D' }))).toBe('VALIDATION');

    const first = await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'D', idempotencyKey: 'abc12345' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ correct: true, next: { step: 'QUESTION', n: 2 } });
    const again = await p.post('/api/answer', { questionId: 'Q1', selectedOption: 'A', idempotencyKey: 'abc12345' });
    expect(again.body).toEqual(first.body);
    const row = ctx.db.prepare("SELECT * FROM question_responses WHERE question_id = 'Q1'").get();
    expect(row).toMatchObject({ selected_option: 'D', is_correct: 1 });
    expect(row.time_taken_ms).toBeGreaterThanOrEqual(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM question_responses').get().n).toBe(1);
  });

  it('POST /api/next moves on, and repeats are harmless', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    expect(errorCode(await p.post('/api/next', { n: 1 }))).toBe('NOT_YOUR_TURN');
    const q = await p.get('/api/question/1');
    await p.post('/api/answer', { questionId: q.body.id, selectedOption: 'B', idempotencyKey: key() });
    expect((await p.post('/api/next', { n: 1 })).body.state).toMatchObject({ step: 'QUESTION', n: 2 });
    expect((await p.post('/api/next', { n: 1 })).status).toBe(200);
    expect((await p.get('/api/state')).body).toMatchObject({ step: 'QUESTION', n: 2 });
    expect(errorCode(await p.post('/api/next', {}))).toBe('VALIDATION');
  });
});

describe('results, post-survey, completion', () => {
  it('GET /api/results is NOT_YOUR_TURN until the ninth answer', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    expect(errorCode(await p.get('/api/results'))).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.post('/api/results/ack'))).toBe('NOT_YOUR_TURN');
    expect(errorCode(await p.post('/api/complete'))).toBe('NOT_YOUR_TURN');
    await answerAll(p, ctx.content);
    const results = await p.get('/api/results');
    expect(results.status).toBe(200);
    expect(results.body.score).toMatchObject({ correct: 9, total: 9, text: 'You answered 9 of 9 questions correctly.' });
  });

  it('completing returns the debrief and code, and is repeatable', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    await answerAll(p, ctx.content);
    const { debrief } = await finish(p, ctx.content);
    const code = ctx.db.prepare('SELECT participant_code FROM participants').get().participant_code;
    expect(debrief.participant_code).toBe(code);
    const again = await p.post('/api/complete');
    expect(again.body).toEqual(debrief);
    const row = ctx.db.prepare('SELECT status, current_step, completed_at FROM participants').get();
    expect(row).toMatchObject({ status: 'completed', current_step: 'DEBRIEF' });
    expect(row.completed_at).toBeTruthy();
    // Coming back after completing shows the debrief, not the test.
    expect((await p.post('/api/session', { consent: true })).body.step).toBe('DEBRIEF');
    expect((await p.get('/api/state')).body.step).toBe('DEBRIEF');
    expect(errorCode(await p.post('/api/withdraw', { confirm: true }))).toBe('NOT_YOUR_TURN');
  });
});

describe('stopping (withdraw)', () => {
  it('marks the participant abandoned, blocks further actions, keeps the slot', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    expect(errorCode(await p.post('/api/withdraw', {}))).toBe('VALIDATION');
    const res = await p.post('/api/withdraw', { confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.step).toBe('WITHDRAWN');
    expect((await p.get('/api/state')).body.step).toBe('WITHDRAWN');
    const blocked = await p.get('/api/question/1');
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked)).toBe('FORBIDDEN');
    expect(ctx.db.prepare('SELECT status FROM participants').get().status).toBe('abandoned');

    // The next participant gets the next slot, not the abandoned one.
    const slotOfFirst = ctx.db.prepare('SELECT allocation_slot_id AS id FROM participants').get().id;
    const q = participant(ctx.app);
    await toQuestions(q, ctx.content);
    const slots = ctx.db.prepare('SELECT allocation_slot_id AS id FROM participants ORDER BY started_at').all().map((r) => r.id);
    expect(slots).toEqual([slotOfFirst, slotOfFirst + 1]);
  });
});

describe('SERVER errors', () => {
  it('returns SERVER 500 with no detail and logs the error code', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    ctx.db.exec('ALTER TABLE question_responses RENAME TO broken_table');
    const res = await p.get('/api/question/1');
    expect(res.status).toBe(500);
    expect(errorCode(res)).toBe('SERVER');
    expect(res.text).not.toMatch(/broken_table|question_responses|sqlite/i);
    const logged = ctx.db.prepare("SELECT participant_id, payload FROM events WHERE event_type = 'error'").get();
    expect(logged.participant_id).toBeTruthy();
    expect(JSON.parse(logged.payload)).toEqual({ code: 'SERVER', method: 'GET', route: '/api/question/:n' });
  });

  it('logs participant errors with a code only, never the text they sent', async () => {
    const p = participant(ctx.app);
    await consent(p);
    await p.post('/api/survey/pre', { answers: { conf_1: 99, 'secret note from participant': 1 } });
    const payloads = ctx.db.prepare("SELECT payload FROM events WHERE event_type = 'error'").all().map((r) => r.payload);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toMatch(/secret/);
    expect(JSON.parse(payloads[0]).code).toBe('VALIDATION');
  });
});

describe('admin', () => {
  const adminRoutes = [
    ['get', '/admin/api/status'],
    ['get', '/admin/api/export/participants.csv'],
    ['post', '/admin/api/backup'],
    ['post', '/admin/api/mode'],
    ['post', '/admin/api/purge-pilot'],
    ['post', '/admin/api/withdraw'],
    ['get', '/admin/api/anything-else'],
  ];

  it.each(adminRoutes)('%s %s is FORBIDDEN without the right token and reveals nothing', async (method, url) => {
    for (const token of [undefined, 'wrong-token', `${ADMIN_TOKEN}x`]) {
      let req = request(ctx.app)[method](url);
      if (token) req = req.set('X-Admin-Token', token);
      const res = await req.send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
    }
  });

  it('admin is fully disabled when ADMIN_TOKEN is not set', async () => {
    const noToken = makeApp({ env: { ADMIN_TOKEN: '' } });
    const res = await request(noToken.app).get('/admin/api/status').set('X-Admin-Token', '');
    expect(res.status).toBe(403);
  });

  const admin = (method, url) => request(ctx.app)[method](url).set('X-Admin-Token', ADMIN_TOKEN);

  it('status counts participants by arm and step', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    const res = await admin('get', '/admin/api/status');
    expect(res.status).toBe(200);
    expect(res.body.study_mode).toBe('live');
    expect(res.body.live.total).toBe(1);
    expect(res.body.live.by_step.QUESTION).toBe(1);
    expect(res.body.allocation.lists.main).toMatchObject({ claimed: 1 });
  });

  it('exports each CSV and 404s an unknown one', async () => {
    for (const name of ['participants', 'questions', 'surveys', 'events', 'gamification', 'allocation', 'meta']) {
      const res = await admin('get', `/admin/api/export/${name}.csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
    }
    expect((await admin('get', '/admin/api/export/secrets.csv')).status).toBe(404);
  });

  it('backup copies the database file', async () => {
    const res = await admin('post', '/admin/api/backup');
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(ctx.config.backupDir, res.body.file))).toBe(true);
  });

  it('pilot mode marks new participants as pilot; purge removes them', async () => {
    expect((await admin('post', '/admin/api/mode').send({ mode: 'test' })).status).toBe(400);
    await admin('post', '/admin/api/mode').send({ mode: 'pilot' }).expect(200);
    const pilot = participant(ctx.app);
    await toQuestions(pilot, ctx.content);
    await admin('post', '/admin/api/mode').send({ mode: 'live' }).expect(200);
    const live = participant(ctx.app);
    await toQuestions(live, ctx.content);

    const rows = ctx.db.prepare('SELECT is_pilot, s.list FROM participants p JOIN allocation_slots s ON s.id = p.allocation_slot_id ORDER BY started_at').all();
    expect(rows).toEqual([{ is_pilot: 1, list: 'pilot' }, { is_pilot: 0, list: 'main' }]);

    expect((await admin('post', '/admin/api/purge-pilot').send({ confirm: 'yes' })).status).toBe(400);
    const purge = await admin('post', '/admin/api/purge-pilot').send({ confirm: 'DELETE PILOT DATA' });
    expect(purge.body).toEqual({ ok: true, removed: 1 });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM participants').get().n).toBe(1);
    expect((await pilot.get('/api/state')).body.step).toBe('CONSENT');
    expect((await live.get('/api/state')).body.step).toBe('QUESTION');
  });

  it('withdraws a participant’s data by code', async () => {
    const p = participant(ctx.app);
    await toQuestions(p, ctx.content);
    const code = ctx.db.prepare('SELECT participant_code FROM participants').get().participant_code;
    expect((await admin('post', '/admin/api/withdraw').send({ participant_code: 'NOPE', confirm: true })).status).toBe(400);
    expect((await admin('post', '/admin/api/withdraw').send({ participant_code: 'AAAAAA', confirm: true })).status).toBe(404);
    await admin('post', '/admin/api/withdraw').send({ participant_code: code, confirm: true }).expect(200);
    expect(ctx.db.prepare('SELECT status FROM participants').get().status).toBe('withdrawn');
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n).toBe(0);
    expect((await p.get('/api/state')).body.step).toBe('WITHDRAWN');
  });
});
