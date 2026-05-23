import * as cheerio from 'cheerio';
import { BlockedError, randomDelay, parseSalaryINR, normalizeLocation, absUrl, buildKeywordPath } from './base.js';

const BASE = 'https://www.shine.com';

// Shine's Next.js build uses hashed CSS-module class names that drift on every
// deploy. We anchor on the schema.org microdata (`itemprop=...`) baked into the
// markup, which is stable, and fall back to class fragments for everything not
// covered by microdata.
const SELECTORS = {
  card: '.jobCardNova_bigCard__W2xn3, [itemtype$="/ListItem"]',
  titleHeading: 'h3[itemprop="name"]',
  titleAnchor: 'h3[itemprop="name"] a',
  urlMeta: 'meta[itemprop="url"]',
  // Company name lives in a sibling span; class fragment matches the current and
  // any future hash-suffixed variant of the same module key.
  company: '[class*="bigCardTopTitleName"]',
  logoMeta: 'meta[itemprop="image"]',
  logoImg: '[class*="bigCardTopCompanyCircle"] img',
  experience: '[class*="bigCardExperience"]',
  location: '[class*="bigCardLocation"] span:first-of-type',
  skills: '[class*="skillsLists"] li',
};

function jobIdFromUrl(url) {
  if (!url) return null;
  const parts = String(url).split('?')[0].split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

export default class ShineCrawler {
  static key = 'shine';
  static defaultCron = '0 3 * * *';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const { query, limit } = opts;
    const slug = buildKeywordPath(query);
    const url = `${BASE}/job-search/${slug}-jobs`;
    ctx.log(`fetching ${url}`);

    const res = await ctx.fetch(url, { timeout: 20000 });
    if (res.status === 403 || res.status === 429) {
      throw new BlockedError(`HTTP ${res.status} from Shine`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from Shine`);
    const html = await res.text();
    await randomDelay(1500, 4000);

    const $ = cheerio.load(html);
    const out = [];
    $(SELECTORS.card).each((_, el) => {
      if (out.length >= limit) return false;
      const $card = $(el);

      // Title: prefer the anchor inside the schema heading, fall back to the
      // heading's `title` attribute or text. Shine occasionally drops the
      // anchor when the listing is a sponsored placeholder.
      const $titleAnchor = $card.find(SELECTORS.titleAnchor).first();
      const $titleHeading = $card.find(SELECTORS.titleHeading).first();
      const title = (
        $titleAnchor.text() ||
        $titleHeading.attr('title') ||
        $titleHeading.text() ||
        ''
      ).trim();

      const applyUrl = absUrl(
        $titleAnchor.attr('href') || $card.find(SELECTORS.urlMeta).attr('content') || '',
        BASE
      );

      const companyName = ($card.find(SELECTORS.company).first().attr('title')
        || $card.find(SELECTORS.company).first().text()
        || $card.find(SELECTORS.logoImg).first().attr('alt')
        || '').trim();

      const location = normalizeLocation($card.find(SELECTORS.location).first().text());

      // Experience and salary share the same module class; rupees icon is the
      // distinguishing alt text on the sibling img.
      let salaryRaw = '';
      $card.find(SELECTORS.experience).each((__, node) => {
        const $n = $(node);
        const altText = ($n.find('img').attr('alt') || '').toLowerCase();
        if (altText.includes('salary') || altText.includes('rupee')) {
          salaryRaw = $n.find('span').last().text().trim();
        }
      });
      const { min: salaryMin, max: salaryMax } = parseSalaryINR(salaryRaw);

      const skills = $card
        .find(SELECTORS.skills)
        .toArray()
        .map((s) => $(s).text().trim().replace(/^[,\s]+|[,\s]+$/g, ''))
        .filter(Boolean)
        .slice(0, 12);

      const logoUrl =
        $card.find(SELECTORS.logoMeta).attr('content') ||
        $card.find(SELECTORS.logoImg).attr('src') ||
        '';

      const externalId = jobIdFromUrl(applyUrl);

      if (!title || !companyName) return;

      out.push({
        externalId,
        title,
        companyName,
        location,
        description: title, // listing has no rich description; runner detail-fetches
        salaryMin,
        salaryMax,
        applyUrl,
        logoUrl: logoUrl || undefined,
        requiredSkills: skills,
        employmentType: 'Full-time',
      });
    });

    ctx.log(`found ${out.length} listings for "${query}"`);
    return out;
  }
}
