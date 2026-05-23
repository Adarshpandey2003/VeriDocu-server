import * as cheerio from 'cheerio';
import { BlockedError, randomDelay, parseSalaryINR, normalizeLocation, absUrl, buildKeywordPath } from './base.js';

const BASE = 'https://www.freshersworld.com';

// Freshersworld attaches the job id and canonical URL directly to the card
// element as DOM attributes (`job_id="..."` / `job_display_url="..."`). That's
// far more stable than the surrounding CSS classes and we lean on it heavily.
const SELECTORS = {
  card:     '.job-container[job_id]',
  title:    '.wrap-title.seo_title, .wrap-title',
  company:  'h3.latest-jobs-title.company-name, h3.latest-jobs-title',
  location: '.job-location a, .job-location',
  exp:      '.experience',
  salary:   '.salary-block .qualifications',
  desc:     '.desc',
  logo:     '.company_logo img.company-logo, img.company-logo',
};

// `.wrap-title` contains hidden "More" / "Less" toggle spans that pollute the
// raw text. Clone the node, strip those, then read the text.
function cleanTitle($, el) {
  return $(el).clone().find('.title_more, .title_less').remove().end().text().trim();
}

export default class FreshersworldCrawler {
  static key = 'freshersworld';
  static defaultCron = '0 4 * * *';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const { query, limit } = opts;
    const slug = buildKeywordPath(query);
    const url = `${BASE}/jobs/jobsearch/${slug}`;
    ctx.log(`fetching ${url}`);

    const res = await ctx.fetch(url, { timeout: 20000 });
    if (res.status === 403 || res.status === 429) {
      throw new BlockedError(`HTTP ${res.status} from Freshersworld`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from Freshersworld`);
    const html = await res.text();
    await randomDelay(1500, 4000);

    const $ = cheerio.load(html);
    const out = [];
    $(SELECTORS.card).each((_, el) => {
      if (out.length >= limit) return false;
      const $card = $(el);

      const externalId = $card.attr('job_id') || null;
      const applyUrl = absUrl($card.attr('job_display_url') || '', BASE);

      const $titleEl = $card.find(SELECTORS.title).first();
      const title = cleanTitle($, $titleEl);

      const companyName = $card.find(SELECTORS.company).first().text().trim();
      const location = normalizeLocation($card.find(SELECTORS.location).first().text());

      // The salary block reuses the `.qualifications` class for several
      // sibling rows (salary, education, etc.). The salary row is the first
      // one inside `.salary-block`; if that misses, leave it null.
      const salaryRaw = $card.find(SELECTORS.salary).first().text();
      const { min: salaryMin, max: salaryMax } = parseSalaryINR(salaryRaw);

      const description = $card.find(SELECTORS.desc).first().text().trim().slice(0, 2000) || title;

      const logoSrc = $card.find(SELECTORS.logo).first().attr('src') || '';
      const logoUrl = logoSrc && !/static\.freshersworld\.com\/1$/.test(logoSrc) ? logoSrc : '';

      if (!title || !companyName || !externalId) return;

      out.push({
        externalId,
        title,
        companyName,
        location,
        description,
        salaryMin,
        salaryMax,
        applyUrl,
        logoUrl: logoUrl || undefined,
        employmentType: 'Full-time',
      });
    });

    ctx.log(`found ${out.length} listings for "${query}"`);
    return out;
  }
}
