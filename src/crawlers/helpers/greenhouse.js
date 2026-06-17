// Greenhouse job board REST API helper.
// Greenhouse exposes a clean public JSON API at boards-api.greenhouse.io.
// No API key or auth required.

import { htmlToStructuredText } from '../base.js';

const API_BASE = 'https://boards-api.greenhouse.io/v1';

/**
 * Fetch all open jobs for a Greenhouse board (paginated).
 * @param {string} boardKey - e.g. 'gitlab', 'stripe'
 * @param {number} [maxPages=3] - max pages to fetch (100 jobs/page)
 * @returns {Promise<Array<{id, title, location, absolute_url, content,
 *           departments, offices, metadata}>>}
 */
export async function fetchGreenhouseJobs(boardKey, maxPages = 3) {
  if (!boardKey) throw new Error('Greenhouse: boardKey is required');

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API_BASE}/boards/${encodeURIComponent(boardKey)}/jobs?content=true&page=${page}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      if (page === 1) throw new Error(`Greenhouse API returned ${res.status}`);
      break; // no more pages
    }
    const data = await res.json();
    const jobs = data.jobs || [];
    if (jobs.length === 0) break;
    all.push(...jobs);
    if (jobs.length < 100) break; // last page
  }
  return all;
}

/**
 * Normalize Greenhouse job fields into the standard crawler shape.
 */
export function normalizeJob(raw) {
  // `raw.location.name` is Greenhouse's canonical location field (e.g. "Bengaluru").
  // `offices` is a secondary categorization that some boards (e.g. Razorpay) misuse
  // for department names — so prefer location.name and only fall back to offices.
  const officeNames = Array.isArray(raw.offices) ? raw.offices.map(o => o.name).filter(Boolean) : [];
  const location = (raw.location?.name || raw.location || officeNames[0] || '').toString().trim();
  const dept = Array.isArray(raw.departments) ? raw.departments.map(d => d.name).join(', ') : '';
  const meta = Array.isArray(raw.metadata) ? raw.metadata.map(m => m.value || m.name).join(', ') : '';

  return {
    externalId: String(raw.id),
    title: (raw.title || '').trim(),
    location,
    description: htmlToStructuredText(raw.content).slice(0, 8000) || (raw.title || '').trim(),
    applyUrl: raw.absolute_url || '',
    employmentType: dept || 'Full-time',
    requiredSkills: meta ? meta.split(/[,;]\s*/).filter(Boolean) : [],
    raw,
  };
}

