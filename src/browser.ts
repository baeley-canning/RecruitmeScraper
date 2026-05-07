/**
 * Persistent browser pool.
 *
 * A single Chromium instance is reused across requests so LinkedIn's session
 * cookies stay warm. We create a new context (isolated cookie jar) per scrape
 * request so parallel runs don't bleed session state into each other, but
 * login cookies are shared by injecting them at context-creation time.
 */

import { chromium, firefox } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Cookie } from "playwright";

// Stealth plugin is Chromium-only — the user-agent-override evasion reads
// browser.userAgent which doesn't exist on Firefox and throws on page creation.
chromium.use(StealthPlugin());

let _chromiumBrowser: Browser | null = null;
let _firefoxBrowser:  Browser | null = null;
let _sessionCookies:  Cookie[] = [];

// Chromium — used for profile scraping after login cookies are established.
async function getChromiumBrowser(): Promise<Browser> {
  if (_chromiumBrowser && _chromiumBrowser.isConnected()) return _chromiumBrowser;
  _chromiumBrowser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--window-size=1280,900",
    ],
  });
  _chromiumBrowser.on("disconnected", () => { _chromiumBrowser = null; });
  return _chromiumBrowser;
}

// Firefox — used for the login step only.
// LinkedIn's bot detection is far less aggressive against Firefox than Chromium.
async function getFirefoxBrowser(): Promise<Browser> {
  if (_firefoxBrowser && _firefoxBrowser.isConnected()) return _firefoxBrowser;
  _firefoxBrowser = await firefox.launch({ headless: true });
  _firefoxBrowser.on("disconnected", () => { _firefoxBrowser = null; });
  return _firefoxBrowser;
}

function makeChromiumContextOptions() {
  return {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    viewport:  { width: 1280, height: 900 },
    locale:    "en-NZ",
    timezoneId: "Pacific/Auckland",
    extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
  };
}

function makeFirefoxContextOptions() {
  return {
    viewport: { width: 1280, height: 900 },
    locale:   "en-NZ",
    timezoneId: "Pacific/Auckland",
    extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
  };
}

// Called once at startup to log into LinkedIn and persist session cookies.
// Uses Firefox — LinkedIn's headless-browser detection is much weaker against
// Firefox than against Chromium.
export async function loginLinkedIn(email: string, password: string): Promise<void> {
  const browser = await getFirefoxBrowser();
  const ctx  = await browser.newContext(makeFirefoxContextOptions());
  const page = await ctx.newPage();

  try {
    console.log("[scraper] loading LinkedIn login page...");
    await page.goto("https://www.linkedin.com/login", {
      waitUntil: "domcontentloaded",
      timeout:   30_000,
    });
    console.log(`[scraper] landed on: ${page.url()}`);

    // The visible form fields (#username / #password) are rendered by JavaScript
    // and may be hidden or not yet attached when domcontentloaded fires.
    // The hidden CSRF field IS always present immediately — wait for it as a
    // reliable proxy that the page HTML is fully parsed.
    await page.waitForSelector('input[name="loginCsrfParam"]', {
      state:   "attached",
      timeout: 20_000,
    }).catch(() => {
      console.warn("[scraper] loginCsrfParam not found — proceeding anyway");
    });

    // Give JS a moment to finish rendering the visible form fields.
    await page.waitForTimeout(2000);

    // Use JavaScript directly — bypasses all Playwright actionability checks
    // (visibility, enabled, covered).  Works even if fields are CSS-hidden or
    // not yet wired to React state.
    //
    // Strategy:
    //  1. Set field values via native HTMLInputElement setter so React's
    //     synthetic event system registers the change.
    //  2. Call form.submit() which bypasses submit-event handlers and sends
    //     a native POST with all form fields including hidden ones.
    const result = await page.evaluate(
      ([e, p]: [string, string]) => {
        const emailField = document.querySelector(
          'input[name="session_key"], #username, input[type="email"]'
        ) as HTMLInputElement | null;
        const passField  = document.querySelector(
          'input[name="session_password"], #password, input[type="password"]'
        ) as HTMLInputElement | null;
        const form = (emailField?.closest("form") ?? document.querySelector("form")) as HTMLFormElement | null;

        if (!emailField) return { ok: false, reason: "email field not found" };
        if (!passField)  return { ok: false, reason: "password field not found" };
        if (!form)       return { ok: false, reason: "form element not found" };

        // Set via native prototype setter so React's internal state updates.
        const nativeSet = (el: HTMLInputElement, val: string) => {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          )?.set;
          if (setter) {
            setter.call(el, val);
            el.dispatchEvent(new Event("input",  { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            el.value = val; // fallback
          }
        };

        nativeSet(emailField, e);
        nativeSet(passField, p);

        // form.submit() sends the POST directly without firing submit-event
        // handlers — avoids LinkedIn's client-side validation JS.
        form.submit();
        return { ok: true, reason: "form.submit() called" };
      },
      [email, password] as [string, string]
    );

    console.log(`[scraper] form submit result: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error(`Login form error: ${result.reason}`);

    // Wait for LinkedIn to process the login and redirect.
    await page.waitForURL(
      /linkedin\.com\/(feed|mynetwork|jobs|messaging|home)/,
      { timeout: 30_000 }
    ).catch(() => {});

    const finalUrl = page.url();
    console.log(`[scraper] post-login URL: ${finalUrl}`);

    if (finalUrl.includes("/checkpoint") || finalUrl.includes("/challenge")) {
      throw new Error(
        `LinkedIn requires manual verification — URL: ${finalUrl}. ` +
        "Log in via a real browser once, then export LINKEDIN_COOKIES and set in Railway Variables."
      );
    }
    if (finalUrl.includes("/authwall") || finalUrl.includes("/login")) {
      throw new Error(
        `LinkedIn login failed — still on auth page: ${finalUrl}. ` +
        "Check LINKEDIN_EMAIL and LINKEDIN_PASSWORD in Railway Variables."
      );
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

// Create a fresh isolated Chromium context with the shared session cookies injected.
// Chromium is used for profile scraping since the login cookies work cross-browser.
export async function newContext(): Promise<BrowserContext> {
  const browser = await getChromiumBrowser();
  const ctx     = await browser.newContext(makeChromiumContextOptions());
  if (_sessionCookies.length > 0) await ctx.addCookies(_sessionCookies);
  return ctx;
}

export async function closeBrowser(): Promise<void> {
  await _chromiumBrowser?.close();
  _chromiumBrowser = null;
  await _firefoxBrowser?.close();
  _firefoxBrowser = null;
}
