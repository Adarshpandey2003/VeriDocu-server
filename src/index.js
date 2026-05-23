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
import adminJobsRoutes from './routes/admin-jobs.routes.js';
import feedRoutes from './routes/feed.routes.js';
import subscriptionRoutes from './routes/subscription.routes.js';
import collaboratorRoutes from './routes/collaborators.routes.js';
import bulkOnboardRoutes from './routes/bulk-onboard.routes.js';
import interviewRoutes from './routes/interview.routes.js';
import hrFeatureRoutes from './routes/hr-features.routes.js';
import crawlerRoutes from './routes/crawler.routes.js';
import pool from './config/database.js';

// Import middleware
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Trust the first proxy hop (Nginx). Required so req.ip reflects the real
// client IP from X-Forwarded-For and express-rate-limit can key correctly.
// Override with TRUST_PROXY env (number of proxies, or 'true'/'false').
const trustProxy = process.env.TRUST_PROXY ?? '1';
app.set('trust proxy', trustProxy === 'true' ? true : trustProxy === 'false' ? false : Number(trustProxy));

// Simple console logger for serverless
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
};

// Security middleware
app.use(helmet());

// CORS: parse comma-separated allowlist from CORS_ORIGIN. Fail closed in
// production if unset; allow wildcard only in development for convenience.
// A literal "*" entry means "allow any origin" — useful for local dev.
const corsAllowlist = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsAllowAny = corsAllowlist.includes('*');
const isProd = process.env.NODE_ENV === 'production';
if (isProd && corsAllowlist.length === 0) {
  console.error('[CORS] CORS_ORIGIN is not set in production — refusing to allow wildcard origins.');
}
if (isProd && corsAllowAny) {
  console.warn('[CORS] CORS_ORIGIN contains "*" in production — every origin will be accepted.');
}
app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin / curl / mobile (no Origin header)
    if (!origin) return callback(null, true);
    // Wildcard: explicit "*" in allowlist allows any origin
    if (corsAllowAny) return callback(null, true);
    // Dev convenience: wildcard if CORS_ORIGIN unset and not production
    if (corsAllowlist.length === 0) {
      return callback(null, !isProd);
    }
    return callback(null, corsAllowlist.includes(origin));
  },
  credentials: true,
}));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 min
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS', // don't count preflight
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many authentication attempts, please try again later.' },
});

app.use('/api/', generalLimiter);
app.use('/api/auth/otp', authLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/verify-email', authLimiter);
app.use('/api/auth/verify-login-otp', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/change-password', authLimiter);

// Raw body parser for Razorpay webhook (must be before express.json)
app.use('/api/subscriptions/webhook', express.raw({ type: 'application/json' }));

// Body parsing middleware
// JSON body limit kept tight to defend against payload-based DoS. File
// uploads use multer and have their own size guards.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
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
app.use('/api/admin/jobs', adminJobsRoutes);
app.use('/api/cms', cmsRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api', collaboratorRoutes);
app.use('/api/company', bulkOnboardRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api', hrFeatureRoutes);
app.use('/api/admin/crawler', crawlerRoutes);

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

// Auto-migrate: FTS search indexes + trigram
const runSearchMigration = async () => {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await pool.query('ALTER TABLE candidates ADD COLUMN IF NOT EXISTS search_vector tsvector');
    await pool.query('ALTER TABLE companies  ADD COLUMN IF NOT EXISTS search_vector tsvector');
    await pool.query('ALTER TABLE jobs       ADD COLUMN IF NOT EXISTS search_vector tsvector');

    await pool.query("UPDATE candidates SET search_vector = to_tsvector('english', coalesce(full_name,'') || ' ' || coalesce(title,'') || ' ' || coalesce(location,'') || ' ' || coalesce(bio,'')) WHERE search_vector IS NULL");
    await pool.query("UPDATE companies  SET search_vector = to_tsvector('english', coalesce(name,'') || ' ' || coalesce(industry,'') || ' ' || coalesce(location,'') || ' ' || coalesce(description,'')) WHERE search_vector IS NULL");
    await pool.query("UPDATE jobs       SET search_vector = to_tsvector('english', coalesce(title,'') || ' ' || coalesce(location,'') || ' ' || coalesce(description,'')) WHERE search_vector IS NULL");

    await pool.query('CREATE INDEX IF NOT EXISTS idx_candidates_search ON candidates USING GIN(search_vector)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_companies_search  ON companies  USING GIN(search_vector)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_jobs_search       ON jobs       USING GIN(search_vector)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_candidates_name_trgm ON candidates USING GIN(full_name gin_trgm_ops)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_companies_name_trgm  ON companies  USING GIN(name gin_trgm_ops)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_jobs_title_trgm      ON jobs       USING GIN(title gin_trgm_ops)');

    // Triggers
    await pool.query(`CREATE OR REPLACE FUNCTION candidates_search_trigger() RETURNS trigger AS $$ BEGIN NEW.search_vector := to_tsvector('english', coalesce(NEW.full_name,'') || ' ' || coalesce(NEW.title,'') || ' ' || coalesce(NEW.location,'') || ' ' || coalesce(NEW.bio,'')); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE OR REPLACE FUNCTION companies_search_trigger() RETURNS trigger AS $$ BEGIN NEW.search_vector := to_tsvector('english', coalesce(NEW.name,'') || ' ' || coalesce(NEW.industry,'') || ' ' || coalesce(NEW.location,'') || ' ' || coalesce(NEW.description,'')); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE OR REPLACE FUNCTION jobs_search_trigger() RETURNS trigger AS $$ BEGIN NEW.search_vector := to_tsvector('english', coalesce(NEW.title,'') || ' ' || coalesce(NEW.location,'') || ' ' || coalesce(NEW.description,'')); RETURN NEW; END $$ LANGUAGE plpgsql`);

    await pool.query('DROP TRIGGER IF EXISTS trg_candidates_search ON candidates');
    await pool.query('CREATE TRIGGER trg_candidates_search BEFORE INSERT OR UPDATE ON candidates FOR EACH ROW EXECUTE FUNCTION candidates_search_trigger()');
    await pool.query('DROP TRIGGER IF EXISTS trg_companies_search ON companies');
    await pool.query('CREATE TRIGGER trg_companies_search BEFORE INSERT OR UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION companies_search_trigger()');
    await pool.query('DROP TRIGGER IF EXISTS trg_jobs_search ON jobs');
    await pool.query('CREATE TRIGGER trg_jobs_search BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_search_trigger()');

    logger.info('FTS search migration applied');
  } catch (err) {
    logger.error('Search migration error:', err.message || err);
  }
};

// Auto-migrate: feed upgrade — comments, bookmarks, connections, hashtags
const runFeedUpgradeMigration = async () => {
  try {
    await pool.query('ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS comments_count INTEGER NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS shares_count INTEGER NOT NULL DEFAULT 0');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_post_comments (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id    UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content    VARCHAR(300) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_comments_post ON social_post_comments(post_id, created_at DESC)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS social_bookmarks (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        post_id    UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(post_id, user_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON social_bookmarks(user_id, created_at DESC)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_connections (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        follower_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(follower_id, following_id),
        CHECK(follower_id != following_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_connections_follower ON user_connections(follower_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_connections_following ON user_connections(following_id)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS hashtags (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tag        VARCHAR(100) NOT NULL UNIQUE,
        post_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hashtags_tag ON hashtags(tag)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_hashtags_count ON hashtags(post_count DESC)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS post_hashtags (
        post_id    UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
        hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
        PRIMARY KEY(post_id, hashtag_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag ON post_hashtags(hashtag_id)');

    // Backfill comments_count from existing comments
    await pool.query(`
      UPDATE social_posts sp SET comments_count = sub.cnt
      FROM (SELECT post_id, COUNT(*) AS cnt FROM social_post_comments GROUP BY post_id) sub
      WHERE sp.id = sub.post_id AND sp.comments_count != sub.cnt
    `);

    // Trigger: auto-maintain comments_count on social_posts
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_comments_count() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          UPDATE social_posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
          RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE social_posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = OLD.post_id;
          RETURN OLD;
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql
    `);
    await pool.query('DROP TRIGGER IF EXISTS trg_comments_count ON social_post_comments');
    await pool.query(`
      CREATE TRIGGER trg_comments_count
      AFTER INSERT OR DELETE ON social_post_comments
      FOR EACH ROW EXECUTE FUNCTION update_comments_count()
    `);

    // Trigger: auto-maintain hashtags.post_count via post_hashtags
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_hashtag_post_count() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          UPDATE hashtags SET post_count = post_count + 1 WHERE id = NEW.hashtag_id;
          RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE hashtags SET post_count = GREATEST(post_count - 1, 0) WHERE id = OLD.hashtag_id;
          RETURN OLD;
        END IF;
        RETURN NULL;
      END $$ LANGUAGE plpgsql
    `);
    await pool.query('DROP TRIGGER IF EXISTS trg_post_hashtags_count ON post_hashtags');
    await pool.query(`
      CREATE TRIGGER trg_post_hashtags_count
      AFTER INSERT OR DELETE ON post_hashtags
      FOR EACH ROW EXECUTE FUNCTION update_hashtag_post_count()
    `);

    logger.info('Feed upgrade migration applied');
  } catch (err) {
    logger.error('Feed upgrade migration error:', err.message || err);
  }
};

// Auto-migrate: multi-tier plan system
const runPlanMigration = async () => {
  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(20) NOT NULL DEFAULT 'free'");
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_billing VARCHAR(10) DEFAULT NULL');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS generation_reset_at TIMESTAMPTZ DEFAULT NOW()');
    await pool.query("UPDATE users SET plan_tier = 'pro' WHERE is_pro = true AND plan_tier = 'free'");
    await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(20) DEFAULT 'pro'");
    await pool.query("ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) DEFAULT 'monthly'");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS razorpay_plans (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tier       VARCHAR(20) NOT NULL,
        billing    VARCHAR(10) NOT NULL,
        rzp_plan_id TEXT NOT NULL UNIQUE,
        amount     INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(tier, billing)
      )
    `);
    logger.info('Plan tier migration applied');
  } catch (err) {
    logger.error('Plan tier migration error:', err.message || err);
  }
};

const runHrFeaturesMigration = async () => {
  try {
    // AI screening columns on job_applications
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ai_score INT');
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ai_summary TEXT');
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ai_strengths TEXT[]');
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ai_concerns TEXT[]');
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ai_screened_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ai_interview_questions JSONB');
    await pool.query('ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS internal_notes TEXT');

    // AI screening config on jobs
    await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_screening_enabled BOOLEAN DEFAULT FALSE');
    await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_min_score INT');

    // Job collaborators table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS job_collaborators (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('co_owner','recruiter','reviewer')),
        invited_by_user_id UUID NOT NULL REFERENCES users(id),
        magic_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(job_id, email)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_job_collab_user ON job_collaborators(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_job_collab_token ON job_collaborators(magic_token)');

    // Interview invites table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS interview_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        application_id UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
        proposed_slots JSONB NOT NULL,
        selected_slot_index INT,
        mode TEXT NOT NULL CHECK (mode IN ('video','phone','in_person')),
        meeting_link TEXT,
        location TEXT,
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','completed','no_show')),
        magic_token UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
        created_by_user_id UUID NOT NULL REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_interview_app ON interview_invites(application_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_interview_token ON interview_invites(magic_token)');

    logger.info('HR features migration applied');
  } catch (err) {
    logger.error('HR features migration error:', err.message || err);
  }
};

const runCrawlerMigration = async () => {
  try {
    await pool.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_external BOOLEAN DEFAULT FALSE');
    await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_key TEXT');
    await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS external_url TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source_key)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS crawler_sources (
        id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key             TEXT UNIQUE NOT NULL,
        display_name    TEXT NOT NULL,
        enabled         BOOLEAN NOT NULL DEFAULT FALSE,
        schedule_cron   TEXT NOT NULL DEFAULT '0 2 * * *',
        search_queries  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        location_filter TEXT,
        max_per_run     INT NOT NULL DEFAULT 50,
        last_run_at     TIMESTAMPTZ,
        last_status     TEXT,
        last_error      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scraped_jobs (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        source_id        UUID NOT NULL REFERENCES crawler_sources(id) ON DELETE CASCADE,
        external_id      TEXT NOT NULL,
        external_url     TEXT,
        ingested_job_id  UUID REFERENCES jobs(id) ON DELETE SET NULL,
        raw_data         JSONB,
        scraped_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(source_id, external_id)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_scraped_source_time ON scraped_jobs(source_id, scraped_at DESC)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS crawler_runs (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        source_id    UUID NOT NULL REFERENCES crawler_sources(id) ON DELETE CASCADE,
        started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at  TIMESTAMPTZ,
        status       TEXT NOT NULL DEFAULT 'running',
        found_count  INT DEFAULT 0,
        new_count    INT DEFAULT 0,
        error_text   TEXT,
        triggered_by TEXT NOT NULL DEFAULT 'cron'
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_crawler_runs_source ON crawler_runs(source_id, started_at DESC)');

    await pool.query(`
      INSERT INTO crawler_sources (key, display_name) VALUES
        ('naukri',        'Naukri'),
        ('foundit',       'Foundit (Monster India)'),
        ('timesjobs',     'TimesJobs'),
        ('shine',         'Shine'),
        ('freshersworld', 'Freshersworld')
      ON CONFLICT (key) DO NOTHING
    `);

    logger.info('Crawler migration applied');
  } catch (err) {
    logger.error('Crawler migration error:', err.message || err);
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
  runSearchMigration();
  runFeedUpgradeMigration();
  runPlanMigration();
  runHrFeaturesMigration();
  runCrawlerMigration().then(() => {
    // Lazy-import so the scheduler is only loaded after migrations exist.
    import('./crawlers/scheduler.js')
      .then(({ start }) => start())
      .catch((err) => logger.error('Crawler scheduler failed to start:', err.message || err));
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
