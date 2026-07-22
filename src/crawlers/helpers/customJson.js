// Generic config-driven JSON careers helper.
// Many company career SPAs load jobs from a bespoke JSON endpoint. Rather than a
// helper per company, this one is configured per source via company_careers.selectors:
//
//   {
//     "apiUrl":   "https://example.com/api/jobs",   // required
//     "method":   "GET",                             // optional, default GET
//     "headers":  { ... },                           // optional
//     "body":     { ... },                           // optional (POST payload)
//     "arrayPath":"data.jobs",                       // where the array lives ("" = root)
//     "fields": {                                    // dotted paths into each job object
//       "externalId":    "JobId",
//       "title":         "JobTitle",
//       "description":   "JobDescription",           // HTML ok — converted to structured text
//       "location":      "jobLocations[].name",      // "[]" maps over an array, joins names
//       "applyUrl":      "careerPortalUrl",
//       "employmentType":"Department",
//       "skills":        "skillNames"
//     }
//   }

import { htmlToStructuredText } from '../base.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Resolve a dotted path, supporting a single "[]" array-map segment.
// e.g. "jobLocations[].name" → array of names; "data.Jobs" → nested array.
function resolve(obj, path) {
  if (obj == null || !path) return undefined;
  if (path.includes('[]')) {
    const [preRaw, postRaw] = path.split('[]');
    let arr = resolve(obj, preRaw.replace(/\.$/, ''));
    // Some APIs return a stringified JSON array (e.g. "[{\"Address\":\"…\"}]").
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { return undefined; } }
    if (!Array.isArray(arr)) return undefined;
    const sub = postRaw.replace(/^\./, '');
    return arr.map((el) => (sub ? resolve(el, sub) : el)).filter((v) => v != null && v !== '');
  }
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Fetch the raw job array from a configured JSON endpoint.
 * @param {object} config - the company_careers.selectors object
 */
export async function fetchCustomJson(config) {
  if (!config || !config.apiUrl) throw new Error('custom-json: selectors.apiUrl is required');
  const { apiUrl, method = 'GET', headers = {}, body } = config;
  const res = await fetch(apiUrl, {
    method,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`custom-json ${apiUrl} returned ${res.status}`);
  const data = await res.json();
  const arr = config.arrayPath ? resolve(data, config.arrayPath) : data;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Normalize one raw job object into the standard crawler shape using the field map.
 * @param {object} raw
 * @param {object} config - selectors object (uses config.fields)
 * @param {string} careerUrl - fallback apply URL (the source's career_page_url)
 */
export function normalizeJob(raw, config, careerUrl) {
  const f = (config && config.fields) || {};
  const val = (key) => (f[key] ? resolve(raw, f[key]) : undefined);

  let loc = val('location');
  if (Array.isArray(loc)) loc = [...new Set(loc.map(String).filter(Boolean))].join(', ');

  const applyUrl = String(val('applyUrl') || careerUrl || '');

  let externalId = val('externalId');
  if ((externalId == null || externalId === '') && applyUrl) {
    externalId = applyUrl.split('/').filter(Boolean).pop();
  }

  const title = String(val('title') || '').trim();
  const skills = val('skills');

  return {
    externalId: externalId ? String(externalId) : (applyUrl || title),
    title,
    location: String(loc || '').trim(),
    description: htmlToStructuredText(val('description') || '').slice(0, 8000) || title,
    applyUrl,
    employmentType: String(val('employmentType') || 'Full-time'),
    requiredSkills: Array.isArray(skills) ? skills.map(String).filter(Boolean) : (skills ? [String(skills)] : []),
    raw,
  };
}
