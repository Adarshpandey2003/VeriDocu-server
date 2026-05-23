// Adapter registry. Adapters are imported lazily so missing optional deps
// (e.g. Playwright) don't crash cheerio-only sources.

const loaders = {
  timesjobs:     () => import('./timesjobs.js'),
  shine:         () => import('./shine.js'),
  freshersworld: () => import('./freshersworld.js'),
  foundit:       () => import('./foundit.js'),
  naukri:        () => import('./naukri.js'),
};

export async function loadAdapter(key) {
  const loader = loaders[key];
  if (!loader) throw new Error(`Unknown crawler source: ${key}`);
  const mod = await loader();
  const AdapterClass = mod.default;
  if (!AdapterClass) throw new Error(`Adapter ${key} has no default export`);
  return AdapterClass;
}

export function listAdapterKeys() {
  return Object.keys(loaders);
}
