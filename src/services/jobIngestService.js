import crypto from 'crypto';
import pool from '../config/database.js';

const VALID_EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Freelance', 'Internship'];

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'external';
}

// Find an existing company by name (case-insensitive), else create a placeholder.
// Placeholder companies have user_id=NULL and is_external=TRUE. When creating
// a new row, an optional logoUrl (remote URL or storage path) is persisted.
// Existing rows' logos are never overwritten.
export async function resolveOrCreatePlaceholderCompany(rawName, logoUrl) {
  const name = String(rawName || '').trim();
  if (!name) return null;

  const existing = await pool.query(
    'SELECT id FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1',
    [name]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  // Generate a unique slug. Append a short random suffix on collision.
  const baseSlug = slugify(name);
  let slug = `${baseSlug}-ext`;
  let attempt = 0;
  while (attempt < 5) {
    const slugCheck = await pool.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
    if (slugCheck.rows.length === 0) break;
    slug = `${baseSlug}-ext-${crypto.randomBytes(3).toString('hex')}`;
    attempt += 1;
  }

  const safeLogo = typeof logoUrl === 'string' && logoUrl.trim() ? logoUrl.trim().slice(0, 500) : null;

  const inserted = await pool.query(
    `INSERT INTO companies (user_id, name, slug, is_external, is_verified, logo_url)
     VALUES (NULL, $1, $2, TRUE, FALSE, $3)
     RETURNING id`,
    [name, slug, safeLogo]
  );
  return inserted.rows[0].id;
}

function buildExternalId(sourceKey, providedId, title, companyName, location) {
  if (providedId && String(providedId).trim()) return String(providedId).trim();
  const fingerprint = `${sourceKey}|${String(title || '').toLowerCase()}|${String(companyName || '').toLowerCase()}|${String(location || '').toLowerCase()}`;
  return crypto.createHash('sha1').update(fingerprint).digest('hex');
}

function normalizeEmploymentType(raw) {
  if (!raw) return 'Full-time';
  const match = VALID_EMPLOYMENT_TYPES.find((t) => t.toLowerCase() === String(raw).toLowerCase());
  return match || 'Full-time';
}

// Insert a scraped job into `jobs` (auto-creating company if needed) and
// record it in `scraped_jobs` for dedup. Returns { inserted: bool, jobId, externalId }.
// Idempotent: re-ingesting the same external id is a no-op.
export async function upsertExternalJob({
  sourceId,
  sourceKey,
  externalId,
  title,
  description,
  location,
  companyName,
  logoUrl,
  salaryMin,
  salaryMax,
  employmentType,
  requiredSkills,
  applyUrl,
  raw,
}) {
  if (!sourceId || !sourceKey) throw new Error('upsertExternalJob: sourceId and sourceKey required');
  if (!title || !description) {
    return { inserted: false, reason: 'Missing title or description' };
  }

  const finalExternalId = buildExternalId(sourceKey, externalId, title, companyName, location);

  // Quick dedup check before doing company-resolve work.
  const seen = await pool.query(
    'SELECT id, ingested_job_id FROM scraped_jobs WHERE source_id = $1 AND external_id = $2',
    [sourceId, finalExternalId]
  );
  if (seen.rows.length > 0) {
    return { inserted: false, externalId: finalExternalId, jobId: seen.rows[0].ingested_job_id, reason: 'duplicate' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const companyId = await resolveOrCreatePlaceholderCompany(companyName || 'External Listing', logoUrl);
    if (!companyId) {
      await client.query('ROLLBACK');
      return { inserted: false, reason: 'Could not resolve company' };
    }

    const jobInsert = await client.query(
      `INSERT INTO jobs (
        company_id, title, description, location, employment_type,
        salary_min, salary_max, required_skills, is_active,
        source_key, external_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)
      RETURNING id`,
      [
        companyId,
        title,
        description,
        location || null,
        normalizeEmploymentType(employmentType),
        Number.isFinite(salaryMin) ? salaryMin : null,
        Number.isFinite(salaryMax) ? salaryMax : null,
        Array.isArray(requiredSkills) && requiredSkills.length > 0 ? requiredSkills : null,
        sourceKey,
        applyUrl || null,
      ]
    );
    const jobId = jobInsert.rows[0].id;

    await client.query(
      `INSERT INTO scraped_jobs (source_id, external_id, external_url, ingested_job_id, raw_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_id, external_id) DO NOTHING`,
      [sourceId, finalExternalId, applyUrl || null, jobId, raw ? JSON.stringify(raw) : null]
    );

    await client.query('COMMIT');
    return { inserted: true, externalId: finalExternalId, jobId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
