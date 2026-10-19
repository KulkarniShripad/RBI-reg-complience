import { Router } from 'express';
import { requireActive, requireParticipant, setSessionCookie } from '../middleware/auth.js';
import { schemas, validateBody } from '../middleware/validate.js';

export function sessionRoutes({ study, config }) {
  const router = Router();

  // Public: consent text and UI strings, needed before a session exists.
  router.get('/api/texts', (req, res) => {
    res.json(study.publicTexts());
  });

  // S0: consent given. A refusal never reaches the server, so it stores nothing.
  router.post(
    '/api/session',
    validateBody(schemas.session, 'Please tick the box to agree before continuing.'),
    (req, res) => {
      // Same device starting again: keep the existing session (resume or debrief).
      if (req.participant) return res.status(200).json(study.publicState(req.participant));
      const { token, participant } = study.createParticipant();
      setSessionCookie(res, token, config);
      res.status(201).json(study.publicState(participant));
    },
  );

  // No session yet is the normal first visit (S0), not an error.
  router.get('/api/state', (req, res) => {
    res.json(req.participant ? study.publicState(req.participant) : { step: 'CONSENT' });
  });

  router.post('/api/withdraw', requireParticipant, validateBody(schemas.withdraw), (req, res) => {
    res.json(study.withdraw(req.participant));
  });

  router.post('/api/complete', requireParticipant, requireActive, (req, res) => {
    res.json(study.complete(req.participant));
  });

  return router;
}
