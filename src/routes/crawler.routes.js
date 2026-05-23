import express from 'express';
import { protect, authorize } from '../middleware/auth.js';
import pool from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';

const router = express.Router();

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

export default router;
