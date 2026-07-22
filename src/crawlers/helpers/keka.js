// Keka careers helper.
// Keka hosts each company's careers at https://<subdomain>.keka.com/careers/
// and exposes a public embed-jobs JSON API. The per-tenant UUID needed for the
// API is embedded in the careers page HTML, so we fetch that first, then the API.
// No auth, no browser required.

import { htmlToStructuredText, isIndianLocation } from '../base.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Fetch all active job postings for a Keka careers tenant.
 * @param {string} subdomain - the company's Keka subdomain, e.g. 'inc42', 'adda247'
 * @returns {Promise<Array<object>>} raw Keka job objects
 */
export async function fetchKekaJobs(subdomain) {
  if (!subdomain) throw new Error('Keka: subdomain (board_key) is required');
  const base = `https://${subdomain}.keka.com`;

  // 1) Pull the careers page and extract the tenant UUID.
  const pageRes = await fetch(`${base}/careers/`, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
  if (!pageRes.ok) throw new Error(`Keka careers page returned ${pageRes.status} for "${subdomain}"`);
  const html = await pageRes.text();
  const uuid = (html.match(UUID_RE) || [])[0];
  if (!uuid) throw new Error(`Keka: could not find tenant UUID for "${subdomain}"`);

  // 2) Fetch the embed-jobs API for that tenant.
  const apiRes = await fetch(`${base}/careers/api/embedjobs/default/active/${uuid}`, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (!apiRes.ok) throw new Error(`Keka jobs API returned ${apiRes.status} for "${subdomain}"`);
  const data = await apiRes.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Normalize a Keka job into the standard crawler shape.
 * @param {object} raw - a Keka job object
 * @param {string} subdomain - the tenant subdomain (for building the apply URL)
 */
export function normalizeJob(raw, subdomain) {
  const locs = Array.isArray(raw.jobLocations) ? raw.jobLocations : [];
  const location = locs
    .map((l) => l.city || l.name)
    .filter(Boolean)
    .join(', ');
  const skills = Array.isArray(raw.skillNames) ? raw.skillNames.filter(Boolean) : [];

  return {
    externalId: String(raw.id),
    title: (raw.title || '').trim(),
    location,
    description: htmlToStructuredText(raw.description || '').slice(0, 8000) || (raw.title || '').trim(),
    applyUrl: `https://${subdomain}.keka.com/careers/jobdetails/${raw.id}`,
    employmentType: raw.departmentName || 'Full-time',
    requiredSkills: skills,
    raw,
  };
}

/**
 * True if a Keka job has at least one Indian location (or no location listed).
 * Keka job objects carry an explicit countryCode per location, which is more
 * reliable than string matching.
 */
export function isIndianJob(raw) {
  const locs = Array.isArray(raw.jobLocations) ? raw.jobLocations : [];
  if (locs.length === 0) return true; // unknown location — keep, let downstream decide
  return locs.some(
    (l) => (l.countryCode || '').toUpperCase() === 'IN' || isIndianLocation(l.city || l.name || '')
  );
}
