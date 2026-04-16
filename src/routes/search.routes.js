import express from 'express';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { signImageUrl } from '../utils/supabaseStorage.js';

const router = express.Router();

// All search routes require authentication
router.use(protect);

function buildIlikeConditions(columns, paramIndex) {
  return columns.map(col => `${col} ILIKE $${paramIndex}`).join(' OR ');
}

function escapeIlike(str) {
  return str.replace(/[\\%_]/g, ch => '\\' + ch);
}

// ─── GET /api/search?q=...  — quick combined search (navbar dropdown) ─
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ success: true, candidates: [], companies: [] });
    }

    const escaped = escapeIlike(q);
    const pattern = `%${escaped}%`;
    const prefix = `${escaped}%`;

    const [candidatesResult, companiesResult] = await Promise.all([
      pool.query(
        `SELECT c.user_id, c.full_name, c.title, c.location, c.avatar_url
         FROM candidates c
         JOIN users u ON u.id = c.user_id
         WHERE (${buildIlikeConditions(['c.full_name', 'c.title', 'c.location'], 1)})
         ORDER BY
           CASE WHEN c.full_name ILIKE $2 THEN 0 ELSE 1 END,
           c.full_name ASC
         LIMIT 5`,
        [pattern, prefix]
      ),
      pool.query(
        `SELECT id, name, slug, industry, location, logo_url, is_verified
         FROM companies
         WHERE ${buildIlikeConditions(['name', 'industry', 'location'], 1)}
         ORDER BY
           CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END,
           name ASC
         LIMIT 5`,
        [pattern, prefix]
      ),
    ]);

    // Sign storage paths into real URLs
    const candidates = await Promise.all(
      candidatesResult.rows.map(async (c) => ({
        ...c,
        avatar_url: await signImageUrl(c.avatar_url),
      }))
    );
    const companies = await Promise.all(
      companiesResult.rows.map(async (c) => ({
        ...c,
        logo_url: await signImageUrl(c.logo_url),
      }))
    );

    res.json({ success: true, candidates, companies });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/search/candidates?q=...&page=1&limit=12  — paginated ─
router.get('/candidates', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 12, 50));
    const offset = (page - 1) * limit;

    if (q.length < 2) {
      return res.json({ success: true, candidates: [], total: 0 });
    }

    const escaped = escapeIlike(q);
    const pattern = `%${escaped}%`;
    const prefix = `${escaped}%`;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT c.user_id, c.full_name, c.title, c.location, c.avatar_url
         FROM candidates c
         JOIN users u ON u.id = c.user_id
         WHERE (${buildIlikeConditions(['c.full_name', 'c.title', 'c.location'], 1)})
         ORDER BY
           CASE WHEN c.full_name ILIKE $2 THEN 0 ELSE 1 END,
           c.full_name ASC
         LIMIT $3 OFFSET $4`,
        [pattern, prefix, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM candidates c
         JOIN users u ON u.id = c.user_id
         WHERE (${buildIlikeConditions(['c.full_name', 'c.title', 'c.location'], 1)})`,
        [pattern]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    const candidates = await Promise.all(
      result.rows.map(async (c) => ({
        ...c,
        avatar_url: await signImageUrl(c.avatar_url),
      }))
    );

    res.json({
      success: true,
      candidates,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/search/companies?q=...&page=1&limit=12  — paginated ──
router.get('/companies', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 12, 50));
    const offset = (page - 1) * limit;

    if (q.length < 2) {
      return res.json({ success: true, companies: [], total: 0 });
    }

    const escaped = escapeIlike(q);
    const pattern = `%${escaped}%`;
    const prefix = `${escaped}%`;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT id, name, slug, industry, location, logo_url, is_verified
         FROM companies
         WHERE ${buildIlikeConditions(['name', 'industry', 'location'], 1)}
         ORDER BY
           CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END,
           name ASC
         LIMIT $3 OFFSET $4`,
        [pattern, prefix, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM companies
         WHERE ${buildIlikeConditions(['name', 'industry', 'location'], 1)}`,
        [pattern]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);

    const companies = await Promise.all(
      result.rows.map(async (c) => ({
        ...c,
        logo_url: await signImageUrl(c.logo_url),
      }))
    );

    res.json({
      success: true,
      companies,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
