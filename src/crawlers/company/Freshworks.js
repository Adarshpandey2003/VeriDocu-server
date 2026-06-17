// Freshworks career page crawler — uses SmartRecruiters embedded API.
// Probed: 77 job cards found, SmartRecruiters detected in HTML.
import { fetchGenericCareerPage } from '../helpers/generic.js';

export default class CompanyCrawler_Freshworks {
  static key = 'company_freshworks';
  static companyName = 'Freshworks';
  static careerUrl = 'https://www.freshworks.com/company/careers/';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const maxJobs = opts.maxJobs || 30;
    // SmartRecruiters: try their public API first
    let jobs = [];
    try {
      const apiRes = await ctx.fetch('https://api.smartrecruiters.com/v1/companies/Freshworks/postings?limit=50');
      if (apiRes.ok) {
        const data = await apiRes.json();
        jobs = (data.content || []).map(r => ({
          externalId: r.id || r.uuid,
          title: (r.name || '').trim(),
          location: r.location ? [r.location.city, r.location.country].filter(Boolean).join(', ') : '',
          description: r.name || '',
          applyUrl: `https://jobs.smartrecruiters.com/Freshworks/${r.id || r.uuid}`,
          employmentType: 'Full-time',
          requiredSkills: [],
        }));
      }
    } catch (_) { /* fallback */ }

    if (jobs.length === 0) {
      jobs = await fetchGenericCareerPage('https://www.freshworks.com/company/careers/', {}, maxJobs);
    }

    const out = jobs.slice(0, maxJobs).map(j => ({ ...j, companyName: 'Freshworks' }));
    ctx.log(`found ${out.length} jobs`);
    return out;
  }
}
