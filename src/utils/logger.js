import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

// Check if running in serverless environment (Vercel, AWS Lambda, etc.)
const isServerless = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION;

// Create transports array
const transports = [
  new winston.transports.Console({
    format: combine(
      colorize(),
      logFormat
    ),
  })
];

// Only add file transports in non-serverless environments
if (!isServerless) {
  transports.push(
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5,
    })
  );
}

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports,
});
