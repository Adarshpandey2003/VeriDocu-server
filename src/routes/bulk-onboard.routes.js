import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { parse } from 'csv-parse/sync';
import crypto from 'crypto';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { sendBulkOnboardInvite } from '../utils/mailer.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function parseRows(rows) {
  return rows.map((row, idx) => {
    const email = String(row.email || '').trim().toLowerCase();
    const fullName = String(row.full_name || row.name || '').trim();
    const position = String(row.position || row.title || '').trim();
    const startDate = parseDate(row.start_date || row.start);
    const endDate = parseDate(row.end_date || row.end);
    const isCurrent = ['true', '1', 'yes', 'y'].includes(String(row.is_current || '').toLowerCase()) || !endDate;

    const errors = [];
    if (!email) errors.push('Email required');
    else if (!isValidEmail(email)) errors.push('Invalid email format');
    if (!position) errors.push('Position required');
    if (!startDate) errors.push('Valid start_date required (YYYY-MM-DD)');

    return {
      rowIndex: idx + 1,
      email, fullName, position, startDate, endDate, isCurrent,
      errors,
      valid: errors.length === 0,
    };
  });
}

// POST /api/company/employees/parse-csv - preview CSV without committing
router.post('/employees/parse-csv', protect, upload.single('file'), async (req, res, next) => {
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Companies only', 403));
    }
    if (!req.file) return next(new AppError('No CSV file uploaded', 400));

    const csvText = req.file.buffer.toString('utf8');
    let rows;
    try {
      rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      return next(new AppError('Failed to parse CSV: ' + err.message, 400));
    }

    const parsed = parseRows(rows);
    res.json({
      success: true,
      total: parsed.length,
      validCount: parsed.filter((r) => r.valid).length,
      invalidCount: parsed.filter((r) => !r.valid).length,
      rows: parsed,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/company/employees/bulk-onboard - commit verified employment records
router.post('/employees/bulk-onboard', protect, async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.user.account_type !== 'company') {
      return next(new AppError('Companies only', 403));
    }

    const { rows = [] } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return next(new AppError('No rows provided', 400));
    }

    const companyRes = await pool.query(
      'SELECT id, name FROM companies WHERE user_id = $1',
      [req.user.id]
    );
    if (companyRes.rows.length === 0) {
      return next(new AppError('Company profile not found', 404));
    }
    const company = companyRes.rows[0];

    const results = { total: rows.length, succeeded: 0, failed: [], invited: 0 };

    for (const row of rows) {
      const { email, fullName, position, startDate, endDate, isCurrent } = row;

      try {
        if (!email || !isValidEmail(email) || !position || !startDate) {
          results.failed.push({ email: email || '(missing)', reason: 'Invalid row data' });
          continue;
        }

        await client.query('BEGIN');

        // Find or create user
        let userRow = (await client.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
        let isNewUser = false;
        if (!userRow) {
          isNewUser = true;
          // Generate an unguessable placeholder password to satisfy users_auth_method_check.
          // The candidate will use the forgot-password flow to set their real password.
          const placeholder = crypto.randomBytes(32).toString('hex');
          const placeholderHash = await bcrypt.hash(placeholder, 10);
          const ins = await client.query(
            `INSERT INTO users (email, password, account_type, name, created_at)
             VALUES ($1, $2, 'candidate', $3, NOW()) RETURNING id`,
            [email, placeholderHash, fullName || null]
          );
          userRow = ins.rows[0];
        }

        // Find or create candidate
        let candidate = (await client.query('SELECT id FROM candidates WHERE user_id = $1', [userRow.id])).rows[0];
        if (!candidate) {
          const ins = await client.query(
            'INSERT INTO candidates (user_id, full_name, created_at) VALUES ($1, $2, NOW()) RETURNING id',
            [userRow.id, fullName || null]
          );
          candidate = ins.rows[0];
        }

        // Check for duplicate employment record
        const dup = await client.query(
          `SELECT id FROM employment_history
           WHERE candidate_id = $1 AND company_id = $2 AND position = $3 AND start_date = $4`,
          [candidate.id, company.id, position, startDate]
        );
        if (dup.rows.length > 0) {
          await client.query('ROLLBACK');
          results.failed.push({ email, reason: 'Already onboarded for this position' });
          continue;
        }

        // Insert verified employment record
        await client.query(
          `INSERT INTO employment_history
             (candidate_id, company_id, company_name, position, start_date, end_date, is_current,
              verification_status, verified_at, verified_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'verified', NOW(), $8, NOW())`,
          [candidate.id, company.id, company.name, position, startDate, endDate, isCurrent, req.user.id]
        );

        await client.query('COMMIT');
        results.succeeded += 1;

        // For new users, send invite to claim profile
        if (isNewUser) {
          const inviteToken = crypto.randomBytes(24).toString('hex');
          const signupLink = `${process.env.CLIENT_URL || 'http://localhost:3000'}/auth/register?invite=${inviteToken}&email=${encodeURIComponent(email)}`;
          results.invited += 1;
          sendBulkOnboardInvite({
            to: email,
            candidateName: fullName,
            companyName: company.name,
            position,
            signupLink,
          }).catch((err) => console.error('[BulkOnboard] email error:', err.message));
        }
      } catch (rowErr) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error(`[BulkOnboard] row error for ${email}:`, rowErr.message);
        results.failed.push({ email, reason: rowErr.message });
      }
    }

    res.json({ success: true, ...results });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

export default router;
