import express from 'express';
import { protect, authorize } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();
const logger = { info: (...a) => console.log('[INFO]', ...a), error: (...a) => console.error('[ERROR]', ...a) };

// All endpoints under /api/admin/crawler require an admin.
router.use(protect, authorize('admin'));

// GET /api/admin/crawler/sources
router.get('/sources', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cs.*,
              (SELECT COUNT(*)::int FROM jobs j WHERE j.source_key = cs.key) AS total_jobs
       FROM crawler_sources cs
       ORDER BY cs.display_name ASC`
    );
    res.json({ success: true, sources: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/crawler/sources/:id  — update config
router.patch('/sources/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { enabled, schedule_cron, search_queries, location_filter, max_per_run } = req.body || {};

    const fields = [];
    const values = [];
    let idx = 1;
    if (typeof enabled === 'boolean')       { fields.push(`enabled = $${idx++}`); values.push(enabled); }
    if (typeof schedule_cron === 'string')  { fields.push(`schedule_cron = $${idx++}`); values.push(schedule_cron); }
    if (Array.isArray(search_queries))      { fields.push(`search_queries = $${idx++}`); values.push(search_queries.map((s) => String(s).trim()).filter(Boolean)); }
    if (location_filter === null || typeof location_filter === 'string') { fields.push(`location_filter = $${idx++}`); values.push(location_filter || null); }
    if (Number.isFinite(max_per_run))       { fields.push(`max_per_run = $${idx++}`); values.push(Math.max(1, Math.min(500, parseInt(max_per_run, 10)))); }

    if (fields.length === 0) {
      return next(new AppError('No valid fields to update', 400));
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);
    const updateSql = `UPDATE crawler_sources SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await pool.query(updateSql, values);
    if (result.rows.length === 0) return next(new AppError('Source not found', 404));

    // Reload cron schedule if available (best-effort; never fail the request).
    try {
      const mod = await import('../crawlers/scheduler.js');
      await mod.reload?.();
    } catch (_) { /* scheduler optional */ }

    res.json({ success: true, source: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/crawler/sources/:id/run  — fire-and-forget manual trigger
router.post('/sources/:id/run', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM crawler_sources WHERE id = $1', [id]);
    if (result.rows.length === 0) return next(new AppError('Source not found', 404));

    const source = result.rows[0];

    // Create a run row up front so the client can poll it.
    const runResult = await pool.query(
      `INSERT INTO crawler_runs (source_id, status, triggered_by) VALUES ($1, 'running', 'manual') RETURNING id`,
      [source.id]
    );
    const runId = runResult.rows[0].id;

    // Schedule the actual run without blocking the response.
    setImmediate(async () => {
      try {
        const runner = await import('../crawlers/runner.js');
        await runner.runSource(source, { runId, triggeredBy: 'manual' });
      } catch (err) {
        try {
          await pool.query(
            `UPDATE crawler_runs SET status = 'error', error_text = $1, finished_at = NOW() WHERE id = $2`,
            [err.message || String(err), runId]
          );
          await pool.query(
            `UPDATE crawler_sources SET last_run_at = NOW(), last_status = 'error', last_error = $1 WHERE id = $2`,
            [err.message || String(err), source.id]
          );
        } catch (_) { /* swallow */ }
      }
    });

    res.status(202).json({ success: true, runId });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/crawler/runs?sourceId=&limit=
router.get('/runs', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const { sourceId } = req.query;
    const params = [];
    let where = '';
    if (sourceId) {
      where = 'WHERE r.source_id = $1';
      params.push(sourceId);
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT r.*, s.key AS source_key, s.display_name AS source_name
       FROM crawler_runs r
       JOIN crawler_sources s ON s.id = r.source_id
       ${where}
       ORDER BY r.started_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, runs: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/crawler/sources/:id/scraped?limit=
router.get('/sources/:id/scraped', async (req, res, next) => {
  try {
    const { id } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const result = await pool.query(
      `SELECT sj.id, sj.external_id, sj.external_url, sj.scraped_at,
              j.title, j.location, c.name AS company_name
       FROM scraped_jobs sj
       LEFT JOIN jobs j ON j.id = sj.ingested_job_id
       LEFT JOIN companies c ON c.id = j.company_id
       WHERE sj.source_id = $1
       ORDER BY sj.scraped_at DESC
       LIMIT $2`,
      [id, limit]
    );
    res.json({ success: true, scraped: result.rows });
  } catch (err) {
    next(err);
  }
});

// ════════════════════════════════════════════════════════════════════
// Company Career Page Routes
// ════════════════════════════════════════════════════════════════════

// GET /api/admin/crawler/company-careers
router.get('/company-careers', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cc.*,
              c.name AS company_name,
              c.logo_url AS company_logo,
              (SELECT COUNT(*)::int FROM jobs j WHERE j.source_key = 'company_career' AND j.company_id = cc.company_id) AS total_jobs
       FROM company_careers cc
       JOIN companies c ON c.id = cc.company_id
       ORDER BY cc.last_run_at DESC NULLS LAST, c.name ASC`
    );
    res.json({ success: true, companies: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/crawler/company-careers/:id
router.get('/company-careers/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT cc.*, c.name AS company_name, c.logo_url AS company_logo
       FROM company_careers cc
       JOIN companies c ON c.id = cc.company_id
       WHERE cc.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return next(new AppError('Company career entry not found', 404));
    res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/crawler/company-careers/:id
router.patch('/company-careers/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { enabled, ats_type, board_key, schedule_cron, max_jobs_per_run, selectors, needs_browser } = req.body || {};

    const fields = [];
    const values = [];
    let idx = 1;
    if (typeof enabled === 'boolean')        { fields.push(`enabled = $${idx++}`);        values.push(enabled); }
    if (typeof ats_type === 'string')        { fields.push(`ats_type = $${idx++}`);        values.push(ats_type); }
    if (typeof board_key === 'string' || board_key === null) { fields.push(`board_key = $${idx++}`); values.push(board_key || null); }
    if (typeof schedule_cron === 'string')   { fields.push(`schedule_cron = $${idx++}`);   values.push(schedule_cron); }
    if (Number.isFinite(max_jobs_per_run))   { fields.push(`max_jobs_per_run = $${idx++}`); values.push(Math.max(1, Math.min(200, parseInt(max_jobs_per_run, 10)))); }
    if (typeof selectors === 'object' || selectors === null) { fields.push(`selectors = $${idx++}`); values.push(selectors ? JSON.stringify(selectors) : null); }
    if (typeof needs_browser === 'boolean')  { fields.push(`needs_browser = $${idx++}`);   values.push(needs_browser); }

    if (fields.length === 0) return next(new AppError('No valid fields to update', 400));

    fields.push(`updated_at = NOW()`);
    values.push(id);
    const updateSql = `UPDATE company_careers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;
    const result = await pool.query(updateSql, values);
    if (result.rows.length === 0) return next(new AppError('Company career entry not found', 404));

    res.json({ success: true, company: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/crawler/company-careers/:id/run — manual trigger
router.post('/company-careers/:id/run', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM company_careers WHERE id = $1', [id]);
    if (result.rows.length === 0) return next(new AppError('Company career entry not found', 404));

    const row = result.rows[0];

    const runResult = await pool.query(
      `INSERT INTO crawler_runs (source_id, status, triggered_by) VALUES ($1, 'running', 'manual') RETURNING id`,
      [row.id]
    );
    const runId = runResult.rows[0].id;

    setImmediate(async () => {
      try {
        const { runCompanyCareer } = await import('../crawlers/companyRunner.js');
        await runCompanyCareer(row, { runId, triggeredBy: 'manual' });
      } catch (err) {
        try {
          await pool.query(
            'UPDATE crawler_runs SET status = $1, error_text = $2, finished_at = NOW() WHERE id = $3',
            ['error', err.message || String(err), runId]
          );
          await pool.query(
            'UPDATE company_careers SET last_run_at = NOW(), last_status = $1, last_error = $2 WHERE id = $3',
            ['error', err.message || String(err), row.id]
          );
        } catch (_) { /* swallow */ }
      }
    });

    res.status(202).json({ success: true, runId });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/crawler/company-careers/run-all — batch trigger
router.post('/company-careers/run-all', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM company_careers WHERE enabled = TRUE ORDER BY last_run_at ASC NULLS FIRST'
    );

    res.status(202).json({ success: true, started: result.rows.length });

    // Stagger runs with a small delay to prevent concurrent browser crashes.
    // Browser-needed runs get a longer gap; API-only runs are faster.
    const STAGGER_MS = 5000;
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      const delay = i * STAGGER_MS;
      setTimeout(async () => {
        try {
          const runResult = await pool.query(
            `INSERT INTO crawler_runs (source_id, status, triggered_by) VALUES ($1, 'running', 'manual') RETURNING id`,
            [row.id]
          );
          const { runCompanyCareer } = await import('../crawlers/companyRunner.js');
          await runCompanyCareer(row, { runId: runResult.rows[0].id, triggeredBy: 'manual' });
        } catch (err) {
          logger.info(`[crawler] run-all: ${row.id} failed: ${err.message}`);
        }
      }, delay);
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/crawler/company-careers/:id/jobs — scraped jobs preview
router.get('/company-careers/:id/jobs', async (req, res, next) => {
  try {
    const { id } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const result = await pool.query(
      `SELECT sj.id, sj.external_id, sj.external_url, sj.scraped_at,
              j.title, j.location, j.description
       FROM scraped_jobs sj
       LEFT JOIN jobs j ON j.id = sj.ingested_job_id
       WHERE sj.source_id = $1
       ORDER BY sj.scraped_at DESC
       LIMIT $2`,
      [id, limit]
    );
    res.json({ success: true, jobs: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/crawler/company-careers/:id/runs
router.get('/company-careers/:id/runs', async (req, res, next) => {
  try {
    const { id } = req.params;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const result = await pool.query(
      `SELECT r.* FROM crawler_runs r
       WHERE r.source_id = $1
       ORDER BY r.started_at DESC
       LIMIT $2`,
      [id, limit]
    );
    res.json({ success: true, runs: result.rows });
  } catch (err) {
    next(err);
  }
});

export default router;
