import { Router } from 'express';
import { requireActive, requireParticipant } from '../middleware/auth.js';

export function resultRoutes({ study }) {
  const router = Router();

  // S5: the final screen for the participant's arm.
  router.get('/api/results', requireParticipant, requireActive, (req, res) => {
    res.json(study.getResults(req.participant));
  });

  router.post('/api/results/ack', requireParticipant, requireActive, (req, res) => {
    study.ackResults(req.participant);
    res.json({ ok: true, state: study.publicState(req.participant) });
  });

  return router;
}
