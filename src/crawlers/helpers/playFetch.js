// Playwright-based page fetcher for custom SPA career pages.
// Used by company crawlers that can't be done with a simple REST API call.
// Tries auto-detection (JSON-LD, embedded JSON) before falling back to selectors.

import { randomDelay } from '../base.js';

/**
 * Extract job listings from a JS-rendered career page using Playwright.
 *
 * @param {import('playwright').Page} page - Playwright page object
 * @param {string} url - Career listing page URL
 * @param {object} selectors - { card, title, company, location, description, applyUrl, nextPage }
 * @param {object} [opts] - { maxJobs?: number, scrollPages?: number }
 * @returns {Promise<Array<{externalId, title, location, description, applyUrl}>>}
 */
export async function playFetch(page, url, selectors = {}, opts = {}) {
  const maxJobs = opts.maxJobs || 30;
  const scrollPages = opts.scrollPages || 3;

  // ── Collect XHR/fetch responses that look like job data ──
  const apiResponses = [];
  page.on('response', async (response) => {
    const ct = response.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const reqUrl = response.url();
    // Capture all JSON API responses — content-based extraction will filter
    if (true) {
      try {
        const json = await response.json();
        apiResponses.push({ url: reqUrl, data: json });
      } catch (_) { /* not JSON */ }
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await randomDelay(3000, 6000);

  // Scroll to trigger lazy-loaded listings
  for (let i = 0; i < scrollPages; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await randomDelay(500, 1500);
  }

  // 1) Try captured API responses first (most reliable for SPAs)
  for (const resp of apiResponses) {
    const jobs = extractJobsFromObject(resp.data, maxJobs);
    if (jobs.length > 0) return jobs;
  }

  // 2) Try auto-detection (JSON-LD, embedded JSON)
  const autoDetected = await autoDetect(page);
  if (autoDetected.length > 0) return autoDetected.slice(0, maxJobs);

  // 3) Fall back to configured selectors
  if (selectors.card) {
    return await fetchWithSelectors(page, selectors, maxJobs);
  }

  // 4) Last resort: grab all visible text links that look like job titles
  return await extractVisibleJobLinks(page, maxJobs);
}

/**
 * Auto-detect job listings from JSON-LD, embedded script blocks, or
 * common DOM patterns. Returns [] if nothing found.
 */
async function autoDetect(page) {
  try {
    // 1) JSON-LD JobPosting blocks
    const jsonLd = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      const jobs = [];
      for (const el of scripts) {
        try {
          const data = JSON.parse(el.textContent);
          const items = Array.isArray(data) ? data : [data];
          for (const node of items) {
            if (!node) continue;
            const type = node['@type'];
            if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
              const org = node.hiringOrganization;
              const orgName = typeof org === 'string' ? org : org?.name || '';
              jobs.push({
                externalId: node.identifier?.value || node.url || crypto.randomUUID(),
                title: (node.title || '').trim(),
                description: stripHtml(node.description || ''),
                location: typeof node.jobLocation === 'string'
                  ? node.jobLocation
                  : node.jobLocation?.address?.addressLocality || '',
                applyUrl: node.url || '',
                employmentType: node.employmentType || 'Full-time',
                requiredSkills: Array.isArray(node.skills)
                  ? node.skills.map(s => typeof s === 'string' ? s : s.name).filter(Boolean)
                  : [],
              });
            }
          }
        } catch (_) { /* malformed JSON-LD */ }
      }
      return jobs;
    });
    if (jsonLd.length > 0) return jsonLd;
  } catch (_) { /* page eval error */ }

  // 2) Look for a `<script id="__NEXT_DATA__">` or `window.__INITIAL_STATE__` block
  try {
    const embedded = await page.evaluate(() => {
      const jobs = [];
      // Common patterns for embedded job data
      for (const s of document.querySelectorAll('script[type="application/json"], script[id*="jobTemplate"], script[type="text/template"]')) {
        try {
          const d = JSON.parse(s.textContent);
          const arr = d?.jobs || d?.job_postings || d?.postings || d?.results || d;
          if (Array.isArray(arr)) {
            arr.slice(0, 50).forEach(j => {
              jobs.push({
                externalId: j.id || j.jobId || j.slug || '',
                title: (j.title || j.name || j.text || '').trim(),
                location: (j.location || j.city || j.locationsText || '').trim(),
                description: stripHtml(j.description || j.jobDescription || j.content || ''),
                applyUrl: j.url || j.applyUrl || j.hostedUrl || '',
                employmentType: j.employmentType || j.type || 'Full-time',
                requiredSkills: [],
              });
            });
          }
        } catch (_) { /* ignore */ }
      }
      return jobs;
    });
    if (embedded.length > 0) return embedded;
  } catch (_) { /* page eval error */ }

  return [];
}

/**
 * Fallback: use configured CSS selectors to extract job cards.
 */
async function fetchWithSelectors(page, selectors, maxJobs) {
  const { card, title, company, location, description, applyUrl, nextPage } = selectors;

  return await page.evaluate(({ card, title, company, location, description, applyUrl, maxJobs }) => {
    const cards = Array.from(document.querySelectorAll(card)).slice(0, maxJobs);
    return cards.map((el, i) => {
      const get = (sel) => {
        if (!sel) return '';
        const node = el.querySelector(sel) || document.querySelector(sel);
        return (node?.textContent || '').trim();
      };
      const href = (sel) => {
        if (!sel) return '';
        const node = el.querySelector(sel);
        return node?.getAttribute('href') || '';
      };
      return {
        externalId: el.getAttribute('data-id') || el.id || `idx-${i}`,
        title: get(title),
        location: get(location),
        description: get(description),
        applyUrl: href(applyUrl),
        employmentType: 'Full-time',
        requiredSkills: [],
      };
    });
  }, { card, title, company, location, description, applyUrl, maxJobs });
}

/**
 * Recursively search an API response object for arrays that look like job listings.
 */
function extractJobsFromObject(obj, maxJobs) {
  const results = [];

  function search(node, depth) {
    if (results.length >= maxJobs || depth > 5) return;
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      // Check if this array contains job-like objects
      if (node.length > 0 && node[0] && typeof node[0] === 'object') {
        const first = node[0];
        const hasJobFields = first.title || first.name || first.jobTitle || first.id || first.jobId || first.position;
        if (hasJobFields) {
          node.forEach(item => {
            if (results.length >= maxJobs) return;
            if (!item || typeof item !== 'object') return;
            const locRaw = item.location || item.locationsText || item.office || item.city || item.region || item.country || item.address || '';
            const locStr = typeof locRaw === 'string' ? locRaw : (locRaw?.name || locRaw?.city || locRaw?.fullLocation || locRaw?.address || JSON.stringify(locRaw).slice(0, 100));

            // Try multiple description field names — many APIs differ
            const descFields = [
              'description','jobDescription','job_description','content','summary',
              'body','text','richDescription','descriptionHtml','html','details.description',
              'attributes.description','data.description','detailedDescription','job_summary',
              'descriptionPlain','additionals.description','longDescription','jobdesc',
              'jobDetail','detail','fullDescription','overview','job_summary_html',
            ];
            let descStr = '';
            for (const f of descFields) {
              // handle dotted paths like 'details.description'
              let val = item;
              const parts = f.split('.');
              for (const p of parts) {
                val = val?.[p];
                if (!val) break;
              }
              if (!val) continue;
              if (typeof val === 'string') { descStr = val; break; }
              if (val?.text) { descStr = val.text; break; }
              if (val?.html) { descStr = stripHtml(val.html); break; }
              if (val?.plain) { descStr = val.plain; break; }
              if (typeof val === 'object') { descStr = JSON.stringify(val).slice(0, 8000); break; }
            }
            // If we didn't find anything, also try searching deeper
            if (!descStr) {
              for (const key of Object.keys(item)) {
                if (/desc/i.test(key) && typeof item[key] === 'string') { descStr = item[key]; break; }
              }
            }

            // Title: try more fields
            const titleStr = String(item.title || item.name || item.jobTitle || item.position || item.designation || item.headline || '').trim();

            const applyRaw = item.url || item.applyUrl || item.hostedUrl || item.link || item.shareUrl || item.canonicalUrl || item.redirectUrl || '';
            const applyStr = typeof applyRaw === 'string' ? applyRaw : (applyRaw?.url || applyRaw?.href || '');
            results.push({
              externalId: item.id || item.jobId || item.slug || item.reqId || item.reference || item.refId || '',
              title: titleStr,
              location: String(locStr).trim(),
              description: stripHtml(String(descStr)).slice(0, 8000),
              applyUrl: String(applyStr),
              employmentType: item.type || item.employmentType || item.schedule || 'Full-time',
              requiredSkills: [],
            });
          });
          return;
        }
      }
    }

    // Recurse into object values
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const v of values) {
      if (results.length >= maxJobs) break;
      search(v, depth + 1);
    }
  }

  search(obj, 0);
  return results;
}

/**
 * Last resort: scan the rendered page for anchor elements that look like job links.
 */
async function extractVisibleJobLinks(page, maxJobs) {
  try {
    return await page.evaluate((max) => {
      const jobs = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href]');
      for (const a of links) {
        if (jobs.length >= max) break;
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').trim();
        const urlLower = href.toLowerCase();
        if (text.length < 5 || text.length > 200) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        // Match job-related links
        if (/\/job[s]?\//.test(urlLower) || /\/career[s]?\//.test(urlLower) ||
            /\b(job|position|opening|role|vacancy)\b/i.test(text.slice(0, 60))) {
          jobs.push({
            externalId: href,
            title: text.slice(0, 250),
            location: '',
            description: text.slice(0, 8000),
            applyUrl: href.startsWith('http') ? href : (window.location.origin + (href.startsWith('/') ? '' : '/') + href),
            employmentType: 'Full-time',
            requiredSkills: [],
          });
        }
      }
      return jobs;
    }, maxJobs);
  } catch (_) {
    return [];
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}
