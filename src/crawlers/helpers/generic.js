// Generic career page crawler helper.
// Tries multiple strategies in order: JSON-LD auto-detect → cheerio selectors → metadata.

import * as cheerio from 'cheerio';
import { absUrl } from '../base.js';

/**
 * Fetch a career page (static HTML) and extract job listings using
 * JSON-LD JobPosting detection, then fall back to configurable selectors.
 *
 * @param {string} url - Career listing page URL
 * @param {object} [selectors] - { card, title, location, description, applyUrl, nextPage }
 * @param {number} [maxJobs=30]
 * @returns {Promise<Array<object>>}
 */
export async function fetchGenericCareerPage(url, selectors = {}, maxJobs = 30) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-IN,en;q=0.9',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Strategy 1: JSON-LD JobPosting embedded in page
  const jsonLdJobs = extractJsonLdJobs($);
  if (jsonLdJobs.length > 0) {
    return jsonLdJobs.slice(0, maxJobs);
  }

  // Strategy 2: Use configured selectors if provided
  if (selectors.card) {
    return extractWithSelectors($, selectors, maxJobs);
  }

  // Strategy 3: Generic heuristic — scan common job card patterns
  return extractHeuristic($, maxJobs);
}

/**
 * Extract JobPosting entries from JSON-LD <script> tags.
 */
function extractJsonLdJobs($) {
  const jobs = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const node of items) {
        if (!node) continue;
        const type = node['@type'];
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
          const org = node.hiringOrganization;
          const orgName = typeof org === 'string' ? org : org?.name || '';
          jobs.push({
            externalId: node.identifier?.value || node.url || '',
            title: (node.title || '').trim(),
            location: typeof node.jobLocation === 'string'
              ? node.jobLocation
              : node.jobLocation?.address?.addressLocality || '',
            description: stripHtml(node.description || '').slice(0, 8000),
            applyUrl: node.url || '',
            employmentType: node.employmentType || 'Full-time',
            requiredSkills: Array.isArray(node.skills)
              ? node.skills.map(s => typeof s === 'string' ? s : s.name).filter(Boolean)
              : [],
          });
        }
      }
    } catch (_) { /* malformed JSON-LD */ }
  });
  return jobs;
}

/**
 * Extract jobs using configured CSS selectors.
 */
function extractWithSelectors($, selectors, maxJobs) {
  const { card, title, location, description, applyUrl, nextPage } = selectors;
  const jobs = [];

  $(card).each((i, el) => {
    if (jobs.length >= maxJobs) return false;
    const $el = $(el);
    const getText = (sel) => sel ? $el.find(sel).first().text().trim() : '';
    const getHref = (sel) => sel ? $el.find(sel).first().attr('href') || '' : '';

    if (!getText(title)) return;

    jobs.push({
      externalId: $el.attr('data-id') || $el.attr('id') || String(i),
      title: getText(title),
      location: getText(location),
      description: getText(description),
      applyUrl: absUrl(getHref(applyUrl), ''),
      employmentType: 'Full-time',
      requiredSkills: [],
    });
  });

  return jobs;
}

/**
 * Heuristic: scan for common job card patterns when no selectors configured.
 */
function extractHeuristic($, maxJobs) {
  const commonCards = [
    '.job-listing', '.job-card', '.position', '.opening', '.career-card',
    '.jobs-list li', '.job-item', '[class*="job-"]', '[class*="career-"]',
    '.posting', '.role', 'article', '.job',
  ];

  for (const sel of commonCards) {
    const cards = $(sel);
    if (cards.length > 1) {
      // Found a likely container — extract what we can
      const jobs = [];
      cards.each((i, el) => {
        if (jobs.length >= maxJobs) return false;
        const $el = $(el);
        const text = $el.text().trim();
        if (text.length < 10) return;
        const anchor = $el.find('a').first();
        const titleText = (anchor.text() || $el.find('h2, h3, h4').first().text() || text.split('\n')[0] || '').trim();
        jobs.push({
          externalId: $el.attr('data-id') || anchor?.attr('href') || String(i),
          title: titleText,
          location: '',
          description: text.slice(0, 8000),
          applyUrl: absUrl(anchor?.attr('href') || '', ''),
          employmentType: 'Full-time',
          requiredSkills: [],
        });
      });
      if (jobs.length > 1) return jobs;
    }
  }

  return [];
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
