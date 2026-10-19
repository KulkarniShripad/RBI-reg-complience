import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { sha256 } from '../util.js';

export const SESSION_COOKIE = 'cq_session';
const SESSION_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

export function setSessionCookie(res, token, config) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

// Attaches req.participant when the cookie matches a stored token hash. Never fails on its own.
export function loadParticipant(db) {
  const byHash = db.prepare('SELECT * FROM participants WHERE token_hash = ?');
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) req.participant = byHash.get(sha256(token)) ?? undefined;
    next();
  };
}

export function requireParticipant(req, res, next) {
  if (!req.participant) {
    throw new AppError('NO_SESSION', 'No active session. Please start from the beginning or tell the proctor.');
  }
  next();
}

// Participants who stopped (or whose data was withdrawn) can still read their state but not act.
export function requireActive(req, res, next) {
  if (['abandoned', 'withdrawn'].includes(req.participant.status)) {
    throw new AppError('FORBIDDEN', 'You have stopped taking part, so this is no longer available.');
  }
  next();
}

export function requireAdmin(config) {
  const expected = config.adminToken ? crypto.createHash('sha256').update(config.adminToken).digest() : null;
  return (req, res, next) => {
    const given = req.get('X-Admin-Token');
    const ok =
      expected && given && crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), expected);
    if (!ok) throw new AppError('FORBIDDEN', 'Forbidden.');
    next();
  };
}
