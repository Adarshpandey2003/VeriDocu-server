import express from 'express';
import pool from '../config/database.js';
import { protect } from '../middleware/auth.js';
import { signImageUrl } from '../utils/supabaseStorage.js';

const router = express.Router();

router.use(protect);

function buildTsquery(q) {
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map(w => w.replace(/[^a-zA-Z0-9]/g, '') + ':*').filter(w => w !== ':*').join(' & ');
}

// ─── GET /api/search?q=...  — quick combined search (navbar dropdown) ───
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ success: true, candidates: [], companies: [], jobs: [] });
    }

    const tsquery = buildTsquery(q);

    const [candidatesResult, companiesResult, jobsResult] = await Promise.all([
      tsquery
        ? pool.query(
            `SELECT c.user_id, c.full_name, c.title, c.location, c.avatar_url,
                    ts_rank(c.search_vector, to_tsquery('english', $1)) AS rank
             FROM candidates c
             JOIN users u ON u.id = c.user_id
             WHERE c.search_vector @@ to_tsquery('english', $1)
                OR c.full_name % $2
             ORDER BY rank DESC, similarity(c.full_name, $2) DESC
             LIMIT 5`,
            [tsquery, q]
          )
        : pool.query(
            `SELECT c.user_id, c.full_name, c.title, c.location, c.avatar_url
             FROM candidates c
             JOIN users u ON u.id = c.user_id
             WHERE c.full_name % $1
             ORDER BY similarity(c.full_name, $1) DESC
             LIMIT 5`,
            [q]
          ),

      tsquery
        ? pool.query(
            `SELECT id, name, slug, industry, location, logo_url, is_verified,
                    ts_rank(search_vector, to_tsquery('english', $1)) AS rank
             FROM companies
             WHERE search_vector @@ to_tsquery('english', $1)
                OR name % $2
             ORDER BY rank DESC, similarity(name, $2) DESC
             LIMIT 5`,
            [tsquery, q]
          )
        : pool.query(
            `SELECT id, name, slug, industry, location, logo_url, is_verified
             FROM companies
             WHERE name % $1
             ORDER BY similarity(name, $1) DESC
             LIMIT 5`,
            [q]
          ),

      tsquery
        ? pool.query(
            `SELECT id, title, location, employment_type,
                    ts_rank(search_vector, to_tsquery('english', $1)) AS rank
             FROM jobs
             WHERE is_active = true
               AND (search_vector @@ to_tsquery('english', $1) OR title % $2)
             ORDER BY rank DESC, similarity(title, $2) DESC
             LIMIT 5`,
            [tsquery, q]
          )
        : pool.query(
            `SELECT id, title, location, employment_type
             FROM jobs
             WHERE is_active = true AND title % $1
             ORDER BY similarity(title, $1) DESC
             LIMIT 5`,
            [q]
          ),
    ]);

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

    res.json({ success: true, candidates, companies, jobs: jobsResult.rows });
  } catch (error) {
    next(error);
  }
});

// ─── GET /api/search/candidates?q=...&page=1&limit=12 — paginated ───
router.get('/candidates', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 12, 50));
    const offset = (page - 1) * limit;

    if (q.length < 2) {
      return res.json({ success: true, candidates: [], total: 0 });
    }

    const tsquery = buildTsquery(q);

    const whereClause = tsquery
      ? `(c.search_vector @@ to_tsquery('english', $1) OR c.full_name % $2)`
      : `c.full_name % $1`;
    const orderClause = tsquery
      ? `ts_rank(c.search_vector, to_tsquery('english', $1)) DESC, similarity(c.full_name, $2) DESC`
      : `similarity(c.full_name, $1) DESC`;

    const params = tsquery ? [tsquery, q] : [q];
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT c.user_id, c.full_name, c.title, c.location, c.avatar_url
         FROM candidates c
         JOIN users u ON u.id = c.user_id
         WHERE ${whereClause}
         ORDER BY ${orderClause}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM candidates c
         JOIN users u ON u.id = c.user_id
         WHERE ${whereClause}`,
        params
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

// ─── GET /api/search/companies?q=...&page=1&limit=12 — paginated ───
router.get('/companies', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 12, 50));
    const offset = (page - 1) * limit;

    if (q.length < 2) {
      return res.json({ success: true, companies: [], total: 0 });
    }

    const tsquery = buildTsquery(q);

    const whereClause = tsquery
      ? `(search_vector @@ to_tsquery('english', $1) OR name % $2)`
      : `name % $1`;
    const orderClause = tsquery
      ? `ts_rank(search_vector, to_tsquery('english', $1)) DESC, similarity(name, $2) DESC`
      : `similarity(name, $1) DESC`;

    const params = tsquery ? [tsquery, q] : [q];
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT id, name, slug, industry, location, logo_url, is_verified
         FROM companies
         WHERE ${whereClause}
         ORDER BY ${orderClause}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...params, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) FROM companies WHERE ${whereClause}`,
        params
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
