// Playwright launcher with stealth + optional proxy + UA rotation.
// Browser libs are imported lazily so this module is safe to require even if
// Playwright isn't installed yet (cheerio-only adapters never need it).

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

export function pickUserAgent() {
  const override = process.env.CRAWLER_USER_AGENT;
  if (override) return override;
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

let stealthApplied = false;

async function getBrowserType() {
  // Try playwright-extra first for stealth, fallback to plain playwright.
  try {
    const { chromium } = await import('playwright-extra');
    if (!stealthApplied) {
      try {
        const stealthMod = await import('puppeteer-extra-plugin-stealth');
        const stealth = (stealthMod.default || stealthMod)();
        chromium.use(stealth);
        stealthApplied = true;
      } catch (_) { /* stealth optional */ }
    }
    return chromium;
  } catch (_) {
    const pw = await import('playwright');
    return pw.chromium;
  }
}

export async function launchBrowser() {
  const chromium = await getBrowserType();
  const proxyUrl = process.env.CRAWLER_PROXY_URL;
  const headless = process.env.CRAWLER_HEADLESS !== 'false';

  const launchOpts = { headless };
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      launchOpts.proxy = {
        server: `${u.protocol}//${u.host}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch (_) { /* malformed proxy url — skip */ }
  }

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent: pickUserAgent(),
    viewport: { width: 1366, height: 768 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  return { browser, context };
}
