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
import resumeRoutes from './routes/resume.routes.js';
import cmsRoutes from './routes/cms.routes.js';
import adminCmsRoutes from './routes/admin-cms.routes.js';
import feedRoutes from './routes/feed.routes.js';
import subscriptionRoutes from './routes/subscription.routes.js';
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

// Raw body parser for Razorpay webhook (must be before express.json)
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));

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
app.use('/api/admin/cms', adminCmsRoutes);
app.use('/api/cms', cmsRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

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

// Auto-migrate: ensure cms_posts table and documents column exist
const runCmsMigrations = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cms_posts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug            TEXT NOT NULL UNIQUE,
        title           TEXT NOT NULL,
        organization    TEXT NOT NULL,
        category        TEXT NOT NULL CHECK (category IN (
                          'latest-jobs','results','admit-card',
                          'answer-key','syllabus','admissions'
                        )),
        status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
        is_featured     BOOLEAN NOT NULL DEFAULT false,
        brief_info          TEXT,
        important_dates     JSONB DEFAULT '{}',
        application_fee     JSONB DEFAULT '{}',
        age_limit           JSONB DEFAULT '{}',
        vacancy_details     JSONB DEFAULT '[]',
        eligibility         TEXT,
        how_to_apply        TEXT,
        important_links     JSONB DEFAULT '[]',
        advertisement_no    TEXT,
        total_vacancies     INTEGER,
        documents           JSONB DEFAULT '[]',
        meta_title          TEXT,
        meta_description    TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ,
        created_by   UUID REFERENCES users(id)
      )
    `);
    // Add documents column to existing installs that ran the original migration
    await pool.query(`ALTER TABLE cms_posts ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '[]'`);
    // Indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cms_posts_slug ON cms_posts(slug)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cms_posts_category ON cms_posts(category)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cms_posts_status ON cms_posts(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cms_posts_published_at ON cms_posts(published_at DESC) WHERE status = 'published'`);
    // updated_at trigger
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_cms_posts_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS trg_cms_posts_updated_at ON cms_posts;
      CREATE TRIGGER trg_cms_posts_updated_at
        BEFORE UPDATE ON cms_posts
        FOR EACH ROW EXECUTE FUNCTION update_cms_posts_updated_at()
    `);
    logger.info('✅ CMS migrations applied');
  } catch (err) {
    logger.error('CMS migration error:', err.message || err);
  }
};

// Auto-migrate: ensure social_posts + social_post_likes tables exist
const runFeedMigrations = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_posts (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content       VARCHAR(500) NOT NULL,
        image_url     TEXT,
        likes_count   INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_post_likes (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id    UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(post_id, user_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_social_posts_created ON social_posts(created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_social_post_likes_post ON social_post_likes(post_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_social_post_likes_user ON social_post_likes(user_id)');
    // updated_at trigger
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_social_posts_updated_at()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
    `);
    await pool.query(`
      DROP TRIGGER IF EXISTS trg_social_posts_updated_at ON social_posts;
      CREATE TRIGGER trg_social_posts_updated_at
        BEFORE UPDATE ON social_posts
        FOR EACH ROW EXECUTE FUNCTION update_social_posts_updated_at()
    `);
    logger.info('✅ Feed migrations applied');
  } catch (err) {
    logger.error('Feed migration error:', err.message || err);
  }
};

// Auto-migrate: ensure subscriptions tables exist
const runSubscriptionMigrations = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        razorpay_subscription_id  TEXT NOT NULL UNIQUE,
        razorpay_plan_id          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'created',
        current_start   TIMESTAMPTZ,
        current_end     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscription_payments (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id   UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        razorpay_payment_id   TEXT NOT NULL UNIQUE,
        amount            INTEGER NOT NULL,
        currency          TEXT NOT NULL DEFAULT 'INR',
        status            TEXT NOT NULL,
        paid_at           TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_subscriptions_rzp_id ON subscriptions(razorpay_subscription_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_sub_payments_subscription ON subscription_payments(subscription_id)');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_customer_id TEXT');
    logger.info('✅ Subscription migrations applied');
  } catch (err) {
    logger.error('Subscription migration error:', err.message || err);
  }
};

// Auto-migrate: ensure linkedin_id column exists
const runLinkedinMigration = async () => {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS linkedin_id VARCHAR(255) UNIQUE');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_linkedin_id ON users(linkedin_id)');
    await pool.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_method_check');
    await pool.query("ALTER TABLE users ADD CONSTRAINT users_auth_method_check CHECK (password IS NOT NULL OR google_id IS NOT NULL OR linkedin_id IS NOT NULL)");
    logger.info('LinkedIn migration applied');
  } catch (err) {
    logger.error('LinkedIn migration error:', err.message || err);
  }
};

// Start server only if not in Vercel environment
if (process.env.VERCEL !== '1' && !process.env.AWS_LAMBDA_FUNCTION_VERSION) {
  app.listen(PORT, () => {
    logger.info(`🚀 VeriBoard API server running on port ${PORT}`);
    logger.info(`📝 Environment: ${process.env.NODE_ENV}`);
    logger.info(`🔐 ENABLE_OTP_ON_LOGIN=${process.env.ENABLE_OTP_ON_LOGIN || 'unset'}`);
  });

  runCmsMigrations();
  runFeedMigrations();
  runSubscriptionMigrations();
  runLinkedinMigration();

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
