// Shared utilities and the BlockedError signal used by all adapters.

export class BlockedError extends Error {
  constructor(message = 'Source blocked the request') {
    super(message);
    this.name = 'BlockedError';
  }
}

export function randomDelay(minMs = 2000, maxMs = 8000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse rough INR salary strings like "5-10 LPA", "₹6,00,000 - ₹12,00,000",
// "8 Lacs", "10 LPA". Returns { min, max } in INR per year, or {} if not parseable.
export function parseSalaryINR(raw) {
  if (!raw) return {};
  const text = String(raw).toLowerCase().replace(/,/g, '');
  if (text.includes('not disclosed') || text.includes('not specified')) return {};

  // Match e.g. "5-10 lpa", "5 - 10 l", "5 to 10 lpa"
  const range = text.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(lpa|lakh|lac|l|cr|crore)?/);
  if (range) {
    const unit = range[3] || 'lpa';
    const mult = unit.startsWith('cr') ? 10000000 : 100000; // crore vs lakh
    return { min: Math.round(parseFloat(range[1]) * mult), max: Math.round(parseFloat(range[2]) * mult) };
  }

  const single = text.match(/(\d+(?:\.\d+)?)\s*(lpa|lakh|lac|l|cr|crore)/);
  if (single) {
    const mult = single[2].startsWith('cr') ? 10000000 : 100000;
    const val = Math.round(parseFloat(single[1]) * mult);
    return { min: val, max: val };
  }

  return {};
}

export function normalizeLocation(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/\s+/g, ' ')
    .replace(/,?\s*india\s*$/i, '')
    .trim()
    .slice(0, 240) || null;
}

export function buildKeywordPath(query) {
  return encodeURIComponent(String(query).trim()).replace(/%20/g, '-').replace(/'/g, '');
}

export function absUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch (_) {
    return null;
  }
}

export function cleanText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/ /g, ' ')
    .trim();
}

// Convert HTML to structured plain text, preserving bullets/paragraphs/headings as newlines.
// Used by all ATS helpers so descriptions retain visual structure after tag removal.
export function htmlToStructuredText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Pulls a usable job description out of a detail-page HTML string.
// Tries (in order): JSON-LD JobPosting, og:description, meta description,
// common content selectors. Returns a string (may be empty).
export async function extractDescriptionFromHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);

  // 1) JSON-LD JobPosting (most reliable when present)
  let jsonLdDesc = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLdDesc) return;
    try {
      const raw = $(el).contents().text();
      const data = JSON.parse(raw);
      const candidates = Array.isArray(data) ? data : [data];
      for (const node of candidates) {
        if (!node || typeof node !== 'object') continue;
        const type = node['@type'];
        const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
        if (isJob && node.description) {
          jsonLdDesc = htmlToStructuredText(String(node.description));
          return;
        }
      }
    } catch (_) {
      /* ignore malformed JSON-LD */
    }
  });
  if (jsonLdDesc && jsonLdDesc.length > 80) return jsonLdDesc.slice(0, 8000);

  // 2) og:description / meta description
  const og = $('meta[property="og:description"]').attr('content');
  const meta = $('meta[name="description"]').attr('content');
  const metaDesc = cleanText(og || meta || '');

  // 3) Common job-description containers
  const SELECTORS = [
    '[class*="job-description"]',
    '[class*="JobDescription"]',
    '[class*="jobDescription"]',
    '[class*="job-desc"]',
    '[class*="job_desc"]',
    '#jobDescription',
    '#job-description',
    '.styles_JDC__dang-inner-html__h0K4t',
    '.descriptionBlk',
    '.job-details',
    '.dang-inner-html',
    'section[class*="description"]',
    'div[itemprop="description"]',
  ];
  let bodyDesc = '';
  for (const sel of SELECTORS) {
    const node = $(sel).first();
    if (node.length) {
      const t = htmlToStructuredText(node.html() || '');
      if (t.length > bodyDesc.length) bodyDesc = t;
      if (bodyDesc.length > 400) break;
    }
  }

  const best = [jsonLdDesc, bodyDesc, metaDesc]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';
  return best.slice(0, 8000);
}

// Pulls a low-res company logo URL out of a detail-page HTML string.
// Tries JSON-LD JobPosting.hiringOrganization.logo first (most accurate),
// then og:image. Returns an absolute https URL or '' if nothing found.
export async function extractLogoFromHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);

  const isHttp = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);

  let logo = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    if (logo) return;
    try {
      const data = JSON.parse($(el).contents().text());
      const candidates = Array.isArray(data) ? data : [data];
      for (const node of candidates) {
        if (!node || typeof node !== 'object') continue;
        const type = node['@type'];
        const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
        if (!isJob) continue;
        const org = node.hiringOrganization;
        if (!org) continue;
        const raw = typeof org.logo === 'string' ? org.logo : org.logo?.url;
        if (isHttp(raw)) { logo = raw; return; }
      }
    } catch (_) {
      /* ignore malformed JSON-LD */
    }
  });

  if (!logo) {
    const og = $('meta[property="og:image"]').attr('content')
      || $('meta[name="twitter:image"]').attr('content');
    if (isHttp(og)) logo = og;
  }

  return logo.slice(0, 500);
}

// Build a Google s2/favicons URL from a company name. Always returns a usable
// URL — if the guessed domain isn't real, Google serves a generic globe icon,
// which is still better than the generic Building2 fallback.
const CORPORATE_SUFFIXES = [
  '& co.', '& co', 'pvt. ltd.', 'pvt ltd', 'private limited',
  'limited', 'ltd.', 'ltd', 'inc.', 'inc', 'llp', 'llc',
  'technologies', 'technology', 'solutions', 'services',
  'group', 'corp.', 'corp', 'corporation', 'co.',
];
export function guessFaviconUrl(companyName) {
  if (!companyName) return '';
  let name = String(companyName).toLowerCase().trim();
  for (const suffix of CORPORATE_SUFFIXES) {
    if (name.endsWith(' ' + suffix)) name = name.slice(0, -suffix.length).trim();
  }
  const domain = name.replace(/[^a-z0-9]+/g, '');
  if (!domain) return '';
  return `https://www.google.com/s2/favicons?domain=${domain}.com&sz=64`;
}

// Pre-compiled regex for Indian location matching.
// Matches major Indian cities, states, and country indicators.
const INDIA_RE = /\b(?:india|bharat|IN\b|IND\b|bangalore|bengaluru|bengal|mumbai|bombay|delhi|new delhi|ncr|noida|gurgaon|gurugram|hyderabad|secunderabad|pune|pimpri|chennai|madras|kolkata|calcutta|ahmedabad|gandhinagar|chandigarh|jaipur|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|madurai|indore|lucknow|kanpur|nagpur|bhopal|patna|visakhapatnam|vizag|vadodara|baroda|surat|rajkot|bhubaneswar|guwahati|mysore|mangalore|goa|panaji|pondicherry|puducherry|dehradun|shimla|jammu|srinagar|raipur|ranchi|jamshedpur|dhanbad|karnataka|maharashtra|tamil nadu|telangana|andhra pradesh|uttar pradesh|UP\b|west bengal|gujarat|kerala|haryana|punjab|rajasthan|bihar|odisha|orissa|assam|madhya pradesh|chhattisgarh|jharkhand|uttarakhand|himachal pradesh|manipur|meghalaya|mizoram|nagaland|sikkim|tripura|arunachal)\b/i;

/**
 * Returns true if the location string likely refers to an Indian location.
 * Used by crawlers to filter out non-India jobs at source.
 */
export function isIndianLocation(locationText) {
  if (!locationText) return false; // null = unknown, don't filter out
  const s = String(locationText).replace(/\s+/g, ' ');
  return INDIA_RE.test(s);
}
