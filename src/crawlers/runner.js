// Orchestrates a single crawler run: load adapter -> fetch -> ingest -> record run.
import { Agent } from 'undici';
import pool from '../config/database.js';
import { loadAdapter } from './registry.js';
import { BlockedError, extractDescriptionFromHtml, extractLogoFromHtml, guessFaviconUrl, randomDelay } from './base.js';
import { upsertExternalJob } from '../services/jobIngestService.js';

// Some Indian job boards (TimesJobs) serve incomplete TLS chains that Node's
// strict verifier rejects with UNABLE_TO_VERIFY_LEAF_SIGNATURE. The crawler
// only reads public listing pages and never sends credentials, so a lenient
// dispatcher is acceptable here. Do NOT export this — it must not leak into
// the rest of the app.
const crawlerDispatcher = new Agent({
  connect: { rejectUnauthorized: false },
  headersTimeout: 20000,
  bodyTimeout: 30000,
});

const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
};

const MIN_DESCRIPTION_LEN = 200;
const MAX_DETAIL_FETCHES_PER_QUERY = 10;

function needsDetailFetch(item) {
  const desc = String(item.description || '').trim();
  const title = String(item.title || '').trim();
  if (!item.applyUrl) return false;
  if (desc.length >= MIN_DESCRIPTION_LEN && desc.toLowerCase() !== title.toLowerCase()) return false;
  return true;
}

async function fetchWithUA(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': process.env.CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
        ...(opts.headers || {}),
      },
      signal: controller.signal,
      dispatcher: crawlerDispatcher,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSource(source, { runId: existingRunId, triggeredBy = 'cron' } = {}) {
  // Reuse runId if provided by route, else create a new run row.
  let runId = existingRunId;
  if (!runId) {
    const created = await pool.query(
      `INSERT INTO crawler_runs (source_id, status, triggered_by) VALUES ($1, 'running', $2) RETURNING id`,
      [source.id, triggeredBy]
    );
    runId = created.rows[0].id;
  }

  let found = 0;
  let inserted = 0;
  let status = 'ok';
  let errorText = null;

  const queries = Array.isArray(source.search_queries) ? source.search_queries.filter(Boolean) : [];
  if (queries.length === 0) {
    status = 'error';
    errorText = 'No search queries configured';
  } else {
    try {
      const AdapterClass = await loadAdapter(source.key);
      const adapter = new AdapterClass();

      const needsBrowser = AdapterClass.needsBrowser === true;
      let browserCtx = null;
      if (needsBrowser) {
        try {
          const { launchBrowser } = await import('./browser.js');
          browserCtx = await launchBrowser();
        } catch (err) {
          throw new Error(`Failed to launch browser: ${err.message}. Run 'npx playwright install chromium' in server/.`);
        }
      }

      try {
        for (const query of queries) {
          if (inserted >= (source.max_per_run || 50)) break;
          const ctx = {
            fetch: fetchWithUA,
            log: (msg) => logger.info(`[crawler:${source.key}] ${msg}`),
            page: browserCtx?.context ? await browserCtx.context.newPage() : null,
            abortSignal: null,
          };
          try {
            const listings = await adapter.fetchListings(ctx, {
              query,
              location: source.location_filter || null,
              limit: Math.max(1, (source.max_per_run || 50) - inserted),
            });
            found += listings.length;

            let detailFetches = 0;
            for (const item of listings) {
              if (inserted >= (source.max_per_run || 50)) break;

              if (needsDetailFetch(item) && detailFetches < MAX_DETAIL_FETCHES_PER_QUERY) {
                detailFetches += 1;
                try {
                  const res = await fetchWithUA(item.applyUrl, { timeout: 12000 });
                  if (res.ok) {
                    const html = await res.text();
                    const richDesc = await extractDescriptionFromHtml(html);
                    if (richDesc && richDesc.length > String(item.description || '').length) {
                      item.description = richDesc;
                    }
                    const detailLogo = await extractLogoFromHtml(html);
                    if (detailLogo) item.logoUrl = detailLogo;
                  }
                  await randomDelay(800, 2200);
                } catch (detailErr) {
                  logger.warn(`[crawler:${source.key}] detail fetch failed for ${item.applyUrl}: ${detailErr.message}`);
                }
              }

              if (!item.logoUrl) item.logoUrl = guessFaviconUrl(item.companyName);

              try {
                const result = await upsertExternalJob({
                  sourceId: source.id,
                  sourceKey: source.key,
                  externalId: item.externalId,
                  title: item.title,
                  description: item.description || item.title,
                  location: item.location,
                  companyName: item.companyName,
                  logoUrl: item.logoUrl,
                  salaryMin: item.salaryMin,
                  salaryMax: item.salaryMax,
                  employmentType: item.employmentType,
                  requiredSkills: item.requiredSkills,
                  applyUrl: item.applyUrl,
                  raw: item,
                });
                if (result.inserted) inserted += 1;
              } catch (ingestErr) {
                logger.warn(`[crawler:${source.key}] ingest failed: ${ingestErr.message}`);
              }
            }
          } catch (queryErr) {
            if (queryErr instanceof BlockedError) {
              status = 'blocked';
              errorText = queryErr.message;
              break;
            }
            logger.warn(`[crawler:${source.key}] query "${query}" failed: ${queryErr.message}`);
            status = status === 'ok' ? 'partial' : status;
            errorText = errorText || queryErr.message;
          } finally {
            if (ctx.page) {
              try { await ctx.page.close(); } catch (_) { /* ignore */ }
            }
          }
        }
      } finally {
        if (browserCtx) {
          try { await browserCtx.context.close(); } catch (_) { /* ignore */ }
          try { await browserCtx.browser.close(); } catch (_) { /* ignore */ }
        }
      }
    } catch (err) {
      status = err instanceof BlockedError ? 'blocked' : 'error';
      errorText = err.message || String(err);
      logger.error(`[crawler:${source.key}] run failed: ${errorText}`);
    }
  }

  await pool.query(
    `UPDATE crawler_runs
       SET finished_at = NOW(), status = $1, found_count = $2, new_count = $3, error_text = $4
     WHERE id = $5`,
    [status, found, inserted, errorText, runId]
  );
  await pool.query(
    `UPDATE crawler_sources SET last_run_at = NOW(), last_status = $1, last_error = $2 WHERE id = $3`,
    [status, errorText, source.id]
  );

  return { runId, status, found, inserted };
}
