/**
 * Persistent browser pool.
 *
 * A single Chromium instance is reused across requests so LinkedIn's session
 * cookies stay warm. We create a new context (isolated cookie jar) per scrape
 * request so parallel runs don't bleed session state into each other, but
 * login cookies are shared by injecting them at context-creation time.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Cookie } from "playwright";

chromium.use(StealthPlugin());

// Playwright 1.59.1 ships with Chromium 136 — user agent MUST match or
// LinkedIn detects the version mismatch as a bot signal.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

let _browser: Browser | null = null;
let _sessionCookies: Cookie[] = [];

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;

  _browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
  });

  _browser.on("disconnected", () => { _browser = null; });
  return _browser;
}

function makeContextOptions() {
  return {
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: "en-NZ",
    timezoneId: "Pacific/Auckland",
    extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
  };
}

/** Dismiss any GDPR/cookie consent banner LinkedIn shows before the login form. */
async function dismissConsentBanner(page: import("playwright").Page): Promise<void> {
  // LinkedIn shows various consent dialogs — try common selectors, fail silently.
  const selectors = [
    'button[action-type="ACCEPT"]',
    'button[data-tracking-control-name="ga-cookie-banner-accept"]',
    'button:has-text("Accept cookies")',
    'button:has-text("Accept all")',
    'button:has-text("Allow")',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      console.log(`[scraper] dismissed consent banner: ${sel}`);
      await page.waitForTimeout(500);
      return;
    }
  }
}

// Called once at startup to log into LinkedIn and persist session cookies.
export async function loginLinkedIn(email: string, password: string): Promise<void> {
  const browser = await getBrowser();
  const ctx = await browser.newContext(makeContextOptions());
  const page = await ctx.newPage();

  try {
    // Hit the homepage first to get any initial cookies (helps consent flows).
    console.log("[scraper] warming LinkedIn homepage...");
    await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    await dismissConsentBanner(page);

    console.log("[scraper] navigating to login page...");
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded", timeout: 20_000 });
    console.log(`[scraper] login page: ${page.url()}`);

    await dismissConsentBanner(page);

    // Wait for the username field — gives React time to mount the form.
    await page.waitForSelector("#username", { timeout: 20_000 });

    // Human-paced typing so it doesn't look like an instant programmatic fill.
    await page.click("#username");
    await page.type("#username", email, { delay: 60 + Math.random() * 80 });
    await page.waitForTimeout(300 + Math.random() * 400);
    await page.click("#password");
    await page.type("#password", password, { delay: 50 + Math.random() * 70 });
    await page.waitForTimeout(400 + Math.random() * 300);

    await page.click('[type="submit"]');

    // Wait for redirect to feed — up to 30s.
    await page.waitForURL(/linkedin\.com\/(feed|mynetwork|jobs|messaging)/, { timeout: 30_000 }).catch(() => {});

    const finalUrl = page.url();
    console.log(`[scraper] post-login URL: ${finalUrl}`);

    if (finalUrl.includes("/checkpoint") || finalUrl.includes("/challenge")) {
      throw new Error(`LinkedIn requires verification — landed on: ${finalUrl}. Log in manually once, then export LINKEDIN_COOKIES.`);
    }
    if (finalUrl.includes("/authwall") || finalUrl.includes("/login")) {
      throw new Error(`LinkedIn login failed — still on login/authwall: ${finalUrl}. Check credentials in Railway Variables.`);
    }
    if (!finalUrl.match(/\/(feed|mynetwork|jobs|messaging)/)) {
      throw new Error(`LinkedIn login uncertain — landed on: ${finalUrl}. May still work; will try scraping.`);
    }

    _sessionCookies = await ctx.cookies();
    console.log(`[scraper] login successful — ${_sessionCookies.length} cookies saved`);
  } finally {
    await ctx.close();
  }
}

// Inject previously-serialised cookies (e.g. from LINKEDIN_COOKIES env var).
export function setSessionCookies(cookies: Cookie[]): void {
  _sessionCookies = cookies;
  console.log(`[scraper] ${cookies.length} session cookies loaded`);
}

// Create a fresh isolated context with the shared session cookies injected.
export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx = await browser.newContext(makeContextOptions());
  if (_sessionCookies.length > 0) {
    await ctx.addCookies(_sessionCookies);
  }
  return ctx;
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close();
  _browser = null;
}
