// Orchestrates a single company career crawl.
// Dispatches to the right ATS helper based on company_careers.ats_type.
// No per-company files needed — configuration lives in the DB.
import pool from '../config/database.js';
import { BlockedError, isIndianLocation, randomDelay, extractDescriptionFromHtml, extractLogoFromHtml } from './base.js';
import { upsertCompanyJob } from '../services/jobIngestService.js';

const SOURCE_KEY = 'company_career';

// Detail-page enrichment thresholds
const MIN_DESCRIPTION_LEN = 200;
const MAX_DETAIL_FETCHES = 20; // cap detail page requests per company per run

function needsDetailFetch(item) {
  const desc = String(item.description || '').trim();
  const title = String(item.title || '').trim();
  if (!item.applyUrl) return false;
  if (desc.length >= MIN_DESCRIPTION_LEN && desc.toLowerCase() !== title.toLowerCase()) return false;
  return true;
}

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

// ── Browser semaphore: serialize Playwright access to avoid crashes ──
// Only one browser can be active at a time. Non-browser runs proceed freely.
let browserBusy = false;
const browserQueue = [];

function acquireBrowserLock() {
  if (!browserBusy) {
    browserBusy = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    browserQueue.push(resolve);
  });
}

function releaseBrowserLock() {
  browserBusy = false;
  const next = browserQueue.shift();
  if (next) {
    browserBusy = true;
    next();
  }
}

/**
 * Run a crawler for one company career page using the ats_type from DB.
 */
export async function runCompanyCareer(companyCareersRow, { runId: existingRunId, triggeredBy = 'cron' } = {}) {
  let runId = existingRunId;
  if (!runId) {
    const created = await pool.query(
      `INSERT INTO crawler_runs (source_id, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
      [companyCareersRow.id, triggeredBy]
    );
    runId = created.rows[0].id;
  }

  let found = 0;
  let inserted = 0;
  let status = 'ok';
  let errorText = null;
  let browserCtx = null;
  let ctx = null;

  try {
    const company = await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyCareersRow.company_id]);
    if (company.rows.length === 0) throw new Error(`Company not found: ${companyCareersRow.company_id}`);

    const companyId = company.rows[0].id;
    const companyName = company.rows[0].name;
    const atsType = companyCareersRow.ats_type || 'custom';
    const boardKey = companyCareersRow.board_key || '';
    const needsBrowser = companyCareersRow.needs_browser || atsType === 'custom';
    const maxJobs = companyCareersRow.max_jobs_per_run || 30;
    const careerUrl = companyCareersRow.career_page_url || '';

    // Launch browser if needed (custom SPAs). Serialized via semaphore so
    // concurrent runs don't crash each other's browser processes.
    if (needsBrowser) {
      await acquireBrowserLock();
      try {
        const { launchBrowser } = await import('./browser.js');
        browserCtx = await launchBrowser();
      } catch (err) {
        releaseBrowserLock();
        throw new Error(`Failed to launch browser: ${err.message}`);
      }
    }

    ctx = {
      fetch: async (url, opts) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), opts?.timeout || 15000);
        try {
          const res = await fetch(url, {
            headers: {
              'User-Agent': process.env.CRAWLER_USER_AGENT ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              'Accept': 'application/json, text/html,application/xhtml+xml',
              'Accept-Language': 'en-IN,en;q=0.9',
              ...(opts?.headers || {}),
            },
            ...opts,
            signal: controller.signal,
          });
          return res;
        } finally {
          clearTimeout(timeout);
        }
      },
      page: browserCtx?.context ? await browserCtx.context.newPage() : null,
      log: (msg) => logger.info(`[company:${companyName}] ${msg}`),
    };

    // Fetch as many jobs as possible from the API (incremental mode).
    // The maxJobs from DB controls the ingestion cap, not the fetch limit.
    const FETCH_LIMIT = 200; // safety cap on API fetch
    const rawListings = await dispatchAdapter(atsType, boardKey, careerUrl, FETCH_LIMIT, ctx, companyCareersRow);

    // Filter to India-only locations. Jobs with null/empty location are kept
    // (they might be India-located but just missing location data from the ATS).
    const allCount = rawListings.length;
    const listings = rawListings.filter((item) => {
      const loc = item.location;
      if (!loc || String(loc).trim() === '') return true; // keep unknown locations
      return isIndianLocation(loc);
    });
    const filtered = allCount - listings.length;
    if (filtered > 0) {
      ctx.log(`filtered out ${filtered}/${allCount} non-India jobs`);
    }

    // ── Enrich short descriptions by fetching detail pages ──
    // Tier 1: plain HTTP + cheerio (fast, works for server-rendered pages)
    // Tier 2: Playwright (for SPA detail pages — requires browserCtx)
    let detailFetches = 0;
    for (const item of listings) {
      if (detailFetches >= MAX_DETAIL_FETCHES) break;
      if (!needsDetailFetch(item)) continue; // already has a good description
      detailFetches++;
      let enriched = false;

      // Tier 1: plain HTTP
      try {
        const res = await ctx.fetch(item.applyUrl, { timeout: 12000 });
        if (res.ok) {
          const html = await res.text();
          const rich = await extractDescriptionFromHtml(html);
          if (rich && rich.length > String(item.description || '').length) {
            item.description = rich;
            enriched = true;
          }
          if (!item.logoUrl) {
            const logo = await extractLogoFromHtml(html);
            if (logo) item.logoUrl = logo;
          }
        }
      } catch (_) { /* fall through to tier 2 */ }

      // Tier 2: Playwright (for SPA detail pages)
      if (!enriched && browserCtx && ctx.page) {
        try {
          await ctx.page.goto(item.applyUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await randomDelay(800, 1500);
          const html = await ctx.page.content();
          const rich = await extractDescriptionFromHtml(html);
          if (rich && rich.length > String(item.description || '').length) {
            item.description = rich;
            enriched = true;
          }
        } catch (_) { /* skip */ }
      }

      if (enriched) await randomDelay(800, 2000);
    }
    if (detailFetches > 0) {
      ctx.log(`enriched ${detailFetches} job descriptions via detail pages`);
    }

    found = listings.length;
    const INGEST_CAP = 100; // max new jobs to insert per run
    for (const item of listings) {
      if (inserted >= INGEST_CAP) break;
      try {
        const result = await upsertCompanyJob({
          companyCareersId: companyCareersRow.id,
          companyId,
          sourceKey: SOURCE_KEY,
          externalId: item.externalId,
          title: String(item.title || '').trim().slice(0, 250),
          description: item.description || item.title,
          location: item.location,
          salaryMin: item.salaryMin,
          salaryMax: item.salaryMax,
          employmentType: item.employmentType || 'Full-time',
          requiredSkills: item.requiredSkills,
          applyUrl: item.applyUrl,
          raw: item,
        });
        if (result.inserted) inserted += 1;
      } catch (ingestErr) {
        logger.warn(`[company:${companyName}] ingest failed: ${ingestErr.message}`);
      }
    }
  } catch (err) {
    status = err instanceof BlockedError ? 'blocked' : 'error';
    errorText = err.message || String(err);
    logger.error(`[company] ${companyCareersRow.career_page_url} failed: ${errorText}`);
  } finally {
    if (browserCtx) {
      if (ctx?.page) try { await ctx.page.close(); } catch (_) { /* ignore */ }
      if (browserCtx.context) try { await browserCtx.context.close(); } catch (_) { /* ignore */ }
      if (browserCtx.browser) try { await browserCtx.browser.close(); } catch (_) { /* ignore */ }
      releaseBrowserLock();
    }
  }

  await pool.query(
    'UPDATE crawler_runs SET finished_at = NOW(), status = $1, found_count = $2, new_count = $3, error_text = $4 WHERE id = $5',
    [status, found, inserted, errorText, runId]
  );
  await pool.query(
    'UPDATE company_careers SET last_run_at = NOW(), last_status = $1, last_error = $2, job_count = COALESCE(job_count,0) + $3, updated_at = NOW() WHERE id = $4',
    [status, errorText, inserted, companyCareersRow.id]
  );

  return { runId, status, found, inserted };
}

/**
 * Dispatch to the correct helper based on ats_type.
 */
async function dispatchAdapter(atsType, boardKey, careerUrl, maxJobs, ctx, companyCareersRow) {
  switch (atsType) {
    case 'greenhouse': {
      const { fetchGreenhouseJobs, normalizeJob } = await import('./helpers/greenhouse.js');
      const raw = await fetchGreenhouseJobs(boardKey);
      return raw.map(normalizeJob).slice(0, maxJobs);
    }

    case 'lever': {
      const { fetchLeverJobs, normalizeJob } = await import('./helpers/lever.js');
      const raw = await fetchLeverJobs(boardKey);
      return raw.map(normalizeJob).slice(0, maxJobs);
    }

    case 'workday': {
      const { fetchWorkdayJobs, fetchWorkdayJobDetail, normalizeJob } = await import('./helpers/workday.js');
      // board_key format: "domain" (assumes External site) or "domain|site"
      const [domain, site = 'External'] = String(boardKey).split('|');
      const tenant = domain.split('.')[0];
      const raw = await fetchWorkdayJobs(tenant, domain, maxJobs, site);
      const allJobs = raw.map(j => ({ ...normalizeJob(j, domain, site) }));

      // Filter to India FIRST so we only enrich jobs we'll actually keep.
      // (Workday boards are mostly global; only a small slice is India.)
      const indiaJobs = allJobs.filter(j => !j.location || isIndianLocation(j.location));

      // Enrich the kept India jobs via the Workday detail-page extractor.
      // The generic extractDescriptionFromHtml doesn't work on Workday SPA pages,
      // so we must use fetchWorkdayJobDetail here.
      let wdEnriched = 0;
      for (const job of indiaJobs.slice(0, maxJobs)) {
        if (!job.applyUrl) continue;
        try {
          const rich = await fetchWorkdayJobDetail(job.applyUrl);
          if (rich && rich.length > String(job.description || '').length) {
            job.description = rich;
            wdEnriched++;
          }
          await new Promise(r => setTimeout(r, 350));
        } catch (_) { /* skip */ }
      }
      if (wdEnriched > 0) ctx.log(`enriched ${wdEnriched} Workday job descriptions`);

      return indiaJobs.slice(0, maxJobs);
    }

    case 'smartrecruiters': {
      const raw = await fetchSmartRecruiters(boardKey, maxJobs, ctx);
      return raw.slice(0, maxJobs);
    }

    case 'successfactors': {
      const { fetchSuccessFactorsJobs, normalizeJob } = await import('./helpers/successfactors.js');
      const raw = await fetchSuccessFactorsJobs(careerUrl);
      return raw.map(normalizeJob).slice(0, maxJobs);
    }

    case 'taleo': {
      const { fetchTaleoJobs, normalizeJob } = await import('./helpers/taleo.js');
      const raw = await fetchTaleoJobs(careerUrl);
      return raw.map(normalizeJob).slice(0, maxJobs);
    }

    case 'icims': {
      const { fetchICimsJobs, normalizeJob } = await import('./helpers/icims.js');
      const raw = await fetchICimsJobs(careerUrl);
      return raw.map(normalizeJob).slice(0, maxJobs);
    }

    case 'custom':
    default: {
      // Generic extraction (cheerio/Playwright auto-detect) cannot reliably
      // distinguish real job postings from page content — testimonials,
      // service blurbs, nav headings, "About us" text all get scraped as
      // "jobs". To guarantee quality we ONLY run generic extraction when an
      // admin has explicitly configured a `selectors` map (card/title/etc.)
      // for this company. Without curated selectors, skip — no garbage.
      const sel = companyCareersRow?.selectors || {};
      if (!sel.card) {
        ctx.log('custom source has no configured selectors — skipping (generic extraction disabled to prevent garbage)');
        return [];
      }
      const { fetchGenericCareerPage } = await import('./helpers/generic.js');
      let jobs = await fetchGenericCareerPage(careerUrl, sel, maxJobs);
      if (jobs.length === 0 && ctx.page) {
        ctx.log('cheerio returned 0, trying Playwright...');
        const { playFetch } = await import('./helpers/playFetch.js');
        jobs = await playFetch(ctx.page, careerUrl, sel, { maxJobs });
      }
      return jobs;
    }
  }
}

// SmartRecruiters inline helper — paginated, fetches full descriptions
async function fetchSmartRecruiters(companyIdentifier, maxJobs, ctx) {
  const all = [];
  const PAGE_SIZE = 100;
  let offset = 0;
  try {
    while (all.length < maxJobs) {
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await ctx.fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      const page = data.content || [];
      if (page.length === 0) break;
      all.push(...page);
      offset += PAGE_SIZE;
    }
  } catch (_) { /* stop on error */ }

  // Map listing data
  const mapped = all.map(r => ({
    externalId: r.id || r.uuid,
    title: (r.name || '').trim(),
    location: r.location?.fullLocation || [r.location?.city, r.location?.country].filter(Boolean).join(', '),
    description: r.name || '',
    detailUrl: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings/${r.id || r.uuid}`,
    applyUrl: `https://jobs.smartrecruiters.com/${companyIdentifier}/${r.id || r.uuid}`,
    employmentType: r.typeOfEmployment || 'Full-time',
    requiredSkills: [],
    raw: r,
  }));

  // Filter to India FIRST so we only enrich (and return) jobs we'll keep.
  const india = mapped.filter(j => !j.location || isIndianLocation(j.location)).slice(0, maxJobs);

  // Fetch full jobAd for the kept India jobs (up to 20).
  const DETAIL_LIMIT = 20;
  let enriched = 0;
  for (const job of india) {
    if (enriched >= DETAIL_LIMIT) break;
    try {
      const detailRes = await ctx.fetch(job.detailUrl);
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      const sections = detail?.jobAd?.sections;
      const parts = [];
      if (sections?.jobDescription?.text) parts.push(sections.jobDescription.text);
      if (sections?.jobQualifications?.text) parts.push(sections.jobQualifications.text);
      if (sections?.jobAdditionalDetails?.text) parts.push(sections.jobAdditionalDetails.text);
      if (parts.length > 0) {
        job.description = parts.join('\n\n')
          .replace(/<li[^>]*>/gi, '\n• ').replace(/<\/li>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n').replace(/<\/div>/gi, '\n')
          .replace(/<\/h[1-6]>/gi, '\n\n').replace(/<h[1-6][^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
        enriched++;
      }
      await new Promise(r => setTimeout(r, 300)); // small delay between API calls
    } catch (_) { /* skip detail fetch errors */ }
  }
  if (enriched > 0) ctx.log(`enriched ${enriched} SmartRecruiters job descriptions`);

  return india;
}
