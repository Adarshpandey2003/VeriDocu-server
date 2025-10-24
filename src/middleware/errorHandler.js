import { logger } from '../utils/logger.js';

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

  // PostgreSQL errors
  if (err.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'Duplicate entry',
      detail: err.detail,
    });
  }

  // Default error
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

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
