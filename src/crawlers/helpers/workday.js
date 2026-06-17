// Workday job board REST API helper.
// Workday exposes a POST-based JSON API on each tenant's subdomain.
// No auth required for the External (public) endpoint.

import { htmlToStructuredText } from '../base.js';

/**
 * Fetch jobs from a Workday tenant's public career-site endpoint.
 * @param {string} tenant - e.g. 'intel', 'micron'
 * @param {string} domain - full subdomain e.g. 'intel.wd1.myworkdayjobs.com'
 * @param {number} limit - max jobs per request (default 50)
 * @param {string} site - career site path segment (e.g. 'External',
 *   'NVIDIAExternalCareerSite', 'Ext', 'Jobs'). Each tenant differs.
 * @returns {Promise<Array<{title, bulletFields, externalPath, locationsText}>>}
 */
export async function fetchWorkdayJobs(tenant, domain, limit = 50, site = 'External') {
  if (!tenant) throw new Error('Workday: tenant is required');

  const baseDomain = domain || `${tenant}.wd1.myworkdayjobs.com`;
  const sitePath = site || 'External';
  const doFetch = globalThis.fetch;
  const PAGE_SIZE = 20; // Intel's API rejects limit > 20
  const maxPages = Math.ceil(Math.min(limit, 200) / PAGE_SIZE);

  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `https://${baseDomain}/wday/cxs/${tenant}/${sitePath}/jobs`;
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        searchText: '',
      }),
    });

    const ct = res.headers.get('content-type') || '';
    if (!res.ok) break;
    if (!ct.includes('json')) break;

    const data = await res.json();
    const jobs = data.jobPostings || data.jobs || data.data || [];
    if (jobs.length === 0) break;
    all.push(...jobs);
    if (jobs.length < PAGE_SIZE) break; // last page
    if (all.length >= limit) break;
  }

  if (all.length === 0) {
    // Fallback: try the alt URL with limit
    const altUrl = `https://${baseDomain}/api/v1/jobs?limit=${PAGE_SIZE}`;
    const altRes = await doFetch(altUrl, { headers: { 'Accept': 'application/json' } });
    if (altRes.ok) {
      const altData = await altRes.json();
      const jobs = Array.isArray(altData) ? altData : (altData.jobPostings || altData.jobs || altData.data || []);
      if (jobs.length > 0) all.push(...jobs);
    }
  }

  return all;
}

/**
 * Normalize a Workday job posting into the standard crawler shape.
 * @param {object} raw - the API job object
 * @param {string} baseUrl - tenant domain e.g. 'intel.wd1.myworkdayjobs.com'
 * @param {string} site - career-site path segment (e.g. 'External'); REQUIRED for
 *   the public detail-page URL, which is {domain}/{site}{externalPath}.
 */
export function normalizeJob(raw, baseUrl, site = 'External') {
  const base = baseUrl || 'wd1.myworkdayjobs.com';
  const path = raw.externalPath || raw.jobPath || raw.url || '';
  const bulletFields = Array.isArray(raw.bulletFields) ? raw.bulletFields.join('\n') : '';
  const desc = bulletFields || raw.jobDescription || raw.description || '';

  // Public detail page lives at https://{domain}/{site}{externalPath}
  let applyUrl;
  if (path.startsWith('http')) applyUrl = path;
  else applyUrl = `https://${base}/${site}${path}`;

  return {
    externalId: raw.id || raw.jobId || (path ? path.split('/').pop() : ''),
    title: (raw.title || raw.jobTitle || '').trim(),
    location: (raw.locationsText || raw.location || '').trim(),
    description: desc.slice(0, 8000),
    applyUrl,
    employmentType: raw.timeType || raw.employmentType || 'Full-time',
    requiredSkills: [],
    raw,
  };
}

/**
 * Fetch the full job description from a Workday detail page.
 * Workday detail pages are server-rendered HTML — no browser needed.
 */
export async function fetchWorkdayJobDetail(detailUrl) {
  if (!detailUrl) return '';
  try {
    const res = await globalThis.fetch(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Win64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return '';
    const html = await res.text();
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);

    // Workday detail page selectors
    for (const sel of [
      '[data-automation-id="jobPostingDescription"]',
      '[class*="job-description"]',
      '[class*="jobDescription"]',
      '.job-posting-section',
      'article',
    ]) {
      const text = htmlToStructuredText($(sel).first().html() || '');
      if (text.length > 80) return text.slice(0, 8000);
    }

    // JSON-LD fallback
    let best = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).contents().text());
        const items = Array.isArray(data) ? data : [data];
        for (const node of items) {
          if (node['@type'] === 'JobPosting' && node.description) {
            best = htmlToStructuredText(String(node.description)).slice(0, 8000);
          }
        }
      } catch (_) {}
    });
    return best;
  } catch (_) {
    return '';
  }
}
