import crypto from 'node:crypto';
import { getMeta } from '../db/connection.js';
import { AppError } from '../middleware/errors.js';
import { nowIso, randomCode, randomToken, sha256, fillTemplate } from '../util.js';
import { claimSlot, listFor } from './assignment.js';
import { allowedOptions, isCorrect, scoreRaw } from './scoring.js';
import { itemsForPhase, scaleOf, validateSurveySubmission } from './surveyScoring.js';
import * as game from './gamification.js';

// S0 consent happens before a participant row exists, so it is not a stored step.
export const STEPS = ['PRE_SURVEY', 'INSTRUCTIONS', 'QUESTION', 'FEEDBACK', 'FINAL', 'POST_SURVEY', 'DEBRIEF'];
const STAGE = { PRE_SURVEY: 1, INSTRUCTIONS: 2, QUESTION: 3, FEEDBACK: 3, FINAL: 4, POST_SURVEY: 5, DEBRIEF: 6 };

const notYourTurn = (message = 'That step is not available right now.') => new AppError('NOT_YOUR_TURN', message);

export function createStudy({ db, content }) {
  const { study, survey, gamification: gam, questions, questionsById, answerKey } = content;
  const totalQuestions = questions.length;

  const sql = {
    participant: db.prepare('SELECT * FROM participants WHERE id = ?'),
    codeTaken: db.prepare('SELECT 1 FROM participants WHERE participant_code = ?'),
    nameTaken: db.prepare('SELECT 1 FROM participants WHERE leaderboard_name = ?'),
    insertParticipant: db.prepare(`
      INSERT INTO participants (id, participant_code, token_hash, is_pilot, consent_at, consent_version, current_step, started_at, status)
      VALUES (@id, @participant_code, @token_hash, @is_pilot, @now, @consent_version, 'PRE_SURVEY', @now, 'in_progress')`),
    surveyCount: db.prepare('SELECT COUNT(*) AS n FROM survey_responses WHERE participant_id = ? AND phase = ?'),
    insertSurvey: db.prepare(
      'INSERT INTO survey_responses (participant_id, phase, item_id, value, submitted_at) VALUES (?, ?, ?, ?, ?)',
    ),
    response: db.prepare('SELECT * FROM question_responses WHERE participant_id = ? AND question_id = ?'),
    closedResponses: db.prepare(
      'SELECT * FROM question_responses WHERE participant_id = ? AND (answered_at IS NOT NULL OR expired = 1) ORDER BY position',
    ),
    markShown: db.prepare(
      'INSERT OR IGNORE INTO question_responses (participant_id, question_id, position, shown_at) VALUES (?, ?, ?, ?)',
    ),
    recordAnswer: db.prepare(`
      UPDATE question_responses SET selected_option = ?, is_correct = ?, answered_at = ?, time_taken_ms = ?, idempotency_key = ?
      WHERE participant_id = ? AND question_id = ? AND answered_at IS NULL AND expired = 0`),
    insertGameEvent: db.prepare(
      'INSERT INTO gamification_events (participant_id, type, key, value, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    insertEvent: db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)'),
  };

  const update = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE participants SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  };

  function logEvent(participantId, type, payload = null) {
    sql.insertEvent.run(participantId, type, payload === null ? null : JSON.stringify(payload), nowIso());
  }

  const reload = (p) => sql.participant.get(p.id);
  const orderOf = (p) => JSON.parse(p.question_order);
  const isActive = (p) => p.status === 'in_progress' || p.status === 'completed';

  function assertActive(p) {
    if (!isActive(p)) throw new AppError('FORBIDDEN', 'You have stopped taking part, so this is no longer available.');
  }

  // Runs `fn` in a write-locked transaction on a fresh copy of the participant row.
  const tx = (p, fn) => db.transaction(() => fn(reload(p))).immediate();

  // ---------- time limit (D10) ----------

  function deadlineOf(p) {
    const limit = study.questions.time_limit;
    if (!limit.enabled || !p.questions_started_at) return null;
    return new Date(Date.parse(p.questions_started_at) + limit.total_seconds * 1000);
  }

  // Closes the test when the time limit has passed: unanswered questions are stored as
  // expired (no answer, incorrect) and the participant moves on to the final screen.
  function applyExpiry(p) {
    if (!isActive(p) || (p.current_step !== 'QUESTION' && p.current_step !== 'FEEDBACK')) return p;
    if (p.questions_finished_at) return p; // all nine already answered; only the last feedback is open
    const deadline = deadlineOf(p);
    if (!deadline || Date.now() < deadline.getTime()) return p;
    return tx(p, (cur) => {
      if (cur.current_step !== 'QUESTION' && cur.current_step !== 'FEEDBACK') return cur;
      const order = orderOf(cur);
      const shownAt = deadline.toISOString();
      order.forEach((qid, i) => {
        sql.markShown.run(cur.id, qid, i + 1, shownAt);
        db.prepare(
          'UPDATE question_responses SET expired = 1, is_correct = 0 WHERE participant_id = ? AND question_id = ? AND answered_at IS NULL',
        ).run(cur.id, qid);
      });
      update(cur.id, { current_step: 'FINAL', current_question: null, questions_finished_at: shownAt });
      logEvent(cur.id, 'time_expired', { at_position: cur.current_question });
      return reload(cur);
    });
  }

  function timer(p) {
    const deadline = deadlineOf(p);
    if (!deadline) return {};
    return {
      deadline_at: deadline.toISOString(),
      time_remaining_s: Math.max(0, Math.round((deadline.getTime() - Date.now()) / 1000)),
    };
  }

  // ---------- S0: consent / session ----------

  function createParticipant() {
    const token = randomToken();
    const id = crypto.randomUUID();
    const isPilot = getMeta(db, 'study_mode') === 'pilot' ? 1 : 0;
    db.transaction(() => {
      let code;
      do code = randomCode();
      while (sql.codeTaken.get(code));
      sql.insertParticipant.run({
        id,
        participant_code: code,
        token_hash: sha256(token),
        is_pilot: isPilot,
        now: nowIso(),
        consent_version: study.consent.version,
      });
      logEvent(id, 'consent_given', { consent_version: study.consent.version });
    }).immediate();
    return { token, participant: sql.participant.get(id) };
  }

  // ---------- state ----------

  function instructionsFor(p) {
    const paragraphs = [...study.instructions.paragraphs];
    // D4: the experimental arm may get one extra line explaining the game features.
    if (p.arm === 'experimental' && gam.instructions_extra && game.anyGameFeature(gam)) paragraphs.push(gam.instructions_extra);
    return { title: study.instructions.title, paragraphs, start_button: study.instructions.start_button };
  }

  // The current step and question number. Never includes the arm label.
  function publicState(participant) {
    const p = applyExpiry(reload(participant));
    if (!isActive(p)) {
      return { step: 'WITHDRAWN', withdrawn: { title: study.withdraw.title, paragraphs: study.withdraw.paragraphs } };
    }
    const state = { step: p.current_step, total_questions: totalQuestions };
    if (p.current_step === 'INSTRUCTIONS') state.instructions = instructionsFor(p);
    if (p.current_step === 'QUESTION' || p.current_step === 'FEEDBACK') {
      state.n = p.current_question;
      Object.assign(state, timer(p));
    }
    if (p.current_step === 'FEEDBACK') state.feedback = storedResult(p, orderOf(p)[p.current_question - 1]);
    return state;
  }

  // ---------- S1 / S6: surveys ----------

  function getSurvey(p, phase) {
    assertActive(p);
    const expected = phase === 'pre' ? 'PRE_SURVEY' : 'POST_SURVEY';
    if (p.current_step !== expected) throw notYourTurn();
    return {
      phase,
      title: study.surveys[phase].title,
      intro: study.surveys[phase].intro,
      submit_button: study.surveys.submit_button,
      missing_message: study.surveys.missing_message,
      items: itemsForPhase(survey, phase).map((item) => ({ id: item.id, text: item.text, scale: scaleOf(survey, item) })),
    };
  }

  function submitSurvey(participant, phase, answers) {
    return tx(participant, (p) => {
      assertActive(p);
      // A repeat submit (double click, retry) is ignored.
      if (sql.surveyCount.get(p.id, phase).n > 0) return { already_submitted: true };
      const expected = phase === 'pre' ? 'PRE_SURVEY' : 'POST_SURVEY';
      if (p.current_step !== expected) throw notYourTurn();
      const rows = validateSurveySubmission(survey, phase, answers, study.surveys.missing_message);
      const now = nowIso();
      for (const row of rows) sql.insertSurvey.run(p.id, phase, row.item_id, row.value, now);
      logEvent(p.id, 'survey_submitted', { phase, items: rows.length });
      if (phase === 'pre') assignArm(p, now);
      else {
        update(p.id, { current_step: 'DEBRIEF', status: 'completed', completed_at: now });
        logEvent(p.id, 'completed');
      }
      return { already_submitted: false };
    });
  }

  // Random assignment happens when the pre-survey is submitted (Level 4).
  function assignArm(p, now) {
    const slot = claimSlot(db, p.id, listFor(p.is_pilot === 1, study.allocation));
    const order = questions.map((q) => q.id);
    if (study.questions.order === 'random_per_participant') {
      for (let i = order.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    const fields = {
      arm: slot.arm,
      allocation_slot_id: slot.id,
      assigned_at: now,
      current_step: 'INSTRUCTIONS',
      question_order: JSON.stringify(order),
    };
    if (slot.arm === 'experimental') fields.leaderboard_name = game.pickLeaderboardName(gam, (name) => sql.nameTaken.get(name));
    update(p.id, fields);
    logEvent(p.id, 'arm_assigned', { slot_id: slot.id, seq_no: slot.seq_no });
  }

  // ---------- S2: instructions ----------

  function ackInstructions(participant) {
    return tx(participant, (p) => {
      assertActive(p);
      if (STAGE[p.current_step] > STAGE.INSTRUCTIONS) return; // repeat click
      if (p.current_step !== 'INSTRUCTIONS') throw notYourTurn();
      update(p.id, { current_step: 'QUESTION', current_question: 1, questions_started_at: nowIso() });
      logEvent(p.id, 'instructions_ack');
    });
  }

  // ---------- S3 / S4: questions and feedback ----------

  function getQuestion(participant, n) {
    return tx(participant, (p) => {
      assertActive(p);
      if (p.current_step !== 'QUESTION' || p.current_question !== n) {
        throw notYourTurn('You can only open the question you are currently on.');
      }
      const qid = orderOf(p)[n - 1];
      // shown_at is set the first time only, so a refresh does not reset the clock.
      const inserted = sql.markShown.run(p.id, qid, n, nowIso()).changes === 1;
      if (inserted) logEvent(p.id, 'question_shown', { n, question_id: qid });
      const q = questionsById[qid];
      const out = {
        n,
        total: totalQuestions,
        id: q.id,
        prompt: q.prompt,
        options_format: q.options_format,
        options: q.options.map((o) => ({ key: o.key, text: o.text })),
        submit_button: study.questions.submit_button,
        progress_text: fillTemplate(study.questions.progress_text, { n, total: totalQuestions }),
        ...timer(p),
      };
      if (study.questions.show_section) out.section = q.section;
      if (study.questions.show_difficulty_labels) out.difficulty_label = q.difficulty_label;
      if (q.code !== undefined) {
        out.code = q.code;
        out.language = q.language ?? null;
      }
      if (q.note) out.note = q.note;
      if (study.questions.dont_know_option.enabled) out.dont_know = { key: 'IDK', label: study.questions.dont_know_option.label };
      return out;
    });
  }

  // Where the Next button on this question's feedback leads. For an old question
  // (a late repeat) it is simply wherever the participant is now.
  function nextAfter(p, position) {
    if (p.current_step === 'FEEDBACK' && p.current_question === position) {
      return position < totalQuestions ? { step: 'QUESTION', n: position + 1 } : { step: 'FINAL' };
    }
    return p.current_question ? { step: p.current_step, n: p.current_question } : { step: p.current_step };
  }

  function gameForPosition(p, position) {
    const responses = sql.closedResponses.all(p.id).filter((r) => r.position <= position);
    return game.feedbackGame(gam, game.computeGameState(gam, questions, responses), position);
  }

  // The reply to an answer, rebuilt from the stored row so repeats return the same thing.
  function storedResult(p, questionId) {
    const row = sql.response.get(p.id, questionId);
    if (!row || (row.answered_at === null && row.expired === 0)) return null;
    const result = {
      n: row.position,
      correct: row.is_correct === 1,
      expired: row.expired === 1,
      next: nextAfter(p, row.position),
      next_button: row.position < totalQuestions ? study.feedback.next_button : study.feedback.last_button,
      text: row.is_correct === 1 ? study.feedback.correct_text : study.feedback.incorrect_text,
    };
    if (p.arm === 'experimental') result.game = gameForPosition(p, row.position);
    return result;
  }

  function submitAnswer(participant, { questionId, selectedOption, idempotencyKey }) {
    const fresh = applyExpiry(participant);
    return tx(fresh, (p) => {
      assertActive(p);
      if (!questionsById[questionId]) throw new AppError('VALIDATION', 'Unknown question.');
      // Second submit for the same question: ignore it and return the stored result.
      const stored = storedResult(p, questionId);
      if (stored) return stored;
      const order = orderOf(p);
      if (p.current_step !== 'QUESTION' || order[p.current_question - 1] !== questionId) {
        throw notYourTurn('That is not the question you are on.');
      }
      if (!allowedOptions(study).includes(selectedOption)) throw new AppError('VALIDATION', 'Please choose one of the options.');
      const row = sql.response.get(p.id, questionId);
      if (!row) throw notYourTurn('Please open the question before answering it.');

      const now = new Date();
      const correct = isCorrect(answerKey, questionId, selectedOption) ? 1 : 0;
      const taken = Math.max(0, now.getTime() - Date.parse(row.shown_at));
      sql.recordAnswer.run(selectedOption, correct, now.toISOString(), taken, idempotencyKey, p.id, questionId);
      const position = p.current_question;
      const fields = { current_step: 'FEEDBACK' };
      if (position === totalQuestions) fields.questions_finished_at = now.toISOString();
      update(p.id, fields);
      logEvent(p.id, 'answer_submitted', { n: position, question_id: questionId });

      const after = reload(p);
      const result = storedResult(after, questionId);
      if (p.arm === 'experimental') {
        const state = game.computeGameState(gam, questions, sql.closedResponses.all(p.id));
        const step = state.steps.find((s) => s.position === position);
        if (step.tokens > 0) sql.insertGameEvent.run(p.id, 'tokens', questionId, step.tokens, now.toISOString());
        for (const key of step.new_badges) sql.insertGameEvent.run(p.id, 'badge', key, 1, now.toISOString());
      }
      return result;
    });
  }

  function ackFeedback(participant, n) {
    const fresh = applyExpiry(participant);
    return tx(fresh, (p) => {
      assertActive(p);
      if (p.current_step === 'FEEDBACK' && p.current_question === n) {
        if (n < totalQuestions) update(p.id, { current_step: 'QUESTION', current_question: n + 1 });
        else update(p.id, { current_step: 'FINAL', current_question: null });
        logEvent(p.id, 'feedback_ack', { n });
        return;
      }
      // Repeat click after the participant already moved on.
      const movedOn =
        (p.current_step === 'QUESTION' && p.current_question === n + 1) || (STAGE[p.current_step] > STAGE.FEEDBACK && n <= totalQuestions);
      if (!movedOn) throw notYourTurn();
    });
  }

  // ---------- S5: final screen ----------

  function leaderboardEntries(p) {
    const includePilot = gam.leaderboard.include_pilot_results;
    const pool = db
      .prepare(
        `SELECT id, leaderboard_name, questions_finished_at FROM participants
         WHERE arm = 'experimental' AND questions_finished_at IS NOT NULL AND status != 'withdrawn'
           AND (is_pilot = ? OR (? = 1 AND is_pilot = 1))`,
      )
      .all(p.is_pilot, p.is_pilot === 0 && includePilot ? 1 : 0);
    const byParticipant = new Map(pool.map((row) => [row.id, []]));
    if (pool.length) {
      const rows = db
        .prepare(
          `SELECT * FROM question_responses WHERE participant_id IN (${pool.map(() => '?').join(',')})
           AND (answered_at IS NOT NULL OR expired = 1)`,
        )
        .all(...pool.map((row) => row.id));
      for (const r of rows) byParticipant.get(r.participant_id).push(r);
    }
    return pool.map((row) => {
      const responses = byParticipant.get(row.id);
      const state = game.computeGameState(gam, questions, responses);
      return {
        id: row.id,
        name: row.leaderboard_name,
        tokens: state.tokens_total,
        score_raw: scoreRaw(responses),
        finished_at: row.questions_finished_at,
        total_time_ms: responses.reduce((sum, r) => sum + (r.time_taken_ms ?? 0), 0),
      };
    });
  }

  function getResults(participant) {
    const fresh = applyExpiry(participant);
    return tx(fresh, (p) => {
      assertActive(p);
      if (p.current_step !== 'FINAL') throw notYourTurn();
      const responses = sql.closedResponses.all(p.id);
      const screen = study.final_screen;
      const armText = p.arm === 'experimental' ? screen.experimental : screen.control;
      const out = { title: screen.title, paragraphs: armText.paragraphs, continue_button: screen.continue_button };
      if (armText.show_score) {
        const values = { correct: scoreRaw(responses), total: totalQuestions };
        out.score = { ...values, text: fillTemplate(screen.score_text, values) };
      }
      if (p.arm === 'experimental') {
        const state = game.computeGameState(gam, questions, responses);
        const { game: g, rank, poolSize } = game.finalGame(gam, state, leaderboardEntries(p), p.id);
        out.game = g;
        // Record exactly what was shown, because the live leaderboard keeps changing.
        if (rank !== null && (gam.leaderboard.enabled || gam.rank.show !== 'none')) {
          const now = nowIso();
          sql.insertGameEvent.run(p.id, 'leaderboard_view', 'rank', rank, now);
          sql.insertGameEvent.run(p.id, 'leaderboard_view', 'pool_size', poolSize, now);
        }
      }
      logEvent(p.id, 'results_viewed');
      return out;
    });
  }

  function ackResults(participant) {
    return tx(participant, (p) => {
      assertActive(p);
      if (STAGE[p.current_step] > STAGE.FINAL) return;
      if (p.current_step !== 'FINAL') throw notYourTurn();
      update(p.id, { current_step: 'POST_SURVEY' });
      logEvent(p.id, 'results_ack');
    });
  }

  // ---------- S7: debrief ----------

  function complete(participant) {
    return tx(participant, (p) => {
      assertActive(p);
      if (p.current_step !== 'DEBRIEF') throw notYourTurn('Please finish the last survey first.');
      if (p.status !== 'completed') {
        update(p.id, { status: 'completed', completed_at: nowIso() });
        logEvent(p.id, 'completed');
      }
      const d = study.debrief;
      return {
        title: d.title,
        paragraphs: d.paragraphs,
        code_label: d.code_label,
        code_help: d.code_help,
        participant_code: p.participant_code,
        withdraw_paragraphs: d.withdraw_paragraphs,
      };
    });
  }

  // ---------- stopping ----------

  function withdraw(participant) {
    return tx(participant, (p) => {
      if (p.status === 'completed') {
        throw notYourTurn('You have already finished. To remove your answers, give your participant code to the research team.');
      }
      if (p.status === 'in_progress') {
        update(p.id, { status: 'abandoned', abandoned_at: nowIso() });
        logEvent(p.id, 'withdrawn', { at_step: p.current_step, at_question: p.current_question });
      }
      return { step: 'WITHDRAWN', withdrawn: { title: study.withdraw.title, paragraphs: study.withdraw.paragraphs } };
    });
  }

  function publicTexts() {
    return {
      study_title: study.study_title,
      consent: study.consent,
      withdraw: { link_label: study.withdraw.link_label, confirm_text: study.withdraw.confirm_text },
      ui: study.ui,
    };
  }

  return {
    logEvent,
    applyExpiry,
    createParticipant,
    publicState,
    publicTexts,
    getSurvey,
    submitSurvey,
    ackInstructions,
    getQuestion,
    submitAnswer,
    ackFeedback,
    getResults,
    ackResults,
    complete,
    withdraw,
  };
}
