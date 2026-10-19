import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { loadParticipant } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createStudy } from './services/stateMachine.js';
import { sessionRoutes } from './routes/session.js';
import { surveyRoutes } from './routes/survey.js';
import { questionRoutes } from './routes/questions.js';
import { resultRoutes } from './routes/results.js';
import { adminRoutes } from './routes/admin.js';

const PUBLIC_DIR = path.join(ROOT, 'public');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
}

// Builds the Express app. No request logging: IP addresses and user agents are never recorded.
export function createApp({ db, content, config, startedAt = Date.now() }) {
  const study = createStudy({ db, content });
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '20kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(loadParticipant(db));

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
  });

  app.use(sessionRoutes({ study, config }));
  app.use(surveyRoutes({ study }));
  app.use(questionRoutes({ study }));
  app.use(resultRoutes({ study }));
  app.use(adminRoutes({ db, content, config, startedAt }));

  app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

  app.use(notFound);
  app.use(errorHandler(study.logEvent));
  return { app, study };
}
