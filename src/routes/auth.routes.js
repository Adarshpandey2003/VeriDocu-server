import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';
import { protect } from '../middleware/auth.js';
import { sendOtpEmail } from '../utils/mailer.js';

console.log('🔥🔥🔥 AUTH ROUTES MODULE LOADED 🔥🔥🔥');

// Use global fetch (Node 18+) to call Google reCAPTCHA verify endpoint. If your Node runtime
// does not include global fetch, install node-fetch and import it here.

async function verifyRecaptchaToken(token, action = '') {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) {
    // If secret is not configured, skip verification (dev mode)
    return { ok: true, skipped: true };
  }

  if (!token) {
    // No token provided by client
    console.warn('reCAPTCHA verification skipped: no token provided by client');
    return { ok: false, reason: 'no_token' };
  }

  try {
    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);

    const resp = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await resp.json();
    // Log the response (without token) to help debug verification failures in dev
    if (!data.success || (typeof data.score === 'number' && data.score < parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.5'))) {
      console.warn('reCAPTCHA siteverify response:', {
        success: data.success,
        score: data.score,
        action: data.action,
        hostname: data.hostname,
        'error-codes': data['error-codes'] || data['error_codes'] || null,
      });
    }
    // For reCAPTCHA v3 there is a score value (0.0 - 1.0). Use RECAPTCHA_MIN_SCORE env or default 0.5
    const minScore = parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.5');
    if (!data.success) return { ok: false, reason: 'recaptcha_failed', detail: data };
    if (typeof data.score === 'number' && data.score < minScore) return { ok: false, reason: 'low_score', score: data.score };

    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: 'verify_error', error: err };
  }
}

const router = express.Router();

// Helper to detect which password column exists in users table ('password_hash' or 'password')
async function detectPasswordColumn() {
  try {
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('password_hash','password')`
    );
    const cols = res.rows.map(r => r.column_name);
    if (cols.includes('password_hash')) return 'password_hash';
    if (cols.includes('password')) return 'password';
    return null;
  } catch (err) {
    console.warn('Could not detect password column:', err.message || err);
    return null;
  }
}

// Generic column detector with simple in-memory cache
const _columnCache = {};
async function detectColumn(table, candidates = []) {
  const key = `${table}:${candidates.join(',')}`;
  if (_columnCache[key]) return _columnCache[key];
  try {
    const placeholders = candidates.map((c, i) => `'${c}'`).join(',');
    const res = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name IN (${candidates.map((_, i) => '$' + (i + 2)).join(',')})`,
      [table, ...candidates]
    );
    const cols = res.rows.map(r => r.column_name);
    // Return first matching candidate in order
    for (const c of candidates) {
      if (cols.includes(c)) {
        _columnCache[key] = c;
        return c;
      }
    }
    _columnCache[key] = null;
    return null;
  } catch (err) {
    console.warn('detectColumn error:', err.message || err);
    _columnCache[key] = null;
    return null;
  }
}

// Helper to generate 6-digit numeric code
function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Normalize email for OTP storage/lookup: trim and lowercase only
function normalizeEmailForOtp(email) {
  if (!email) return email;
  return String(email).trim().toLowerCase();
}
// POST /api/auth/otp/request
// Body: { email, purpose: 'login'|'register', accountType? }
router.post('/otp/request', async (req, res, next) => {
  try {
    const { email, purpose = 'login', accountType } = req.body;
    if (!email) return next(new AppError('Email is required', 400));
    const normEmail = normalizeEmailForOtp(email);
    // (debug logging removed)

    // If register, ensure user doesn't already exist
    const userCheck = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (purpose === 'register' && userCheck.rows.length > 0) {
      return next(new AppError('User already exists', 409));
    }
    if (purpose === 'login' && userCheck.rows.length === 0) {
      return next(new AppError('User not found; please register first', 404));
    }

    const code = generateOtpCode();

    // Remove any existing OTPs for this email to avoid multiple valid codes
    try {
      await pool.query('DELETE FROM otp_codes WHERE email = $1', [normEmail]);
    } catch (delErr) {
      console.warn('[OTP] Failed to delete existing otps for', email, delErr.message || delErr);
    }

    // Store code with PostgreSQL NOW() + INTERVAL to avoid timezone issues
    await pool.query(
      `INSERT INTO otp_codes (email, code, purpose, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW())`,
      [normEmail, code, purpose]
    );

    console.log(`[OTP] ═══════════════════════════════════════════════════════`);
    console.log(`[OTP] 📧 Recipient: ${email}`);
    console.log(`[OTP] 🔐 Code: ${code}`);
    console.log(`[OTP] 📝 Purpose: ${purpose}`);
    console.log(`[OTP] ⏰ Expires: 10 minutes`);
    console.log(`[OTP] ═══════════════════════════════════════════════════════`);

    // Send via email (await to catch errors immediately)
    let emailSent = false;
    try {
      const emailResult = await sendOtpEmail(email, code, purpose);
      if (emailResult.ok) {
        console.log(`[OTP] ✅ Email sent successfully! Message ID: ${emailResult.messageId}`);
        emailSent = true;
      } else if (emailResult.skipped) {
        console.warn(`[OTP] ⚠️  Email sending skipped (SendGrid not configured)`);
      } else {
        console.error(`[OTP] ❌ Failed to send email to ${email}`);
        if (emailResult.error) {
          console.error(`[OTP]    Error: ${emailResult.error.message || emailResult.error}`);
        }
      }
    } catch (err) {
      console.error('[OTP] ❌ Error sending email:', err.message || err);
      if (err.response) {
        console.error('[OTP] SendGrid response:', JSON.stringify(err.response.body, null, 2));
      }
    }

    // Always return success so users can still use the app during testing/development
    // The OTP code is logged above and stored in database for verification
    res.json({ 
      success: true, 
      message: emailSent ? 'OTP sent to your email' : 'OTP generated (check server console in development)', 
      mailSent: emailSent 
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/otp/verify
// Body: { email, code, purpose: 'login'|'register', name?, accountType? }
router.post('/otp/verify', async (req, res, next) => {
  try {
    const { email, code, purpose = 'login', name, accountType = 'candidate' } = req.body;
    if (!email || !code) return next(new AppError('Email and code are required', 400));
    const normEmail = normalizeEmailForOtp(email);
    // (debug logging removed)

    const result = await pool.query(
      `SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND purpose = $3 AND expires_at > NOW()`,
      [normEmail, code, purpose]
    );

    // (debug logging removed)

    if (result.rows.length === 0) {
      return next(new AppError('Invalid or expired code', 400));
    }

  // Delete used codes for this email/purpose
  await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [normEmail, purpose]);

    // If register: create user and profile
    // Try to find the user by the original email or the normalized email used for OTP storage.
    const userResult = await pool.query(
      'SELECT id, email, account_type FROM users WHERE email = $1 OR email = $2',
      [email, normEmail]
    );
    // (debug logging removed)
    let user = userResult.rows[0];
    if (purpose === 'register') {
      if (user) return next(new AppError('User already exists', 409));
      // Insert user (users table has 'password' column and 'name' column)
      const insertQuery = `INSERT INTO users (email, password, account_type, name, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, email, account_type, name`;
      const insert = await pool.query(insertQuery, [email, null, accountType, name || null]);
      user = insert.rows[0];

      // Create candidate/company profile as appropriate
      if (accountType === 'candidate') {
        await pool.query(`INSERT INTO candidates (user_id, created_at) VALUES ($1, NOW())`, [user.id]);
      } else if (accountType === 'company') {
        const slug = (name || email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        await pool.query(`INSERT INTO companies (user_id, slug, created_at) VALUES ($1, $2, NOW())`, [user.id, slug]);
      }
    } else {
      // login flow: require existing user
      if (!user) return next(new AppError('User not found', 404));
    }

    // Generate token and return user info (omit password)
    const token = generateToken(user.id);

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        accountType: user.account_type || accountType,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// @route   POST /api/auth/register
// @desc    Register a new user and create account immediately
// @access  Public
router.post(
  '/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('accountType').isIn(['candidate', 'company']).withMessage('Invalid account type'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, email, password, accountType, companyName, recaptchaToken } = req.body;

      // Verify reCAPTCHA token if configured
      if (process.env.RECAPTCHA_SECRET) {
        const vr = await verifyRecaptchaToken(recaptchaToken, 'register');
        if (!vr.ok) {
          return next(new AppError('reCAPTCHA verification failed', 400));
        }
      }

      // Check if user already exists
      const userExists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (userExists.rows.length > 0) {
        return next(new AppError('User already exists with this email', 409));
      }

      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password, salt);

      // Check if OTP verification is required for registration
      const requireOtpOnRegister = process.env.REQUIRE_OTP_ON_REGISTER === 'true';

      if (!requireOtpOnRegister) {

        // Create user immediately without OTP verification
        const pwColCreate = await detectPasswordColumn() || 'password_hash';
        const createQuery = `INSERT INTO users (email, ${pwColCreate}, account_type, name, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, email, account_type, name`;
        const userResult = await pool.query(createQuery, [email, hashedPassword, accountType, name]);

        const user = userResult.rows[0];

        // If company account, create company profile
        if (accountType === 'company') {
          const slug = (companyName || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          await pool.query(
            `INSERT INTO companies (name, slug, user_id, created_at) VALUES ($1, $2, $3, NOW())`,
            [companyName || name, slug, user.id]
          );
        }

        // If candidate account, create candidate profile
        if (accountType === 'candidate') {
          await pool.query(
            `INSERT INTO candidates (user_id, full_name, created_at) VALUES ($1, $2, NOW())`,
            [user.id, name]
          );
        }

        // Generate token
        const token = generateToken(user.id);

        console.log(`[AUTH] ✅ User registered successfully without OTP: ${email}`);

        return res.status(201).json({
          success: true,
          message: 'Account created successfully!',
          user,
          token,
        });
      }

      // OTP verification required - proceed with OTP flow
      // Generate OTP for email verification
      const code = generateOtpCode();
      
      // Delete any existing OTP codes for this email
      try {
        await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [email, 'register']);
      } catch (delErr) {
        console.warn('[AUTH] Failed to delete existing OTP codes for', email, delErr.message || delErr);
      }

      // Store OTP with register purpose
      await pool.query(
        `INSERT INTO otp_codes (email, code, purpose, expires_at, created_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW())`,
        [email, code, 'register']
      );

      console.log(`[AUTH] ═══════════════════════════════════════════════════════`);
      console.log(`[AUTH] 📧 Registration OTP for: ${email}`);
      console.log(`[AUTH] 🔐 Verification Code: ${code}`);
      console.log(`[AUTH] ⏰ Expires in: 10 minutes`);
      console.log(`[AUTH] ═══════════════════════════════════════════════════════`);

      // Send verification email
      try {
        const emailResult = await sendOtpEmail(email, code, 'register');
        if (emailResult.ok) {
          console.log(`[AUTH] ✅ Registration email sent successfully! Message ID: ${emailResult.messageId}`);
        } else if (emailResult.skipped) {
          console.warn(`[AUTH] ⚠️  Email sending skipped (Resend not configured)`);
        } else {
          console.error(`[AUTH] ❌ Failed to send registration email to ${email}`);
          if (emailResult.error) {
            console.error(`[AUTH]    Error: ${emailResult.error.message || emailResult.error}`);
          }
        }
      } catch (err) {
        console.error('[AUTH] ❌ Error sending registration OTP:', err.message || err);
      }

      // Return success with OTP requirement and registration data
      console.log(`[AUTH] ✅ Registration OTP sent, requiresVerification=true`);
      
      res.status(201).json({
        success: true,
        message: 'Verification code sent to your email. Please verify to complete registration.',
        requiresVerification: true,
        email: email,
        registrationData: {
          name,
          hashedPassword,
          accountType,
          companyName,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   POST /api/auth/verify-email
// @desc    Verify email and create account after registration
// @access  Public
router.post('/verify-email', async (req, res, next) => {
  try {
    const { email, code, registrationData } = req.body;
    if (!email || !code) {
      return next(new AppError('Email and verification code are required', 400));
    }

    if (!registrationData || !registrationData.name || !registrationData.hashedPassword || !registrationData.accountType) {
      return next(new AppError('Registration data is required', 400));
    }

    // Check if code is valid - NO NORMALIZATION
    const result = await pool.query(
      `SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND purpose = $3 AND expires_at > NOW()`,
      [email, code, 'register']
    );

    if (result.rows.length === 0) {
      return next(new AppError('Invalid or expired verification code', 400));
    }

    // Delete used code
    await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [email, 'register']);

    // Check if user already exists (edge case: created between register and verify)
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return next(new AppError('User already exists with this email', 409));
    }

    // Now create the user account
    const { name, hashedPassword, accountType, companyName } = registrationData;
    
    // Create user - insert name into users table along with other data
    const pwColCreate = await detectPasswordColumn() || 'password_hash';
    const createQuery = `INSERT INTO users (email, ${pwColCreate}, account_type, name, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id, email, account_type, name`;
    const userResult = await pool.query(createQuery, [email, hashedPassword, accountType, name]);

    const user = userResult.rows[0];

    // If company account, create company profile
    if (accountType === 'company') {
      const slug = (companyName || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      await pool.query(
        `INSERT INTO companies (name, slug, user_id, created_at) VALUES ($1, $2, $3, NOW())`,
        [companyName || name, slug, user.id]
      );
    }

    // If candidate account, create candidate profile
    if (accountType === 'candidate') {
      await pool.query(
        `INSERT INTO candidates (user_id, full_name, created_at) VALUES ($1, $2, NOW())`,
        [user.id, name]
      );
    }

    // Generate token
    const token = generateToken(user.id);

    res.json({
      success: true,
      message: 'Email verified and account created successfully!',
      token,
      user: {
        id: user.id,
        email: user.email,
        accountType: user.account_type,
        name: user.name,
      },
    });
  } catch (error) {
    next(error);
  }
});


// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, password, recaptchaToken } = req.body;

      // Verify reCAPTCHA token if configured
      if (process.env.RECAPTCHA_SECRET) {
        const vr = await verifyRecaptchaToken(recaptchaToken, 'login');
        if (!vr.ok) {
          return next(new AppError('reCAPTCHA verification failed', 400));
        }
      }

      // Check which password column exists and query accordingly
      const pwCol = await detectPasswordColumn();
      if (!pwCol) return next(new AppError('Server misconfiguration: no password column found', 500));

      const result = await pool.query(
        `SELECT id, email, ${pwCol} as password_value, account_type, name FROM users WHERE email = $1`,
        [email]
      );

      if (result.rows.length === 0) {
        return next(new AppError('Invalid credentials', 401));
      }

      const user = result.rows[0];

      // Check password against stored password field (aliased to password_value)
      const isMatch = await bcrypt.compare(password, user.password_value);
      if (!isMatch) {
        return next(new AppError('Invalid credentials', 401));
      }

      // If OTP-on-login is enabled, send a one-time code and require verification
      const enableOtpOnLogin = process.env.ENABLE_OTP_ON_LOGIN === 'true';
      console.log('🔐 OTP on login enabled:', enableOtpOnLogin); // Debug log
      if (enableOtpOnLogin) {
    // OTP-on-login is enabled
        const code = generateOtpCode();
        
        console.log(`\n[AUTH] ═══════════════════════════════════════════════════════`);
        console.log(`[AUTH] 📧 Generating NEW login OTP for: ${email}`);
        console.log(`[AUTH] 🔐 Code: ${code}`);
        console.log(`[AUTH] ⏰ Expires in: 10 minutes`);
        console.log(`[AUTH] ═══════════════════════════════════════════════════════\n`);
        
        // Delete any existing OTPs for this email before creating a new one
        try {
          await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);
        } catch (delErr) {
          console.warn('[AUTH] Failed to delete existing otps for', email, delErr.message || delErr);
        }

        // Use PostgreSQL NOW() + INTERVAL to avoid timezone issues
        await pool.query(
          `INSERT INTO otp_codes (email, code, purpose, expires_at, created_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW())`,
          [email, code, '2fa']
        );
        
        // Send OTP email (fire-and-forget, don't wait)
        sendOtpEmail(email, code, 'login').catch(err => {
          console.error('[AUTH] Background email send error for login OTP:', err.message || err);
        });
        
        return res.json({ success: true, otpRequired: true, message: 'OTP sent to email' });
      }

      // Get name - for candidates from candidates table, for companies from users table
      let displayName = user.name || email.split('@')[0]; // Default to name from users table or email prefix
      
      if (user.account_type === 'candidate') {
        // For candidates, get full_name from candidates table
        const candNameCol = await detectColumn('candidates', ['full_name', 'name', 'first_name']);
        if (candNameCol === 'full_name' || candNameCol === 'name') {
          const candidateResult = await pool.query(`SELECT ${candNameCol} as candidate_name FROM candidates WHERE user_id = $1`, [user.id]);
          if (candidateResult.rows.length > 0 && candidateResult.rows[0].candidate_name) {
            displayName = candidateResult.rows[0].candidate_name;
          }
        } else if (candNameCol === 'first_name') {
          // try to assemble from first_name and last_name if available
          const candidateResult = await pool.query(`SELECT first_name, last_name FROM candidates WHERE user_id = $1`, [user.id]);
          if (candidateResult.rows.length > 0) {
            const r = candidateResult.rows[0];
            displayName = [r.first_name, r.last_name].filter(Boolean).join(' ') || displayName;
          }
        }
      }

      // Generate token
      const token = generateToken(user.id);

      res.json({
        success: true,
        token,
        user: {
          id: user.id,
          name: displayName,
          email: user.email,
          accountType: user.account_type,
          role: user.account_type,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   POST /api/auth/verify-login-otp
// @desc    Verify OTP code sent during login
// @access  Public
router.post(
  '/verify-login-otp',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('code').notEmpty().withMessage('Verification code is required'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { email, code } = req.body;

      console.log(`[AUTH] ═══════════════════════════════════════════════════════`);
      console.log(`[AUTH] 🔐 Verifying login OTP for: ${email}`);
      console.log(`[AUTH] 📝 Code: ${code}`);
      console.log(`[AUTH] ═══════════════════════════════════════════════════════`);

      // First, let's check what OTP codes exist for this email
      const debugResult = await pool.query(
        `SELECT code, purpose, expires_at, expires_at > NOW() as is_valid FROM otp_codes WHERE email = $1`,
        [email]
      );
      console.log(`[AUTH] 🔍 Found ${debugResult.rows.length} OTP code(s) in database for ${email}:`);
      debugResult.rows.forEach((row, idx) => {
        console.log(`[AUTH]   ${idx + 1}. Code: ${row.code}, Purpose: ${row.purpose}, Valid: ${row.is_valid}, Expires: ${row.expires_at}`);
      });

      // Check if code is valid
      const result = await pool.query(
        `SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND purpose = $3 AND expires_at > NOW()`,
        [email, code, '2fa']
      );

      if (result.rows.length === 0) {
        console.log(`[AUTH] ❌ Invalid or expired OTP code for ${email}`);
        return next(new AppError('Invalid or expired verification code', 400));
      }

      // Delete used code
      await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [email, '2fa']);

      console.log(`[AUTH] ✅ OTP verified successfully for ${email}`);

      // Get user information
      const pwCol = await detectPasswordColumn();
      if (!pwCol) return next(new AppError('Server misconfiguration: no password column found', 500));

      const userResult = await pool.query(
        `SELECT id, email, account_type, name FROM users WHERE email = $1`,
        [email]
      );

      if (userResult.rows.length === 0) {
        return next(new AppError('User not found', 404));
      }

      const user = userResult.rows[0];

      // Get name - for candidates from candidates table, for companies from users table
      let displayName = user.name || email.split('@')[0];
      
      if (user.account_type === 'candidate') {
        const candNameCol = await detectColumn('candidates', ['full_name', 'name', 'first_name']);
        if (candNameCol === 'full_name' || candNameCol === 'name') {
          const candidateResult = await pool.query(`SELECT ${candNameCol} as candidate_name FROM candidates WHERE user_id = $1`, [user.id]);
          if (candidateResult.rows.length > 0 && candidateResult.rows[0].candidate_name) {
            displayName = candidateResult.rows[0].candidate_name;
          }
        } else if (candNameCol === 'first_name') {
          const candidateResult = await pool.query(`SELECT first_name, last_name FROM candidates WHERE user_id = $1`, [user.id]);
          if (candidateResult.rows.length > 0) {
            const r = candidateResult.rows[0];
            displayName = [r.first_name, r.last_name].filter(Boolean).join(' ') || displayName;
          }
        }
      }

      // Generate token
      const token = generateToken(user.id);

      console.log(`[AUTH] ✅ Token generated successfully for ${email}`);

      res.json({
        success: true,
        message: 'Login successful!',
        token,
        user: {
          id: user.id,
          name: displayName,
          email: user.email,
          accountType: user.account_type,
          role: user.account_type,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get('/me', protect, async (req, res, next) => {
  try {
    res.json({
      success: true,
      user: req.user,
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/auth/logout
// @desc    Logout endpoint (stateless JWT apps usually just clear client tokens)
// @access  Public
router.post('/logout', async (req, res, next) => {
  try {
    // Nothing to do server-side for stateless JWTs. Return success so clients don't error.
    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Send OTP code to email for password reset
// @access  Public
router.post('/forgot-password', [
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res, next) => {
  try {
    console.log('\n[AUTH] ═══════════════════════════════════════════════════════');
    console.log('[AUTH] 🔄 FORGOT PASSWORD REQUEST RECEIVED');
    console.log('[AUTH] Request body:', JSON.stringify(req.body, null, 2));
    console.log('[AUTH] ═══════════════════════════════════════════════════════\n');
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[AUTH] ❌ Validation errors:', errors.array());
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email } = req.body;
    console.log(`[AUTH] Processing forgot password for: ${email}`);

    // Check if user exists
    const userResult = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    
    console.log(`[AUTH] User lookup result: Found ${userResult.rows.length} user(s)`);
    
    if (userResult.rows.length === 0) {
      console.log(`[AUTH] ⚠️  User not found for email: ${email} (returning success for security)`);
      // Don't reveal if user exists or not for security
      return res.json({ success: true, message: 'If an account exists, a reset code has been sent to your email' });
    }

    console.log(`[AUTH] ✓ User found, generating OTP code...`);
    
    // Generate OTP code
    const code = generateOtpCode();
    
    // Delete any existing reset codes for this email
    try {
      await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [email, 'reset-password']);
    } catch (delErr) {
      console.warn('[AUTH] Failed to delete existing reset codes for', email, delErr.message || delErr);
    }

    // Store OTP with reset-password purpose
    await pool.query(
      `INSERT INTO otp_codes (email, code, purpose, expires_at, created_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW())`,
      [email, code, 'reset-password']
    );

    console.log(`[AUTH] ═══════════════════════════════════════════════════════`);
    console.log(`[AUTH] 📧 Password Reset Request for: ${email}`);
    console.log(`[AUTH] 🔐 Reset Code: ${code}`);
    console.log(`[AUTH] ⏰ Expires in: 10 minutes`);
    console.log(`[AUTH] ═══════════════════════════════════════════════════════`);

    // Send reset code via email (await to catch errors immediately)
    let emailSent = false;
    try {
      const emailResult = await sendOtpEmail(email, code, 'reset-password');
      if (emailResult.ok) {
        console.log(`[AUTH] ✅ Email sent successfully! Message ID: ${emailResult.messageId}`);
        emailSent = true;
      } else if (emailResult.skipped) {
        console.warn(`[AUTH] ⚠️  Email sending skipped (SendGrid not configured)`);
      } else {
        console.error(`[AUTH] ❌ Failed to send email to ${email}`);
        if (emailResult.error) {
          console.error(`[AUTH]    Error: ${emailResult.error.message || emailResult.error}`);
        }
      }
    } catch (err) {
      console.error('[AUTH] ❌ Error sending password reset OTP:', err.message || err);
      if (err.response) {
        console.error('[AUTH] SendGrid response:', err.response.body);
      }
    }

    res.json({ success: true, message: 'If an account exists, a reset code has been sent to your email' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/auth/reset-password
// @desc    Reset password using OTP code
// @access  Public
router.post('/reset-password', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('code').notEmpty().withMessage('OTP code is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, code, newPassword } = req.body;

    // Verify OTP code
    const otpResult = await pool.query(
      `SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND purpose = $3 AND expires_at > NOW()`,
      [email, code, 'reset-password']
    );

    if (otpResult.rows.length === 0) {
      return next(new AppError('Invalid or expired reset code', 400));
    }

    // Find user
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    
    if (userResult.rows.length === 0) {
      return next(new AppError('User not found', 404));
    }

    const user = userResult.rows[0];

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password (detect which column to use)
    const pwCol = await detectPasswordColumn();
    if (!pwCol) {
      return next(new AppError('Server misconfiguration: no password column found', 500));
    }

    await pool.query(
      `UPDATE users SET ${pwCol} = $1 WHERE id = $2`,
      [hashedPassword, user.id]
    );

    // Delete used OTP code
    await pool.query('DELETE FROM otp_codes WHERE email = $1 AND purpose = $2', [email, 'reset-password']);

    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;