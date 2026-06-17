// Adapter registry — now only holds legacy job-board references.
// Company career crawling is handled by companyRunner.js which
// dispatches based on company_careers.ats_type.

const loaders = {
  // No active job-board crawlers. All jobs are sourced from company
  // career pages via the companyRunner pipeline.
};

export async function loadAdapter(key) {
  const loader = loaders[key];
  if (!loader) throw new Error(`Unknown crawler source: ${key}. Job-board crawlers have been removed. Use company career crawling instead.`);
  const mod = await loader();
  const AdapterClass = mod.default;
  if (!AdapterClass) throw new Error(`Adapter ${key} has no default export`);
  return AdapterClass;
}

export function listAdapterKeys() {
  return Object.keys(loaders);
}
