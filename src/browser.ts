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

let _proxyList: Array<{ server: string; username?: string; password?: string }> = [];
let _proxyIndex = 0;

// Fetch proxy list from Webshare download URL.
// Format returned: "ip:port:user:pass" per line.
export async function loadProxies(): Promise<void> {
  const listUrl = process.env.PROXY_LIST_URL?.trim();
  const singleUrl = process.env.PROXY_URL?.trim();

  if (listUrl) {
    try {
      const res = await fetch(listUrl, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const baseCreds = singleUrl ? (() => { try { return new URL(singleUrl); } catch { return null; } })() : null;
      console.log(`[scraper] proxy list raw sample: ${lines.slice(0, 2).join(" | ")}`);
      _proxyList = lines.map(line => {
        // Format 1: full URL  http://user:pass@ip:port
        if (line.startsWith("http://") || line.startsWith("https://")) {
          try {
            const u = new URL(line);
            return { server: `http://${u.host}`, username: u.username || undefined, password: u.password || undefined };
          } catch { return null; }
        }
        // Format 2: ip:port:user:pass
        const parts = line.split(":");
        if (parts.length === 4) {
          return { server: `http://${parts[0]}:${parts[1]}`, username: parts[2], password: parts[3] };
        }
        // Format 3: user:pass@ip:port
        if (line.includes("@")) {
          const [auth, host] = line.split("@");
          const [username, password] = auth.split(":");
          return { server: `http://${host}`, username, password };
        }
        // Format 4: ip:port only — use creds from PROXY_URL
        if (parts.length === 2) {
          return { server: `http://${line}`, username: baseCreds?.username, password: baseCreds?.password };
        }
        return null;
      }).filter((p): p is NonNullable<typeof p> => p !== null);
      console.log(`[scraper] ${_proxyList.length} proxies loaded from PROXY_LIST_URL`);
    } catch (err) {
      console.error("[scraper] failed to fetch proxy list:", err instanceof Error ? err.message : err);
    }
  } else if (singleUrl) {
    try {
      const parsed = new URL(singleUrl);
      _proxyList = [{ server: `${parsed.protocol}//${parsed.host}`, username: parsed.username || undefined, password: parsed.password || undefined }];
      console.log(`[scraper] 1 proxy loaded from PROXY_URL`);
    } catch {
      console.warn("[scraper] invalid PROXY_URL");
    }
  } else {
    console.log("[scraper] no proxy configured — direct connection");
  }
}

function nextProxy() {
  if (_proxyList.length === 0) return undefined;
  const proxy = _proxyList[_proxyIndex % _proxyList.length];
  _proxyIndex++;
  return proxy;
}

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  // Restart browser with next proxy so each scrape job gets a different IP
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
  const proxy = nextProxy();
  if (proxy) console.log(`[scraper] using proxy: ${proxy.server}`);
  const ctx = await browser.newContext({ ...makeContextOptions(), proxy });
  if (_sessionCookies.length > 0) await ctx.addCookies(_sessionCookies);
  return ctx;
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close();
  _browser = null;
}
