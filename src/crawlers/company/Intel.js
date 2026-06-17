// Intel career page crawler — uses the Workday public API.
// Career URL: https://jobs.intel.com (redirects to intel.wd1.myworkdayjobs.com)
import { fetchWorkdayJobs, normalizeJob } from '../helpers/workday.js';

export default class CompanyCrawler_Intel {
  static key = 'company_intel';
  static companyName = 'Intel';
  static careerUrl = 'https://jobs.intel.com';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const maxJobs = opts.maxJobs || 30;
    const raw = await fetchWorkdayJobs('intel', 'intel.wd1.myworkdayjobs.com', maxJobs);
    const baseUrl = 'intel.wd1.myworkdayjobs.com';
    const jobs = raw.map(j => ({ ...normalizeJob(j, baseUrl), companyName: 'Intel' }));
    const out = jobs.slice(0, maxJobs);
    ctx.log(`found ${out.length} jobs from Workday API`);
    return out;
  }
}
