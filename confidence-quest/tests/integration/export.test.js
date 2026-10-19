import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../server/config.js';
import { ADMIN_TOKEN, ANSWER_KEY, armOf, contentCopy, fullRun, makeApp, parseCsv, tmpDir, toQuestions, participant, wrongLetter } from '../helpers.js';

const exportCsv = async (app, name) =>
  (await request(app).get(`/admin/api/export/${name}.csv`).set('X-Admin-Token', ADMIN_TOKEN).expect(200)).text;

// The same synthetic study: 4 participants with fixed answers and survey values.
async function syntheticStudy(app, content) {
  const plans = [
    { choose: (id) => ANSWER_KEY[id], preValue: 3, postValue: 5 },
    { choose: (id) => ANSWER_KEY[id], preValue: 4, postValue: 4 },
    { choose: (id, n) => (n % 2 ? wrongLetter(ANSWER_KEY[id]) : ANSWER_KEY[id]), preValue: 2, postValue: 6 },
    { choose: (id) => wrongLetter(ANSWER_KEY[id]), preValue: 5, postValue: 3 },
  ];
  const runs = [];
  for (const plan of plans) runs.push(await fullRun(app, content, plan));
  return runs;
}

// Timestamps, durations and random codes/names differ between runs; everything else must not.
function normalise(csv, runs) {
  let out = csv.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<ts>');
  runs.forEach((run, i) => {
    out = out.split(run.code).join(`<P${i + 1}>`);
  });
  return out;
}

describe('exports', () => {
  it('participants.csv has the analysis columns and correct values', async () => {
    const { app, db, content } = makeApp();
    const runs = await syntheticStudy(app, content);
    const rows = parseCsv(await exportCsv(app, 'participants'));
    expect(rows).toHaveLength(4);
    expect(Object.keys(rows[0])).toEqual([
      'participant_code', 'arm', 'arm_code', 'status', 'last_step', 'started_at_utc', 'completed_at_utc', 'duration_s',
      'questions_answered', 'score_raw', 'pre_conf_mean', 'post_conf_mean', 'conf_change',
      'tokens_total', 'badges_earned', 'rank_shown', 'rank_pool_size', 'consent_version',
    ]);
    const byCode = Object.fromEntries(rows.map((r) => [r.participant_code, r]));
    const first = byCode[runs[0].code];
    // Value 3 on every item; item conf_4 is reverse-coded (3 -> 5): (3+3+3+5+3)/5 = 3.4
    expect(first).toMatchObject({ status: 'completed', score_raw: '9', questions_answered: '9', pre_conf_mean: '3.4' });
    // Post value 5: (5+5+5+3+5)/5 = 4.6 -> change 1.2
    expect(first).toMatchObject({ post_conf_mean: '4.6', conf_change: '1.2' });
    expect(byCode[runs[3].code].score_raw).toBe('0');
    expect(byCode[runs[2].code].score_raw).toBe('4');
    for (const r of rows) {
      expect(r.arm_code).toBe(r.arm === 'experimental' ? '1' : '0');
      expect(r.arm).toBe(armOf(db, r.participant_code));
      if (r.arm === 'control') expect([r.tokens_total, r.badges_earned, r.rank_shown]).toEqual(['', '', '']);
      else expect(r.rank_shown).not.toBe('');
      expect(r.started_at_utc).toMatch(/Z$/);
    }
  });

  it('long CSVs have one row per answer and per survey item', async () => {
    const { app, content } = makeApp();
    await syntheticStudy(app, content);
    const questions = parseCsv(await exportCsv(app, 'questions'));
    expect(questions).toHaveLength(36);
    expect(Object.keys(questions[0]).slice(0, 8)).toEqual([
      'participant_code', 'arm', 'question_id', 'section', 'selected_option', 'is_correct', 'time_taken_ms', 'answered_at_utc',
    ]);
    expect(questions[0]).toMatchObject({ question_id: 'Q1', section: 'Sliding Window', response_status: 'answered' });
    const surveys = parseCsv(await exportCsv(app, 'surveys'));
    expect(surveys).toHaveLength(40);
    expect(Object.keys(surveys[0]).slice(0, 5)).toEqual(['participant_code', 'arm', 'phase', 'item_id', 'value']);
    const reversed = surveys.find((s) => s.item_id === 'conf_4' && s.value === '3');
    expect(reversed).toMatchObject({ reverse: '1', value_scored: '5' });
  });

  it('allocation.csv includes the seed and every slot', async () => {
    const { app, content } = makeApp();
    await syntheticStudy(app, content);
    const slots = parseCsv(await exportCsv(app, 'allocation'));
    expect(slots.length).toBeGreaterThanOrEqual(content.study.allocation.main_slots);
    expect(new Set(slots.map((s) => s.seed))).toEqual(new Set(['test-seed']));
    expect(slots.filter((s) => s.claimed === '1')).toHaveLength(4);
    const meta = parseCsv(await exportCsv(app, 'meta'));
    expect(meta.find((m) => m.key === 'allocation_seed').value).toBe('test-seed');
    expect(meta.find((m) => m.key === 'content_sha256:questions.json').value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the same synthetic run twice gives identical CSVs apart from timestamps', async () => {
    const a = makeApp();
    const b = makeApp();
    const runsA = await syntheticStudy(a.app, a.content);
    const runsB = await syntheticStudy(b.app, b.content);
    for (const name of ['participants', 'questions', 'surveys', 'gamification', 'allocation']) {
      const csvA = normalise(await exportCsv(a.app, name), runsA);
      const csvB = normalise(await exportCsv(b.app, name), runsB);
      // Durations and per-answer times are timing, not content.
      const dropTiming = (csv) => {
        const rows = parseCsv(csv);
        return rows.map((r) => ({ ...r, duration_s: undefined, time_taken_ms: undefined }));
      };
      expect(dropTiming(csvB), name).toEqual(dropTiming(csvA));
    }
  });

  it('pilot rows are excluded from every research export', async () => {
    const { app, db, content } = makeApp();
    await request(app).post('/admin/api/mode').set('X-Admin-Token', ADMIN_TOKEN).send({ mode: 'pilot' }).expect(200);
    const pilotRun = await fullRun(app, content);
    await request(app).post('/admin/api/mode').set('X-Admin-Token', ADMIN_TOKEN).send({ mode: 'live' }).expect(200);
    const liveRun = await fullRun(app, content);
    expect(db.prepare('SELECT COUNT(*) AS n FROM participants WHERE is_pilot = 1').get().n).toBe(1);
    for (const name of ['participants', 'questions', 'surveys', 'events', 'gamification', 'allocation']) {
      const csv = await exportCsv(app, name);
      expect(csv, name).not.toContain(pilotRun.code);
    }
    expect(await exportCsv(app, 'participants')).toContain(liveRun.code);

    // The pilot can still be reviewed on its own.
    const pilotCsv = await request(app).get('/admin/api/export/participants.csv?cohort=pilot').set('X-Admin-Token', ADMIN_TOKEN);
    expect(pilotCsv.headers['content-disposition']).toMatch(/PILOT_participants\.csv/);
    const pilotRows = parseCsv(pilotCsv.text);
    expect(pilotRows.map((r) => r.participant_code)).toEqual([pilotRun.code]);
    expect(pilotRows[0].score_raw).toBe('9');
  });

  it('contains no name, email, IP or device field anywhere', async () => {
    const { app, db, content } = makeApp();
    await syntheticStudy(app, content);
    const forbidden = /name|email|mail|ip_?addr|^ip$|user_?agent|device|phone|student_?id/i;
    const columns = db
      .prepare("SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'")
      .all();
    // leaderboard_name is the random pseudonym ("Swift Otter"), not a person's name.
    expect(columns.filter((c) => forbidden.test(c.col) && c.col !== 'leaderboard_name')).toEqual([]);
    for (const name of ['participants', 'questions', 'surveys', 'events', 'gamification', 'allocation', 'meta']) {
      const header = (await exportCsv(app, name)).split('\n')[0].split(',');
      expect(header.filter((h) => forbidden.test(h)), name).toEqual([]);
      expect(await exportCsv(app, name)).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::ffff:|@/);
    }
  });

  it('switching on postdiction and extra measures adds their columns', async () => {
    const dir = contentCopy({
      'survey.json': (s) => {
        for (const item of s.items) {
          if (item.id === 'postdiction') item.enabled = true;
          if (item.id === 'enjoyment') {
            item.enabled = true;
            item.text = 'I enjoyed this.';
          }
        }
      },
    });
    const { app, content } = makeApp({ contentDir: dir });
    const run = await fullRun(app, content, { postValue: 6 });
    const row = parseCsv(await exportCsv(app, 'participants')).find((r) => r.participant_code === run.code);
    expect(row).toMatchObject({ postdiction: '6', calibration_gap: String(6 - 9), enjoyment_post: '6' });
  });

  it('verify_exports.py reproduces the status counts from the CSVs', async () => {
    let python = null;
    for (const candidate of ['python3', 'python']) {
      try {
        execFileSync(candidate, ['--version'], { stdio: 'ignore' });
        python = candidate;
        break;
      } catch {
        // try the next one
      }
    }
    if (!python) return; // Python is optional; the R/Python check is documented in docs/.
    const { app, content } = makeApp();
    await syntheticStudy(app, content);
    const abandoned = participant(app);
    await toQuestions(abandoned, content);
    await abandoned.post('/api/withdraw', { confirm: true });
    const dir = tmpDir('cq-export-');
    for (const [name, file] of [['participants', 'participants.csv'], ['questions', 'questions_long.csv'], ['surveys', 'surveys_long.csv']]) {
      fs.writeFileSync(path.join(dir, file), await exportCsv(app, name));
    }
    const status = (await request(app).get('/admin/api/status').set('X-Admin-Token', ADMIN_TOKEN)).body;
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
    const out = execFileSync(python, ['-I', path.join(ROOT, 'scripts', 'analysis', 'verify_exports.py'), dir, path.join(dir, 'status.json')], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/MATCH/);
  });
});
