import { z } from 'zod';
import { AppError } from './errors.js';

// Parses req.body with a zod schema and puts the result on req.valid.
// Failures become a VALIDATION error with a plain-language message.
export function validateBody(schema, message = 'Some of the information sent was missing or invalid.') {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError('VALIDATION', message);
    req.valid = parsed.data;
    next();
  };
}

export const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const schemas = {
  session: z.object({ consent: z.literal(true) }),
  surveySubmit: z.object({
    answers: z.record(z.string().max(64), z.number()),
    idempotencyKey: idempotencyKey.optional(),
  }),
  answer: z.object({
    questionId: z.string().max(16),
    selectedOption: z.string().max(8),
    idempotencyKey,
  }),
  next: z.object({ n: z.number().int().min(1).max(1000) }),
  empty: z.object({}).passthrough(),
  withdraw: z.object({ confirm: z.literal(true) }),
};

export function parsePhase(value) {
  if (value !== 'pre' && value !== 'post') throw new AppError('VALIDATION', 'Unknown survey.');
  return value;
}

export function parsePosition(value) {
  if (!/^\d{1,4}$/.test(value)) throw new AppError('VALIDATION', 'Unknown question number.');
  return Number(value);
}
