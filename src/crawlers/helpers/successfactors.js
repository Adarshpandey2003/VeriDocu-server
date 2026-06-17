// SuccessFactors career page helper.
// SAP SuccessFactors portals embed job data in <script> blocks or JSON variables.
import * as cheerio from 'cheerio';
import { absUrl } from '../base.js';

export async function fetchSuccessFactorsJobs(careerUrl) {
  const res = await fetch(careerUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Win64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const $ = cheerio.load(html);
  const jobs = [];

  // SF pages embed job data in various script blocks
  $('script[type="application/json"], script[id*="job"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);
      const items = data?.jobs || data?.jobPostings || data?.postings || data?.results || data?.data || (Array.isArray(data) ? data : []);
      if (Array.isArray(items)) {
        items.forEach(item => {
          if (item.title || item.name || item.jobTitle) {
            jobs.push(normalizeJob(item, careerUrl));
          }
        });
      }
    } catch (_) {}
  });

  // Also try JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const items = Array.isArray(data) ? data : [data];
      items.forEach(item => {
        if (item['@type'] === 'JobPosting' && item.title) {
          jobs.push({
            externalId: item.identifier?.value || item.url || '',
            title: item.title.trim(),
            location: typeof item.jobLocation === 'string' ? item.jobLocation : item.jobLocation?.address?.addressLocality || '',
            description: (item.description || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 8000),
            applyUrl: item.url || '',
            employmentType: item.employmentType || 'Full-time',
            requiredSkills: [],
          });
        }
      });
    } catch (_) {}
  });

  // Fallback: scan HTML for job-title links (SAP, some SF pages)
  if (jobs.length === 0) {
    $('a[href*="/job/"], a[href*="/careers/"], [class*="job-title"] a, [class*="jobTitle"] a').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href') || '';
      const text = $a.text().trim();
      if (text && href && text.length > 3) {
        jobs.push({
          externalId: href.split('/').pop() || href,
          title: text,
          location: '',
          description: text,
          applyUrl: absUrl(href, careerUrl),
          employmentType: 'Full-time',
          requiredSkills: [],
        });
      }
    });
  }

  return jobs;
}

export function normalizeJob(raw, baseUrl) {
  return {
    externalId: raw.jobId || raw.id || raw.slug || '',
    title: (raw.title || raw.name || raw.jobTitle || '').trim(),
    location: (raw.location || raw.city || raw.locationsText || '').trim(),
    description: (raw.description || raw.jobDescription || '').trim().slice(0, 8000),
    applyUrl: absUrl(raw.url || raw.applyUrl || raw.hostedUrl || '', baseUrl),
    employmentType: raw.type || raw.employmentType || 'Full-time',
    requiredSkills: [],
  };
}
