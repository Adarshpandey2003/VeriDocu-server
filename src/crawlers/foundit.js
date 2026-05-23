import { BlockedError, randomDelay, parseSalaryINR, normalizeLocation } from './base.js';

const BASE = 'https://www.foundit.in';

// Build Foundit's canonical job URL: /job/<title-slug>-<jobId>. Foundit accepts
// a stale slug as long as the trailing numeric id is correct, so a regenerated
// slug from the title is safe.
function buildJobUrl(title, jobId) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'job';
  return `${BASE}/job/${slug}-${jobId}`;
}

export default class FounditCrawler {
  static key = 'foundit';
  static defaultCron = '0 2 * * *';
  static needsBrowser = true;

  async fetchListings(ctx, opts) {
    const { page } = ctx;
    if (!page) throw new Error('Foundit adapter requires a Playwright page');

    const url = `${BASE}/srp/results?query=${encodeURIComponent(opts.query)}&locations=${encodeURIComponent(opts.location || 'india')}`;
    ctx.log(`navigating ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      throw new Error(`Navigation failed: ${err.message}`);
    }

    const pageTitle = await page.title().catch(() => '');
    if (/captcha|access denied|attention required/i.test(pageTitle)) {
      throw new BlockedError(`Foundit returned challenge page: "${pageTitle}"`);
    }

    try {
      await page.waitForSelector('.srpResultCardContainer, .cardContainer', { timeout: 15000 });
    } catch (_) {
      throw new BlockedError('Foundit listings did not load — likely blocked');
    }

    await randomDelay(2000, 4000);

    const listings = await page.evaluate((max) => {
      const cards = Array.from(document.querySelectorAll('.srpResultCardContainer')).slice(0, max);
      return cards.map((card) => {
        // The inner .cardContainer carries the numeric job id as its DOM id.
        const inner = card.querySelector('.cardContainer');
        const id = inner?.id || null;

        const titleText = (card.querySelector('.jobTitle')?.textContent || '').trim();
        const companyName = (card.querySelector('.companyName p, .companyName')?.textContent || '').trim();
        const locText = (card.querySelector('.details.location')?.textContent || '').trim();
        const experience = (card.querySelector('.experienceSalary .details')?.textContent || '').trim();

        // Logo from the listing card. Most cards show a default placeholder
        // (defaultCompanyLogo.svg) — surface the URL anyway so the runner can
        // decide between this and the detail-page logo.
        const logoEl = card.querySelector('.companyLogo img');
        const logoSrc = logoEl?.getAttribute('src') || '';

        return {
          externalId: id,
          title: titleText,
          companyName,
          location: locText,
          experience,
          logoSrc,
        };
      });
    }, opts.limit);

    return listings
      .filter((l) => l.title && l.companyName && l.externalId)
      .map((l) => {
        // Foundit listing cards never carry salary — leave min/max null.
        const { min: salaryMin, max: salaryMax } = parseSalaryINR('');
        const applyUrl = buildJobUrl(l.title, l.externalId);

        // Normalise protocol-relative logo URLs; drop the generic placeholder
        // so the runner falls back to favicon guess for unbranded listings.
        let logoUrl = '';
        if (l.logoSrc && !/defaultCompanyLogo/i.test(l.logoSrc)) {
          logoUrl = l.logoSrc.startsWith('//') ? `https:${l.logoSrc}` : l.logoSrc;
        }

        return {
          externalId: l.externalId,
          title: l.title,
          companyName: l.companyName,
          location: normalizeLocation(l.location),
          description: l.title, // listing has no description; runner detail-fetches
          salaryMin,
          salaryMax,
          applyUrl,
          logoUrl,
          employmentType: 'Full-time',
        };
      });
  }
}
