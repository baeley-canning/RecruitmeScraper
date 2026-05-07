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

// Playwright 1.59.1 ships with Chromium 136 — user agent must match.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

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
    viewport:  { width: 1280, height: 900 },
    locale:    "en-NZ",
    timezoneId: "Pacific/Auckland",
    extraHTTPHeaders: { "Accept-Language": "en-NZ,en;q=0.9" },
  };
}

// Called once at startup to log into LinkedIn and persist session cookies.
export async function loginLinkedIn(email: string, password: string): Promise<void> {
  const browser = await getBrowser();
  const ctx  = await browser.newContext(makeContextOptions());
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

// Create a fresh isolated context with the shared session cookies injected.
export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx     = await browser.newContext(makeContextOptions());
  if (_sessionCookies.length > 0) await ctx.addCookies(_sessionCookies);
  return ctx;
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close();
  _browser = null;
}
