// Master test runner for all company crawlers.
// Dynamically discovers all CompanyCrawler_*.js files in the parent directory
// and runs each one through a standard test, printing a pass/fail summary.

import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMPANY_DIR = join(__dirname, '..');

const ctx = {
  fetch: async (url, opts) => {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html',
        ...opts?.headers,
      },
      ...opts,
    });
    return res;
  },
  log: () => {}, // suppress logs in test runner
};

async function testCrawler(name, filePath) {
  const label = name.replace(/^CompanyCrawler_/, '').replace(/\.js$/, '');
  try {
    const mod = await import(pathToFileURL(filePath).href);
    const CrawlerClass = mod.default;
    if (!CrawlerClass || !CrawlerClass.key) {
      return { label, status: 'SKIP', reason: 'No default export or key' };
    }

    const crawler = new CrawlerClass();
    const jobs = await crawler.fetchListings(ctx, { maxJobs: 5 });

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { label, status: 'FAIL', reason: 'No jobs returned', count: 0 };
    }

    const j = jobs[0];
    if (!j.title) return { label, status: 'FAIL', reason: 'Missing title', count: jobs.length };
    if (!j.externalId) return { label, status: 'FAIL', reason: 'Missing externalId', count: jobs.length };
    if (!j.applyUrl) return { label, status: 'FAIL', reason: 'Missing applyUrl', count: jobs.length };

    return { label, status: 'PASS', count: jobs.length };
  } catch (e) {
    return { label, status: 'FAIL', reason: e.message.slice(0, 120), count: 0 };
  }
}

async function main() {
  console.log('Company Crawler Test Suite');
  console.log('==========================\n');

  // Find all company crawler files: upper-case named .js files that export a class with .key
  const files = readdirSync(COMPANY_DIR).filter(f => /^[A-Z].*\.js$/.test(f) && f !== 'index.js');

  if (files.length === 0) {
    console.log('No crawler files found.');
    process.exit(0);
  }

  const results = [];
  for (const file of files) {
    const filePath = resolve(COMPANY_DIR, file);
    const result = await testCrawler(file, filePath);
    results.push(result);
    const icon = result.status === 'PASS' ? '✓' : result.status === 'SKIP' ? '○' : '✗';
    console.log(`  ${icon} ${result.label.padEnd(20)} ${result.status === 'PASS' ? `(${result.count} jobs)` : (result.reason || '')}`);
  }

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`PASS: ${pass}  FAIL: ${fail}  SKIP: ${skip}  TOTAL: ${results.length}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test runner error:', e.message);
  process.exit(1);
});
