import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import passport from './config/passport.js';

// Load environment variables
dotenv.config();
// If a .env.local file exists, load it too (local overrides)
try {
  const localEnv = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(localEnv)) {
    dotenv.config({ path: localEnv });
    console.log('Loaded .env.local');
  }
} catch (err) {
  console.warn('Could not load .env.local', err.message || err);
}

// Import routes
import authRoutes from './routes/auth.routes.js';
import companyRoutes from './routes/company.routes.js';
import candidateRoutes from './routes/candidate.routes.js';
import jobRoutes from './routes/job.routes.js';
import verificationRoutes from './routes/verification.routes.js';
import consentRoutes from './routes/consent.routes.js';
import searchRoutes from './routes/search.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import publicRoutes from './routes/public.routes.js';
import adminRoutes from './routes/admin.routes.js';
import candidateVerificationRoutes from './routes/candidate-verification.routes.js';
import companyVerificationRoutes from './routes/company-verification.routes.js';
import pool from './config/database.js';

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Simple console logger for serverless
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
};

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 min
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 20, // stricter for auth endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts, please try again later.' },
});

app.use('/api/', generalLimiter);
app.use('/api/auth/otp', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/verify-email', authLimiter);
app.use('/api/auth/verify-login-otp', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Initialize Passport
app.use(passport.initialize());

// Compression
app.use(compression());

// Serve static files for uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Request logging (only in development)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log('\n🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥');
    console.log(`🌐 INCOMING REQUEST: ${req.method} ${req.path}`);
    console.log(`📧 Body:`, JSON.stringify(req.body));
    console.log('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥\n');
    next();
  });
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
  });
});

// Public Routes (before API routes)
app.use('/', publicRoutes);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/companies', companyVerificationRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/candidates', candidateVerificationRoutes);
app.use('/api/candidates', candidateRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/verifications', verificationRoutes);
app.use('/api/consent', consentRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/admin', adminRoutes);

// Development-only debug routes removed

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found' 
  });
});

// Error handling middleware
app.use(errorHandler);

// Start server only if not in Vercel environment
if (process.env.VERCEL !== '1' && !process.env.AWS_LAMBDA_FUNCTION_VERSION) {
  app.listen(PORT, () => {
    logger.info(`🚀 VeriBoard API server running on port ${PORT}`);
    logger.info(`📝 Environment: ${process.env.NODE_ENV}`);
    logger.info(`🔐 ENABLE_OTP_ON_LOGIN=${process.env.ENABLE_OTP_ON_LOGIN || 'unset'}`);
  });

  // Cleanup: delete notifications older than 7 days. Runs once at startup and then daily.
  const cleanupOldNotifications = async () => {
    try {
      const res = await pool.query("DELETE FROM notifications WHERE created_at < NOW() - INTERVAL '7 days'");
      logger.info(`🧹 Cleaned up ${res.rowCount} notifications older than 7 days`);
    } catch (err) {
      logger.error('Error cleaning up old notifications:', err);
    }
  };

  // Run once immediately, then schedule daily cleanup
  cleanupOldNotifications();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(cleanupOldNotifications, ONE_DAY_MS);
}

export default app;
