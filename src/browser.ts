/**
 * Persistent browser pool — Chromium only.
 *
 * Firefox was used temporarily for login but is no longer needed since we
 * use LINKEDIN_SESSION_COOKIE directly. Running both browsers simultaneously
 * would OOM-kill the container on Railway's 512MB instances.
 */

import { webkit } from "playwright";
import type { Browser, BrowserContext, Cookie } from "playwright";

// WebKit (Safari engine) — LinkedIn's 999 bot detection is heavily Chrome-focused.
// WebKit has a genuinely different TLS fingerprint and browser API surface that
// LinkedIn's detectors don't flag as aggressively.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";

let _browser: Browser | null = null;
let _sessionCookies: Cookie[] = [];

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await webkit.launch({ headless: true });
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

// Login is now bypassed entirely — LINKEDIN_SESSION_COOKIE is used instead.
// Kept here in case fallback login is ever needed.
export async function loginLinkedIn(email: string, password: string): Promise<void> {
  const browser = await webkit.launch({ headless: true });
  const ctx  = await browser.newContext(makeContextOptions());
  const page = await ctx.newPage();

  try {
    console.log("[scraper] loading LinkedIn login page...");
    await page.goto("https://www.linkedin.com/login", {
      waitUntil: "domcontentloaded",
      timeout:   30_000,
    });
    console.log(`[scraper] landed on: ${page.url()}`);

    await page.waitForSelector('input[name="loginCsrfParam"]', {
      state: "attached", timeout: 20_000,
    }).catch(() => { console.warn("[scraper] loginCsrfParam not found — proceeding anyway"); });

    await page.waitForTimeout(2000);

    const result = await page.evaluate(
      ([e, p]: [string, string]) => {
        const emailField = document.querySelector(
          'input[name="session_key"], #username, input[type="email"]'
        ) as HTMLInputElement | null;
        const passField = document.querySelector(
          'input[name="session_password"], #password, input[type="password"]'
        ) as HTMLInputElement | null;
        const form = (emailField?.closest("form") ?? document.querySelector("form")) as HTMLFormElement | null;

        if (!emailField) return { ok: false, reason: "email field not found" };
        if (!passField)  return { ok: false, reason: "password field not found" };
        if (!form)       return { ok: false, reason: "form element not found" };

        const nativeSet = (el: HTMLInputElement, val: string) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) { setter.call(el, val); el.dispatchEvent(new Event("input", { bubbles: true })); }
          else { el.value = val; }
        };
        nativeSet(emailField, e);
        nativeSet(passField, p);
        form.submit();
        return { ok: true, reason: "form.submit() called" };
      },
      [email, password] as [string, string]
    );

    console.log(`[scraper] form submit result: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error(`Login form error: ${result.reason}`);

    await page.waitForURL(
      /linkedin\.com\/(feed|mynetwork|jobs|messaging|home)/,
      { timeout: 30_000 }
    ).catch(() => {});

    const finalUrl = page.url();
    console.log(`[scraper] post-login URL: ${finalUrl}`);

    if (finalUrl.includes("/checkpoint") || finalUrl.includes("/challenge")) {
      throw new Error(`LinkedIn requires verification — set LINKEDIN_SESSION_COOKIE instead. URL: ${finalUrl}`);
    }
    if (finalUrl.includes("/authwall") || finalUrl.includes("/login")) {
      throw new Error(`LinkedIn login failed — check credentials or set LINKEDIN_SESSION_COOKIE. URL: ${finalUrl}`);
    }

    _sessionCookies = await ctx.cookies();
    console.log(`[scraper] login successful — ${_sessionCookies.length} cookies saved`);
  } finally {
    await ctx.close();
  }
}

export function setSessionCookies(cookies: Cookie[]): void {
  _sessionCookies = cookies;
  console.log(`[scraper] ${cookies.length} session cookies loaded`);
}

export async function newContext(): Promise<BrowserContext> {
  const browser = await getBrowser();
  const ctx = await browser.newContext(makeContextOptions());
  if (_sessionCookies.length > 0) await ctx.addCookies(_sessionCookies);
  return ctx;
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close();
  _browser = null;
}
