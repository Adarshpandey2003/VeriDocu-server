import { BlockedError, randomDelay, parseSalaryINR, normalizeLocation, absUrl, buildKeywordPath } from './base.js';

const BASE = 'https://www.naukri.com';

export default class NaukriCrawler {
  static key = 'naukri';
  static defaultCron = '0 2 * * *';
  static needsBrowser = true;

  async fetchListings(ctx, opts) {
    const { page } = ctx;
    if (!page) throw new Error('Naukri adapter requires a Playwright page');

    const slug = buildKeywordPath(opts.query);
    const locPart = opts.location ? `-in-${buildKeywordPath(opts.location)}` : '';
    const url = `${BASE}/${slug}-jobs${locPart}`;
    ctx.log(`navigating ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (err) {
      throw new Error(`Navigation failed: ${err.message}`);
    }

    const title = await page.title().catch(() => '');
    if (/captcha|access denied|attention required|cloudflare/i.test(title)) {
      throw new BlockedError(`Naukri returned challenge page: "${title}"`);
    }

    try {
      await page.waitForSelector('.srp-jobtuple-wrapper, article.jobTuple, [data-job-id]', { timeout: 18000 });
    } catch (_) {
      throw new BlockedError('Naukri listings did not load — likely blocked');
    }

    await randomDelay(2500, 5000);

    const listings = await page.evaluate((max) => {
      const cards = Array.from(document.querySelectorAll('.srp-jobtuple-wrapper, article.jobTuple, [data-job-id]')).slice(0, max);
      return cards.map((card) => {
        const titleEl = card.querySelector('a.title, .title a, a.jobTitle, h2 a');
        const companyEl = card.querySelector('.comp-name, .companyInfo a, .subTitle');
        const locEl = card.querySelector('.locWdth, .location, .loc span, .ni-job-tuple-loc');
        const salEl = card.querySelector('.sal, .salary, .ni-job-tuple-sal');
        const descEl = card.querySelector('.job-desc, .job-description');
        const tagsEls = Array.from(card.querySelectorAll('.tags li, .tag-li, .skill'));
        return {
          externalId: card.getAttribute('data-job-id') || titleEl?.getAttribute('data-job-id') || null,
          title: titleEl?.textContent?.trim() || '',
          companyName: companyEl?.textContent?.trim() || '',
          location: locEl?.textContent?.trim() || '',
          salaryRaw: salEl?.textContent?.trim() || '',
          description: descEl?.textContent?.trim() || '',
          href: titleEl?.getAttribute('href') || null,
          tags: tagsEls.map((t) => t.textContent?.trim()).filter(Boolean).slice(0, 12),
        };
      });
    }, opts.limit);

    return listings
      .filter((l) => l.title && l.companyName)
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
          applyUrl: absUrl(l.href, BASE),
          requiredSkills: l.tags,
          employmentType: 'Full-time',
        };
      });
  }
}
