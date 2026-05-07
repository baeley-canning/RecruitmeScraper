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

// Called once at startup (or on-demand) to log into LinkedIn and persist
// the session cookies so every subsequent context starts logged in.
export async function loginLinkedIn(email: string, password: string): Promise<void> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-NZ",
  });
  const page = await ctx.newPage();

  try {
    await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
    await page.fill("#username", email);
    await page.fill("#password", password);
    await page.click('[type="submit"]');
    // Wait for the feed to confirm login, up to 15s
    await page.waitForURL(/linkedin\.com\/feed/, { timeout: 15_000 }).catch(() => {});
    if (!page.url().includes("/feed")) {
      // Check for checkpoint (email verification, CAPTCHA, etc.)
      const url = page.url();
      throw new Error(`LinkedIn login did not reach feed — landed on ${url}. Manual verification may be required.`);
    }
    _sessionCookies = await ctx.cookies();
    console.log("[scraper] LinkedIn login successful, session cookies saved");
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
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-NZ",
    // Slightly randomise timezone so every context doesn't look identical
    timezoneId: "Pacific/Auckland",
    extraHTTPHeaders: {
      "Accept-Language": "en-NZ,en;q=0.9",
    },
  });

  if (_sessionCookies.length > 0) {
    await ctx.addCookies(_sessionCookies);
  }

  return ctx;
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close();
  _browser = null;
}
