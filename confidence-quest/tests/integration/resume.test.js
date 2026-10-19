import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ANSWER_KEY, key, makeApp, surveyAnswers } from '../helpers.js';

// "Kill the tab at every step": a brand-new client that only has the cookie must land on
// the same step, and repeating the last action must not add rows.

const counts = (db) => ({
  surveys: db.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n,
  questions: db.prepare('SELECT COUNT(*) AS n FROM question_responses').get().n,
  answered: db.prepare('SELECT COUNT(*) AS n FROM question_responses WHERE answered_at IS NOT NULL').get().n,
  slots: db.prepare('SELECT COUNT(*) AS n FROM allocation_slots WHERE claimed_by IS NOT NULL').get().n,
  game: db.prepare('SELECT COUNT(*) AS n FROM gamification_events').get().n,
});

describe('resume after closing the tab', () => {
  it('returns to the stored step at every step with no loss or duplicates', async () => {
    const { app, db, content } = makeApp();
    const first = await request(app).post('/api/session').send({ consent: true });
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    // A fresh client each time, carrying only the cookie (like a reopened browser).
    const fresh = () => ({
      get: (url) => request(app).get(url).set('Cookie', cookie),
      post: (url, body = {}) => request(app).post(url).set('Cookie', cookie).send(body),
    });
    const expectStep = async (step, n) => {
      const state = (await fresh().get('/api/state')).body;
      expect(state.step).toBe(step);
      if (n !== undefined) expect(state.n).toBe(n);
    };

    await expectStep('PRE_SURVEY');
    const pre = { answers: surveyAnswers(content, 'pre'), idempotencyKey: key() };
    await fresh().post('/api/survey/pre', pre);
    await fresh().post('/api/survey/pre', pre);
    await expectStep('INSTRUCTIONS');
    expect(counts(db)).toMatchObject({ surveys: 5, slots: 1 });

    await fresh().post('/api/instructions/ack');
    await fresh().post('/api/instructions/ack');
    await expectStep('QUESTION', 1);

    for (let n = 1; n <= 9; n++) {
      const q1 = await fresh().get(`/api/question/${n}`);
      const shownAt = db.prepare('SELECT shown_at FROM question_responses WHERE question_id = ?').get(q1.body.id).shown_at;
      await new Promise((r) => setTimeout(r, 5));
      await fresh().get(`/api/question/${n}`); // refresh keeps the original shown_at
      expect(db.prepare('SELECT shown_at FROM question_responses WHERE question_id = ?').get(q1.body.id).shown_at).toBe(shownAt);
      await expectStep('QUESTION', n);

      const body = { questionId: q1.body.id, selectedOption: ANSWER_KEY[q1.body.id], idempotencyKey: key() };
      const a = await fresh().post('/api/answer', body);
      const repeat = await fresh().post('/api/answer', body);
      expect(repeat.body).toEqual(a.body);
      await expectStep('FEEDBACK', n);
      const state = (await fresh().get('/api/state')).body;
      expect(state.feedback).toEqual(a.body);

      await fresh().post('/api/next', { n });
      await fresh().post('/api/next', { n });
      expect(counts(db)).toMatchObject({ questions: n, answered: n });
    }
    await expectStep('FINAL');
    const gameBefore = counts(db).game;

    const r1 = (await fresh().get('/api/results')).body;
    const r2 = (await fresh().get('/api/results')).body;
    expect(r2.score).toEqual(r1.score);
    await expectStep('FINAL');
    expect(counts(db).game).toBeGreaterThanOrEqual(gameBefore);

    await fresh().post('/api/results/ack');
    await fresh().post('/api/results/ack');
    await expectStep('POST_SURVEY');

    const post = { answers: surveyAnswers(content, 'post'), idempotencyKey: key() };
    await fresh().post('/api/survey/post', post);
    await fresh().post('/api/survey/post', post);
    await expectStep('DEBRIEF');
    expect(counts(db)).toMatchObject({ surveys: 10, questions: 9, answered: 9, slots: 1 });

    const d1 = (await fresh().post('/api/complete')).body;
    const d2 = (await fresh().post('/api/complete')).body;
    expect(d2).toEqual(d1);
    await expectStep('DEBRIEF');
  });

  it('survives a server restart without losing anything already submitted', async () => {
    const { app, db, content, config } = makeApp();
    const res = await request(app).post('/api/session').send({ consent: true });
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    await request(app).post('/api/survey/pre').set('Cookie', cookie).send({ answers: surveyAnswers(content, 'pre') });
    await request(app).post('/api/instructions/ack').set('Cookie', cookie).send({});
    await request(app).get('/api/question/1').set('Cookie', cookie);
    await request(app).post('/api/answer').set('Cookie', cookie).send({ questionId: 'Q1', selectedOption: 'D', idempotencyKey: key() });
    db.close();

    const restarted = makeApp({ dbPath: config.dbPath });
    const state = (await request(restarted.app).get('/api/state').set('Cookie', cookie)).body;
    expect(state).toMatchObject({ step: 'FEEDBACK', n: 1, feedback: { correct: true } });
    expect(restarted.db.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n).toBe(5);
  });
});
