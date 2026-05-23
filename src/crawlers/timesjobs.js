import { BlockedError, randomDelay, parseSalaryINR, normalizeLocation } from './base.js';

// TimesJobs migrated its search page to a Next.js SPA in early 2026 — the HTML
// response is now an empty React shell, so the old cheerio-based adapter
// returned 0 listings. This adapter uses Playwright to render and parse.
const BASE = 'https://www.timesjobs.com';

export default class TimesJobsCrawler {
  static key = 'timesjobs';
  static defaultCron = '0 2 * * *';
  static needsBrowser = true;

  async fetchListings(ctx, opts) {
    const { page } = ctx;
    if (!page) throw new Error('TimesJobs adapter requires a Playwright page');

    const url = `${BASE}/job-search?searchType=personalizedSearch&from=submit&txtKeywords=${encodeURIComponent(opts.query)}&txtLocation=${encodeURIComponent(opts.location || '')}`;
    ctx.log(`navigating ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      throw new Error(`Navigation failed: ${err.message}`);
    }

    const pageTitle = await page.title().catch(() => '');
    if (/captcha|access denied|attention required/i.test(pageTitle)) {
      throw new BlockedError(`TimesJobs returned challenge page: "${pageTitle}"`);
    }

    try {
      await page.waitForSelector('.srp-card', { timeout: 20000 });
    } catch (_) {
      throw new BlockedError('TimesJobs listings did not load — likely blocked');
    }

    await randomDelay(2000, 4000);

    const listings = await page.evaluate((max) => {
      const cards = Array.from(document.querySelectorAll('.srp-card')).slice(0, max);
      return cards.map((card) => {
        const title = (card.querySelector('h2')?.textContent || '').trim();

        // Company is the first span inside the metadata div that immediately
        // follows the title; the div also contains a separator span ("|") and
        // a "Posted on:" text node.
        const metaDiv = card.querySelector('h2 + div');
        const companyName = (metaDiv?.querySelector('span')?.textContent || '').trim();

        // Overlay anchor covers the whole card and carries the canonical URL.
        const overlay = card.querySelector('a[href*="/job-detail/"]');
        const applyUrl = overlay?.getAttribute('href') || '';

        // TimesJobs encodes the id as `jobid-<base64ish>` in the URL path,
        // potentially followed by trailing query-style params concatenated
        // with `&` even though it's inside the path.
        let externalId = null;
        const m = applyUrl.match(/jobid-([^&?]+)/);
        if (m) externalId = m[1];

        const description = (card.querySelector('.rtd-content')?.textContent || '').trim();

        const skills = Array.from(card.querySelectorAll('.skill-tag'))
          .map((s) => (s.getAttribute('title') || s.textContent || '').trim())
          .filter((s) => s && !/^\+\d+\s*more$/i.test(s))
          .slice(0, 12);

        // Location/experience/salary are sibling spans each marked by a
        // <i class="...-icon"> child. Walk from the icon up to its span parent.
        const fromIcon = (iconCls) => {
          const i = card.querySelector(`i.${iconCls}`);
          return i?.parentElement?.textContent?.trim().replace(/\s+/g, ' ') || '';
        };

        const location = fromIcon('locations-icon');
        const experience = fromIcon('years-icon');

        // Salary text lives in a sibling span (`.mr-0.inline`) next to the
        // salary icon's container — the icon's parent contains only the icon.
        const salaryHostSpan = card.querySelector('i.salary-icon')?.closest('span.float-left');
        const salaryRaw = salaryHostSpan?.querySelector('span.mr-0')?.textContent?.trim() || '';

        return {
          externalId,
          title,
          companyName,
          location,
          experience,
          salaryRaw,
          description,
          skills,
          applyUrl,
        };
      });
    }, opts.limit);

    return listings
      .filter((l) => l.title && l.companyName && l.applyUrl)
      .map((l) => {
        const { min: salaryMin, max: salaryMax } = parseSalaryINR(l.salaryRaw);
        return {
          externalId: l.externalId,
          title: l.title,
          companyName: l.companyName,
          location: normalizeLocation(l.location),
          description: l.description || l.title,
          salaryMin,
          salaryMax,
          applyUrl: l.applyUrl,
          requiredSkills: l.skills,
          employmentType: 'Full-time',
        };
      });
  }
}
