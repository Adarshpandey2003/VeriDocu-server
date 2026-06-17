// Paytm career page crawler — uses the Lever public API.
// Career URL: https://jobs.lever.co/paytm
import { fetchLeverJobs, normalizeJob } from '../helpers/lever.js';

export default class CompanyCrawler_Paytm {
  static key = 'company_paytm';
  static companyName = 'Paytm';
  static careerUrl = 'https://jobs.lever.co/paytm';
  static needsBrowser = false;

  async fetchListings(ctx, opts) {
    const maxJobs = opts.maxJobs || 30;
    const raw = await fetchLeverJobs('paytm');
    const jobs = raw.map(normalizeJob);
    const out = jobs.slice(0, maxJobs).map(j => ({ ...j, companyName: 'Paytm' }));
    ctx.log(`found ${out.length} jobs (${raw.length} total from Lever API)`);
    return out;
  }
}
