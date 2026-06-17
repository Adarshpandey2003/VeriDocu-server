// Unit test for GitLab company crawler (Greenhouse API)
import CompanyCrawler_GitLab from '../GitLab.js';

async function test() {
  const crawler = new CompanyCrawler_GitLab();
  const ctx = {
    fetch: async (url, opts) => {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          ...opts?.headers,
        },
        ...opts,
      });
      return res;
    },
    log: console.log,
  };

  try {
    const jobs = await crawler.fetchListings(ctx, { maxJobs: 5 });
    console.log(`✓ Found ${jobs.length} jobs\n`);

    // Assertions
    if (jobs.length === 0) throw new Error('No jobs returned');

    for (const j of jobs.slice(0, 3)) {
      console.log(`  - ${j.title} | ${j.location} | ${j.applyUrl}`);
    }

    const j = jobs[0];
    if (!j.title) throw new Error('Missing title');
    if (!j.externalId) throw new Error('Missing externalId');
    if (!j.applyUrl) throw new Error('Missing applyUrl');
    if (j.companyName !== 'GitLab') throw new Error(`Wrong company name: ${j.companyName}`);
    if (!/^https?:\/\//.test(j.applyUrl)) throw new Error('applyUrl is not a valid URL');
    if (j.description.length < 50) throw new Error('Description too short');

    console.log('\n✓ All assertions passed');
    process.exit(0);
  } catch (e) {
    console.error('✗ FAILED:', e.message);
    process.exit(1);
  }
}

test();
