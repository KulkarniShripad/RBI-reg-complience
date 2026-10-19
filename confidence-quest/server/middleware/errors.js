export const STATUS_BY_CODE = {
  VALIDATION: 400,
  NO_SESSION: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_YOUR_TURN: 409,
  SERVER: 500,
};

export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = STATUS_BY_CODE[code] ?? 500;
  }
}

export function notFound(req, res, next) {
  next(new AppError('NOT_FOUND', 'Not found.'));
}

// Every error is written to the events table with the participant id and a code.
// Nothing the participant typed is ever copied into the log.
export function errorHandler(logEvent) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let error = err;
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      error = new AppError('VALIDATION', 'The request could not be read.');
    } else if (!(err instanceof AppError)) {
      console.error(`[error] ${req.method} ${req.route?.path ?? req.path}:`, err);
      error = new AppError('SERVER', 'Something went wrong on the server. Please tell the proctor.');
    }
    if (error.code !== 'NOT_FOUND') {
      try {
        logEvent(req.participant?.id ?? null, 'error', {
          code: error.code,
          method: req.method,
          route: req.route?.path ?? 'unmatched',
        });
      } catch (logErr) {
        console.error('[error] could not log error event:', logErr.message);
      }
    }
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  };
}
