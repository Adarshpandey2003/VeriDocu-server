// Taleo / Oracle HCM career page helper.
// Oracle HCM portals may have REST APIs or JSON data in the page.
import * as cheerio from 'cheerio';
import { absUrl } from '../base.js';

export async function fetchTaleoJobs(careerUrl) {
  const jobs = [];
  const res = await fetch(careerUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Win64) AppleWebKit/537.36', 'Accept': 'text/html' },
  });
  if (!res.ok) return jobs;
  const html = await res.text();
  const $ = cheerio.load(html);

  // Try JSON-LD first
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const items = Array.isArray(data) ? data : [data];
      items.forEach(item => {
        if (item['@type'] === 'JobPosting' && item.title) {
          jobs.push({
            externalId: item.identifier?.value || item.url || '',
            title: item.title.trim(),
            location: typeof item.jobLocation === 'string' ? item.jobLocation : '',
            description: (item.description || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 8000),
            applyUrl: item.url || '',
            employmentType: 'Full-time',
            requiredSkills: [],
          });
        }
      });
    } catch (_) {}
  });

  // Generic card extraction
  if (jobs.length === 0) {
    $('[class*="job"] a[href*="job"], .job-listing a, .career-card a, .position a').each((_, el) => {
      const $a = $(el);
      const href = $a.attr('href') || '';
      const text = $a.text().trim();
      if (text && href) {
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
