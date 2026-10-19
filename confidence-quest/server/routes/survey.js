import { Router } from 'express';
import { requireActive, requireParticipant } from '../middleware/auth.js';
import { parsePhase, schemas, validateBody } from '../middleware/validate.js';

export function surveyRoutes({ study }) {
  const router = Router();

  router.get('/api/survey/:phase', requireParticipant, requireActive, (req, res) => {
    res.json(study.getSurvey(req.participant, parsePhase(req.params.phase)));
  });

  // Submits every answer at once. Submitting the pre-survey also assigns the arm.
  router.post(
    '/api/survey/:phase',
    requireParticipant,
    requireActive,
    validateBody(schemas.surveySubmit, 'Please answer every statement before continuing.'),
    (req, res) => {
      const phase = parsePhase(req.params.phase);
      const result = study.submitSurvey(req.participant, phase, req.valid.answers);
      res.json({ ok: true, already_submitted: result.already_submitted, state: study.publicState(req.participant) });
    },
  );

  return router;
}
