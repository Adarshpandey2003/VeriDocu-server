// iCIMS career page helper.
// iCIMS portals have a JSON search API endpoint.
import { absUrl } from '../base.js';

export async function fetchICimsJobs(careerUrl) {
  const jobs = [];
  // Try the JSON search API first
  try {
    const baseUrl = new URL(careerUrl).origin;
    const searchUrl = `${baseUrl}/jobs/search?mode=json`;
    const res = await fetch(searchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Win64) AppleWebKit/537.36',
      },
      body: JSON.stringify({ keyword: '', location: '', page: 0, pageSize: 50 }),
    });
    if (res.ok) {
      const data = await res.json();
      const items = data?.jobs || data?.results || data?.data || (Array.isArray(data) ? data : []);
      if (Array.isArray(items)) {
        items.forEach(item => {
          jobs.push({
            externalId: item.id || item.jobId || '',
            title: (item.title || item.name || '').trim(),
            location: (item.location || item.city || '').trim(),
            description: (item.description || item.title || '').trim().slice(0, 8000),
            applyUrl: item.url || item.applyUrl || absUrl(item.jobPath || '', baseUrl),
            employmentType: item.type || 'Full-time',
            requiredSkills: [],
          });
        });
      }
    }
  } catch (_) { /* fallback below */ }

  // Fallback: parse HTML for job links
  // NOTE: No HTML-link fallback. iCIMS career pages render nav/marketing links
  // ("Student Programs", "Benefits") that look like jobs but aren't. We only
  // trust the structured JSON search API above; if it returns nothing, return
  // nothing rather than scraping garbage.
  return jobs;
}

export function normalizeJob(raw) {
  return {
    externalId: raw.externalId || raw.id || '',
    title: (raw.title || '').trim(),
    location: (raw.location || '').trim(),
    description: (raw.description || raw.title || '').trim().slice(0, 8000),
    applyUrl: raw.applyUrl || raw.url || '',
    employmentType: 'Full-time',
    requiredSkills: [],
  };
}
