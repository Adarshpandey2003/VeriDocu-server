// Company crawler registry. Each company gets its own crawler file.
// This maps the crawler key (used in company_careers.source_key or
// constructed from company name) to the class that handles that company.
// Imported lazily so a broken crawler doesn't block others.

const LOADERS = {
  // ATS-based companies — Phase B (confirmed APIs working)
  company_gitlab:       () => import('./GitLab.js'),
  company_paytm:        () => import('./Paytm.js'),
  company_intel:        () => import('./Intel.js'),
  company_micron:       () => import('./Micron.js'),

  // More companies added in subsequent phases...
};

/**
 * Load a company crawler class by its registered key.
 * @param {string} key - e.g. 'company_gitlab'
 * @returns {Promise<typeof import('./GitLab.js').default>}
 */
export async function loadCompanyCrawler(key) {
  const loader = LOADERS[key];
  if (!loader) throw new Error(`Unknown company crawler: ${key}`);
  const mod = await loader();
  return mod.default;
}

/**
 * Register a new company crawler loader at runtime.
 * Useful for dynamically adding crawlers without restarting.
 */
export function registerLoader(key, loaderFn) {
  LOADERS[key] = loaderFn;
}

/**
 * Return all registered crawler keys.
 */
export function listCrawlerKeys() {
  return Object.keys(LOADERS);
}

/**
 * Build the crawler key from a company name.
 */
export function crawlerKeyFromName(companyName) {
  const slug = String(companyName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `company_${slug}`;
}
