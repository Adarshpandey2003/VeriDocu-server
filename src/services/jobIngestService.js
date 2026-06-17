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

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/ /g, ' ').trim();
}

function normalizeEmploymentType(raw) {
  if (!raw) return 'Full-time';
  const match = VALID_EMPLOYMENT_TYPES.find((t) => t.toLowerCase() === String(raw).toLowerCase());
  return match || 'Full-time';
}

// Insert a job scraped from a company career page. Unlike upsertExternalJob this
// takes a real companyId (no placeholder creation) and sources from company_careers
// table. Jobs are inherently "verified" since they come from the company's own site.
// Idempotent via scraped_jobs.
export async function upsertCompanyJob({
  companyCareersId,
  companyId,
  sourceKey,
  externalId,
  title,
  description,
  location,
  salaryMin,
  salaryMax,
  employmentType,
  requiredSkills,
  applyUrl,
  raw,
}) {
  if (!companyCareersId || !sourceKey) throw new Error('upsertCompanyJob: companyCareersId and sourceKey required');
  if (!companyId) throw new Error('upsertCompanyJob: companyId required');

  // ── Clean & validate fields ──
  const cleanTitle = cleanText(title).slice(0, 250);
  let cleanDesc = cleanText(description);

  if (!cleanTitle || !cleanDesc) {
    return { inserted: false, reason: 'Missing title or description' };
  }

  // Convert HTML structure to plain-text equivalents before stripping tags.
  // Preserves visual structure: bullets, paragraphs, headings → newlines.
  cleanDesc = cleanDesc
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/[ \t]+/g, ' ')      // collapse horizontal whitespace only (preserve \n)
    .replace(/\n{3,}/g, '\n\n')   // max 2 consecutive newlines
    .trim()
    .slice(0, 8000);

  // Quality gate: reject descriptions that are clearly junk
  if (cleanDesc.length < 50) {
    return { inserted: false, reason: 'Description too short (< 50 chars)' };
  }
  // Reject "More Details" / nav-listing fragments (title repeated + link text)
  if (/\bmore details\b/i.test(cleanDesc) && cleanDesc.length < 120) {
    return { inserted: false, reason: 'Description is a listing-card fragment' };
  }
  if (cleanDesc.toLowerCase() === cleanTitle.toLowerCase()) {
    return { inserted: false, reason: 'Description equals title' };
  }
  // Reject descriptions that are just navigation text (not real job content)
  const junkPatterns = [
    /^careers?\s+(at|in)\s+/i,
    /^see\s+(all|our)\s+(open\s+)?jobs/i,
    /^join\s+(our\s+)?talent\s+(network|community)/i,
    /^view\s+(all|our)\s+(openings|positions|jobs)/i,
    /^\s*create\s+impact/i,
    /^\s*disrupt\s+the/i,
    /^\s*opportunity\s+to\s+impact/i,
  ];
  if (junkPatterns.some(p => p.test(cleanDesc))) {
    return { inserted: false, reason: 'Description is junk (nav text / slogan)' };
  }

  const finalExternalId = buildExternalId(sourceKey, externalId, cleanTitle, '', location);

  const seen = await pool.query(
    'SELECT id, ingested_job_id FROM scraped_jobs WHERE source_id = $1 AND external_id = $2',
    [companyCareersId, finalExternalId]
  );
  if (seen.rows.length > 0) {
    return { inserted: false, externalId: finalExternalId, jobId: seen.rows[0].ingested_job_id, reason: 'duplicate' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const jobInsert = await client.query(
      `INSERT INTO jobs (
        company_id, title, description, location, employment_type,
        salary_min, salary_max, required_skills, is_active,
        source_key, external_url
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,$10)
      RETURNING id`,
      [
        companyId,
        cleanTitle,
        cleanDesc,
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
      [companyCareersId, finalExternalId, applyUrl || null, jobId, raw ? JSON.stringify(raw) : null]
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

// Insert a job scraped from a job board. Auto-creates a placeholder company if one
// isn't found by name. Idempotent: re-ingesting the same external id is a no-op.
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
