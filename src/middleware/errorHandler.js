// Simple console logger for serverless environments
const logger = {
  error: (...args) => console.error('[ERROR]', ...args),
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
};

export const errorHandler = (err, req, res, next) => {
  logger.error(err.stack);

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation Error',
      errors: Object.values(err.errors).map(e => e.message),
    });
  }

  // JWT authentication error
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }

  // JWT expired error
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
    });
  }

  // PostgreSQL errors — never leak internal detail/constraint/column names
  // to the client; those enable schema enumeration.
  if (err.code === '23505') {
    const body = { success: false, message: 'Duplicate entry' };
    if (process.env.NODE_ENV === 'development') body.detail = err.detail;
    return res.status(409).json(body);
  }
  if (err.code === '23503') {
    return res.status(409).json({ success: false, message: 'Related record not found' });
  }
  if (err.code === '23502') {
    return res.status(400).json({ success: false, message: 'Required field missing' });
  }
  if (err.code === '23514') {
    return res.status(400).json({ success: false, message: 'Invalid value' });
  }

  // Generic Postgres errors: hide internals in production.
  if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && process.env.NODE_ENV === 'production') {
    return res.status(500).json({ success: false, message: 'Database error' });
  }

  // Default error
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational === true;
  // In production, only expose operational error messages. Internal/unknown
  // errors get a generic message so we don't leak implementation details.
  const message = (process.env.NODE_ENV === 'production' && !isOperational)
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  res.status(statusCode).json({
    success: false,
    message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}
