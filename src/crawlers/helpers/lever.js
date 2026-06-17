// Lever job board REST API helper.
// Lever exposes a clean public JSON API at api.lever.co.
// No API key or auth required.

import { htmlToStructuredText } from '../base.js';

const API_BASE = 'https://api.lever.co/v0';

/**
 * Fetch all open postings for a Lever company.
 * @param {string} companySlug - e.g. 'leverageedu', 'paytm'
 * @returns {Promise<Array<{id, text, categories, hostedUrl, applyUrl, descriptionPlain}>>}
 */
export async function fetchLeverJobs(companySlug) {
  if (!companySlug) throw new Error('Lever: companySlug is required');

  const url = `${API_BASE}/postings/${encodeURIComponent(companySlug)}?mode=json`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Lever API returned ${res.status} for company "${companySlug}"`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Normalize a Lever posting into the standard crawler shape.
 */
export function normalizeJob(raw) {
  const cats = raw.categories || {};
  return {
    externalId: raw.id,
    title: (raw.text || '').trim(),
    location: cats.location || cats.team || '',
    description: htmlToStructuredText([raw.description, raw.additional].filter(Boolean).join('\n') || raw.descriptionPlain || '').slice(0, 8000),
    applyUrl: raw.hostedUrl || raw.applyUrl || '',
    employmentType: cats.commitment || 'Full-time',
    requiredSkills: [],
    raw,
  };
}
