// Idempotent seed for company career crawler sources.
// Run: node scripts/seedCompanyCareers.mjs
//
// - Upserts a companies row (crawler companies have no owning user).
// - Registers a company_careers source once per career_page_url.
// Working sources are enabled; sources that still need per-site configuration
// (Darwinbox behind Cloudflare, custom SPAs with no public API) are registered
// disabled so an admin can configure `selectors` and enable them later.

import pool from '../src/config/database.js';

const favicon = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

const SOURCES = [
  // ── Working: Keka (public embed-jobs API) ──────────────────────────────
  { name: 'SquadStack', slug: 'squadstack-ext', domain: 'squadstack.ai',
    careerUrl: 'https://www.squadstack.ai/careers', ats: 'keka', boardKey: 'squadrun', enabled: true },

  // ── Working: custom JSON APIs (config-driven customJson helper) ─────────
  { name: 'Wingify', slug: 'wingify-ext', domain: 'wingify.com',
    careerUrl: 'https://wingify.com/careers/', ats: 'custom-json', enabled: true,
    selectors: {
      apiUrl: 'https://wingify.com/wp-json/api/get-active-jobs',
      arrayPath: '',
      fields: { title: 'title', location: 'jobLocations[].name', applyUrl: 'careerPortalUrl', employmentType: 'departmentName' },
    } },
  { name: 'Leap Finance', slug: 'leapfinance-ext', domain: 'leapfinance.com',
    careerUrl: 'https://careers.leapfinance.com/', ats: 'custom-json', enabled: true,
    selectors: {
      apiUrl: 'https://careers-api-eight.vercel.app/api/jobs',
      arrayPath: 'Jobs',
      fields: { externalId: 'JobId', title: 'JobTitle', description: 'JobDescription', location: 'Location[].Address', employmentType: 'Department' },
    } },

  // ── Registered, disabled: Darwinbox (Cloudflare + obfuscated API) ───────
  { name: 'PhysicsWallah', slug: 'physicswallah-ext', domain: 'pw.live',
    careerUrl: 'https://pwhr.darwinbox.in/ms/candidatev2/a62d7a6e288992/careers/allJobs', ats: 'darwinbox', boardKey: 'a62d7a6e288992', enabled: false },
  { name: 'Orange Health', slug: 'orange-health-ext', domain: 'orangehealth.in',
    careerUrl: 'https://orangehealth.darwinbox.in/ms/candidatev2/main/careers/allJobs', ats: 'darwinbox', boardKey: 'main', enabled: false },
  { name: 'Bharti Foundation', slug: 'bharti-foundation-ext', domain: 'bhartifoundation.org',
    careerUrl: 'https://bhartifoundation.darwinbox.in/ms/candidatev2/main/careers/allJobs', ats: 'darwinbox', boardKey: 'main', enabled: false },

  // ── Registered, disabled: custom SPAs (no public API — need selectors) ──
  { name: 'Leverage Edu',   slug: 'leverage-edu-ext',   domain: 'leverageedu.com',   careerUrl: 'https://leverageedu.com/work-with-us/', ats: 'custom', enabled: false },
  { name: 'In-Country',     slug: 'in-country-ext',     domain: 'in-country.com',     careerUrl: 'https://in-country.com/jobs', ats: 'custom', enabled: false },
  { name: 'CollegeDekho',   slug: 'collegedekho-ext',   domain: 'collegedekho.com',   careerUrl: 'https://www.collegedekho.com/careers/', ats: 'custom', enabled: false },
  { name: 'Testbook',       slug: 'testbook-ext',       domain: 'testbook.com',       careerUrl: 'https://testbook.com/careers', ats: 'custom', enabled: false },
  { name: 'PlanetSpark',    slug: 'planetspark-ext',    domain: 'planetspark.in',     careerUrl: 'https://www.planetspark.in/careers', ats: 'custom', enabled: false },
  { name: 'GeeBee Education', slug: 'geebee-ext',       domain: 'geebeeworld.com',    careerUrl: 'https://www.geebeeworld.com/careers', ats: 'custom', enabled: false },
  { name: 'Lenskart',       slug: 'lenskart-ext',       domain: 'lenskart.com',       careerUrl: 'https://www.lenskart.com/careers-at-lenskart', ats: 'custom', enabled: false },
  { name: 'Urban Company',  slug: 'urban-company-ext',  domain: 'urbancompany.com',   careerUrl: 'https://careers.urbancompany.com/jobs', ats: 'custom', enabled: false },
  { name: 'Shipsy',         slug: 'shipsy-ext',         domain: 'shipsy.ai',          careerUrl: 'https://www.shipsy.ai/careers', ats: 'custom', enabled: false },
  { name: 'Unicommerce',    slug: 'unicommerce-ext',    domain: 'unicommerce.com',    careerUrl: 'https://services.unicommerce.com/aboutus/careers', ats: 'custom', enabled: false },
  { name: 'Netcore Cloud',  slug: 'netcore-ext',        domain: 'netcorecloud.com',   careerUrl: 'https://netcorecloud.com/careers/', ats: 'custom', enabled: false },
  { name: 'AdGlobal360',    slug: 'adglobal360-ext',    domain: 'adglobal360.com',    careerUrl: 'https://www.adglobal360.com/career', ats: 'custom', enabled: false },
  { name: 'Droom',          slug: 'droom-ext',          domain: 'droom.in',           careerUrl: 'https://droom.in/career', ats: 'custom', enabled: false },
  { name: 'CARS24',         slug: 'cars24-ext',         domain: 'cars24.com',         careerUrl: 'https://careers.cars24.com/', ats: 'custom', enabled: false },
  { name: 'Yocket',         slug: 'yocket-ext',         domain: 'yocket.com',         careerUrl: 'https://careers.yocket.com/jobs/Careers', ats: 'custom', enabled: false },
  // IDP uses SAP SuccessFactors — helper exists but the public entry point needs
  // per-site setup; registered disabled for now.
  { name: 'IDP Education',  slug: 'idp-ext',            domain: 'idp.com',            careerUrl: 'https://jobs.idp.com/search/', ats: 'successfactors', enabled: false },
];

async function seed() {
  let added = 0, skipped = 0;
  for (const s of SOURCES) {
    let { rows } = await pool.query('SELECT id FROM companies WHERE slug = $1', [s.slug]);
    let companyId = rows[0]?.id;
    if (!companyId) {
      const ins = await pool.query(
        `INSERT INTO companies (name, slug, logo_url, verification_status)
         VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [s.name, s.slug, favicon(s.domain)]
      );
      companyId = ins.rows[0].id;
    }

    const exists = await pool.query('SELECT 1 FROM company_careers WHERE career_page_url = $1', [s.careerUrl]);
    if (exists.rows.length) { skipped++; continue; }

    await pool.query(
      `INSERT INTO company_careers
         (company_id, career_page_url, ats_type, board_key, enabled, needs_browser, max_jobs_per_run, selectors)
       VALUES ($1, $2, $3, $4, $5, $6, 30, $7)`,
      [companyId, s.careerUrl, s.ats, s.boardKey || null, !!s.enabled, s.ats === 'darwinbox', s.selectors ? JSON.stringify(s.selectors) : null]
    );
    added++;
    console.log(`+ ${s.name} (${s.ats}${s.enabled ? ', enabled' : ', disabled'})`);
  }
  console.log(`\nDone. Added ${added}, skipped ${skipped} (already present).`);
  process.exit(0);
}

seed().catch((e) => { console.error('SEED ERROR:', e.message); process.exit(1); });
