// Micron career page crawler — uses Workday public API.
// Career URL: https://careers.micron.com/careers
// Workday domain confirmed: micron.wd1.myworkdayjobs.com
import { fetchWorkdayJobs, normalizeJob } from '../helpers/workday.js';

export default class CompanyCrawler_Micron {
  static key = 'company_micron';
  static companyName = 'Micron';
  static careerUrl = 'https://careers.micron.com/careers';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const maxJobs = opts.maxJobs || 30;
    const raw = await fetchWorkdayJobs('micron', 'micron.wd1.myworkdayjobs.com', maxJobs);
    const jobs = raw.map(j => ({ ...normalizeJob(j, 'micron.wd1.myworkdayjobs.com'), companyName: 'Micron' }));
    ctx.log(`found ${jobs.length} jobs from Workday API`);
    return jobs.slice(0, maxJobs);
  }
}
