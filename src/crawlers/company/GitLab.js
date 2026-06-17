// GitLab career page crawler — uses the Greenhouse public API.
// Career URL: https://boards.greenhouse.io/gitlab
import { fetchGreenhouseJobs, normalizeJob } from '../helpers/greenhouse.js';

export default class CompanyCrawler_GitLab {
  static key = 'company_gitlab';
  static companyName = 'GitLab';
  static careerUrl = 'https://boards.greenhouse.io/gitlab';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const maxJobs = opts.maxJobs || 30;
    const raw = await fetchGreenhouseJobs('gitlab');
    const jobs = raw.map(normalizeJob);

    // Attach company name from the static property
    const out = jobs.slice(0, maxJobs).map(j => ({
      ...j,
      companyName: 'GitLab',
    }));

    ctx.log(`found ${out.length} jobs (${raw.length} total from API)`);
    return out;
  }
}
