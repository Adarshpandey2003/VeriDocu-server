// Unit test for Intel company crawler (Workday API)
import CompanyCrawler_Intel from '../Intel.js';

async function test() {
  const crawler = new CompanyCrawler_Intel();
  const ctx = {
    fetch: async (url, opts) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json',
          ...opts?.headers },
        ...opts,
      });
      return res;
    },
    log: () => {},
  };

  try {
    const jobs = await crawler.fetchListings(ctx, { maxJobs: 5 });
    console.log(`Found ${jobs.length} jobs`);
    if (jobs.length === 0) throw new Error('No jobs returned');
    const j = jobs[0];
    console.log(`  - ${j.title} | ${j.location} | ${j.applyUrl}`);
    if (!j.title) throw new Error('Missing title');
    if (!j.externalId) throw new Error('Missing externalId');
    if (!j.applyUrl) throw new Error('Missing applyUrl');
    if (j.companyName !== 'Intel') throw new Error(`Wrong company name: ${j.companyName}`);
    console.log('PASSED');
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
}
test();
