import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { setMeta } from '../db/connection.js';
import { requireAdmin } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { validateBody } from '../middleware/validate.js';
import { EXPORTS, buildExport } from '../services/exporter.js';
import { backupDatabase, purgePilotData, studyStatus, withdrawParticipantData } from '../services/maintenance.js';
import { CODE_PATTERN, nowIso } from '../util.js';

export const PURGE_PHRASE = 'DELETE PILOT DATA';

export function adminRoutes({ db, content, config, startedAt }) {
  const router = Router();
  router.use('/admin/api', requireAdmin(config));

  router.get('/admin/api/status', (req, res) => {
    res.json(studyStatus(db, content, startedAt));
  });

  // participants.csv, questions.csv, surveys.csv, events.csv, gamification.csv, allocation.csv, meta.csv
  // Research data by default; ?cohort=pilot gives the pilot rows instead (for reviewing the pilot).
  router.get('/admin/api/export/:name.csv', (req, res) => {
    const pilot = req.query.cohort === 'pilot';
    const csv = buildExport(db, content, req.params.name, { pilot });
    if (csv === null) throw new AppError('NOT_FOUND', `Unknown export. Use one of: ${Object.keys(EXPORTS).join(', ')}.`);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${pilot ? 'PILOT_' : ''}${EXPORTS[req.params.name]}"`);
    res.send(csv);
  });

  router.post('/admin/api/backup', async (req, res) => {
    const file = await backupDatabase(db, config.backupDir, 'admin');
    res.json({ ok: true, file: path.basename(file), at: nowIso() });
  });

  router.post('/admin/api/mode', validateBody(z.object({ mode: z.enum(['pilot', 'live']) })), (req, res) => {
    setMeta(db, 'study_mode', req.valid.mode);
    db.prepare('INSERT INTO events (participant_id, event_type, payload, created_at) VALUES (NULL, ?, ?, ?)').run(
      'study_mode_changed',
      JSON.stringify({ mode: req.valid.mode }),
      nowIso(),
    );
    res.json({ ok: true, study_mode: req.valid.mode });
  });

  router.post(
    '/admin/api/purge-pilot',
    validateBody(z.object({ confirm: z.literal(PURGE_PHRASE) }), `Type "${PURGE_PHRASE}" to confirm.`),
    (req, res) => {
      res.json({ ok: true, removed: purgePilotData(db) });
    },
  );

  router.post(
    '/admin/api/withdraw',
    validateBody(z.object({ participant_code: z.string().regex(CODE_PATTERN), confirm: z.literal(true) }), 'Enter a valid 6-character code.'),
    (req, res) => {
      if (!withdrawParticipantData(db, req.valid.participant_code)) throw new AppError('NOT_FOUND', 'No participant with that code.');
      res.json({ ok: true });
    },
  );

  return router;
}
