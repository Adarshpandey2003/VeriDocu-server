import express from 'express';
import pool from '../config/database.js';
import { protect, authorize } from '../middleware/auth.js';

const router = express.Router();

router.use(protect);
router.use(authorize('admin'));

const VALID_EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Freelance', 'Internship'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve a company id from a row: prefer explicit company_id, else look up by company_name.
async function resolveCompanyId(raw, defaultCompanyId) {
  if (raw.company_id && UUID_RE.test(String(raw.company_id))) {
    const check = await pool.query('SELECT id FROM companies WHERE id = $1', [raw.company_id]);
    if (check.rows.length > 0) return check.rows[0].id;
    return null;
  }
  const name = String(raw.company_name || raw.company || '').trim();
  if (name) {
    const lookup = await pool.query(
      'SELECT id FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [name]
    );
    if (lookup.rows.length > 0) return lookup.rows[0].id;
    return null;
  }
  if (defaultCompanyId && UUID_RE.test(String(defaultCompanyId))) {
    return defaultCompanyId;
  }
  return null;
}

// GET /api/admin/jobs — paginated list of all jobs across all companies
router.get('/', async (req, res) => {
  try {
    const { search, companyId, isActive, page = 1, limit = 20 } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    let where = ' WHERE 1=1';
    const params = [];
    let pi = 1;

    if (search && String(search).trim()) {
      where += ` AND (j.title ILIKE $${pi} OR j.location ILIKE $${pi} OR c.name ILIKE $${pi})`;
      params.push(`%${String(search).trim()}%`);
      pi++;
    }
    if (companyId && UUID_RE.test(String(companyId))) {
      where += ` AND j.company_id = $${pi++}`;
      params.push(companyId);
    }
    if (isActive === 'true' || isActive === 'false') {
      where += ` AND j.is_active = $${pi++}`;
      params.push(isActive === 'true');
    }

    const listSql = `
      SELECT j.id, j.title, j.location, j.employment_type, j.salary_min, j.salary_max,
             j.is_active, j.created_at, j.company_id,
             c.name AS company_name, c.is_verified AS company_verified,
             (SELECT COUNT(*) FROM job_applications WHERE job_id = j.id)::int AS application_count
      FROM jobs j
      LEFT JOIN companies c ON c.id = j.company_id
      ${where}
      ORDER BY j.created_at DESC
      LIMIT $${pi++} OFFSET $${pi++}
    `;
    const countSql = `
      SELECT COUNT(*)::int AS count
      FROM jobs j
      LEFT JOIN companies c ON c.id = j.company_id
      ${where}
    `;

    const listParams = [...params, limitNum, offset];

    const [list, count, agg] = await Promise.all([
      pool.query(listSql, listParams),
      pool.query(countSql, params),
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_active = true)::int AS active,
          COUNT(*) FILTER (WHERE is_active = false)::int AS inactive
        FROM jobs
      `),
    ]);

    const total = count.rows[0].count;

    res.json({
      success: true,
      jobs: list.rows,
      pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
      counts: agg.rows[0],
    });
  } catch (error) {
    console.error('Error fetching admin jobs:', error);
    res.status(500).json({ success: false, message: 'Error fetching jobs' });
  }
});

// POST /api/admin/jobs/bulk-import — create multiple jobs from a JSON array
router.post('/bulk-import', async (req, res) => {
  try {
    const { jobs, defaultCompanyId, defaultActive = true } = req.body;

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ success: false, message: 'jobs array is required' });
    }
    if (jobs.length > 500) {
      return res.status(400).json({ success: false, message: 'Maximum 500 jobs per import' });
    }

    const results = { total: jobs.length, succeeded: 0, failed: [], inserted: [] };

    for (let i = 0; i < jobs.length; i++) {
      const raw = jobs[i];
      try {
        const title = String(raw.title || '').trim();
        const description = String(raw.description || '').trim();
        const location = String(raw.location || '').trim();

        if (!title) {
          results.failed.push({ index: i, title: '(missing)', reason: 'Missing title' });
          continue;
        }
        if (!description) {
          results.failed.push({ index: i, title, reason: 'Missing description' });
          continue;
        }
        if (!location) {
          results.failed.push({ index: i, title, reason: 'Missing location' });
          continue;
        }

        const companyId = await resolveCompanyId(raw, defaultCompanyId);
        if (!companyId) {
          results.failed.push({
            index: i,
            title,
            reason: 'Could not resolve company (provide company_id, company_name, or defaultCompanyId)',
          });
          continue;
        }

        const employment_type = VALID_EMPLOYMENT_TYPES.includes(raw.employment_type)
          ? raw.employment_type
          : 'Full-time';

        const skills = Array.isArray(raw.required_skills)
          ? raw.required_skills.map((s) => String(s).trim()).filter(Boolean)
          : null;
        const benefits = Array.isArray(raw.benefits)
          ? raw.benefits.map((s) => String(s).trim()).filter(Boolean)
          : null;

        const salaryMin = raw.salary_min != null && raw.salary_min !== ''
          ? parseInt(raw.salary_min, 10) || null
          : null;
        const salaryMax = raw.salary_max != null && raw.salary_max !== ''
          ? parseInt(raw.salary_max, 10) || null
          : null;

        const isActive = typeof raw.is_active === 'boolean' ? raw.is_active : !!defaultActive;
        const resumeRequired = !!raw.resume_required;
        const applicationForm = raw.application_form ? JSON.stringify(raw.application_form) : null;

        const insert = await pool.query(
          `INSERT INTO jobs
            (company_id, title, description, requirements, required_skills,
             benefits, location, employment_type, salary_min, salary_max,
             application_form, resume_required, is_active, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())
           RETURNING id, title, company_id`,
          [
            companyId,
            title,
            description,
            raw.requirements || null,
            skills && skills.length > 0 ? skills : null,
            benefits && benefits.length > 0 ? benefits : null,
            location,
            employment_type,
            salaryMin,
            salaryMax,
            applicationForm,
            resumeRequired,
            isActive,
          ]
        );

        results.succeeded++;
        results.inserted.push(insert.rows[0]);
      } catch (rowErr) {
        console.error(`[BulkImportJobs] row ${i} error:`, rowErr.message);
        results.failed.push({ index: i, title: raw.title || '(unknown)', reason: rowErr.message });
      }
    }

    res.json({ success: true, ...results });
  } catch (error) {
    console.error('Error in admin jobs bulk import:', error);
    res.status(500).json({ success: false, message: 'Bulk import failed' });
  }
});

// PATCH /api/admin/jobs/:id/status — toggle active/inactive
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (!UUID_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid job id' });
    }
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ success: false, message: 'is_active must be boolean' });
    }

    const result = await pool.query(
      'UPDATE jobs SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_active',
      [is_active, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    res.json({ success: true, job: result.rows[0] });
  } catch (error) {
    console.error('Error updating job status:', error);
    res.status(500).json({ success: false, message: 'Error updating job status' });
  }
});

// DELETE /api/admin/jobs/:id — delete a job
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'Invalid job id' });
    }
    const result = await pool.query('DELETE FROM jobs WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }
    res.json({ success: true, message: 'Job deleted' });
  } catch (error) {
    console.error('Error deleting job:', error);
    res.status(500).json({ success: false, message: 'Error deleting job' });
  }
});

// GET /api/admin/jobs/companies — list companies for the import "default company" picker
router.get('/companies', async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT id, name, is_verified FROM companies';
    const params = [];
    if (search && String(search).trim()) {
      sql += ' WHERE name ILIKE $1';
      params.push(`%${String(search).trim()}%`);
    }
    sql += ' ORDER BY name ASC LIMIT 100';
    const result = await pool.query(sql, params);
    res.json({ success: true, companies: result.rows });
  } catch (error) {
    console.error('Error listing companies for admin jobs:', error);
    res.status(500).json({ success: false, message: 'Error listing companies' });
  }
});

export default router;
