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

// Webshare API response shape for /api/v2/proxy/list/
type WebshareProxy = {
  username: string;
  password: string;
  proxy_address: string;
  port: number;
  valid?: boolean;
};
type WebshareListResponse = {
  count: number;
  next: string | null;
  results: WebshareProxy[];
};

// Pull proxies from Webshare. Three sources, in priority order:
//   1. WEBSHARE_API_KEY  — official API, structured JSON, paginated, won't silently expire
//   2. PROXY_LIST_URL    — download-token URL (legacy; token can be revoked)
//   3. PROXY_URL         — single proxy
export async function loadProxies(): Promise<void> {
  const apiKey  = process.env.WEBSHARE_API_KEY?.trim();
  const listUrl = process.env.PROXY_LIST_URL?.trim();
  const singleUrl = process.env.PROXY_URL?.trim();

  if (apiKey) {
    try {
      const collected: WebshareProxy[] = [];
      let url: string | null = "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=100";
      while (url) {
        const res: Response = await fetch(url, {
          headers: { Authorization: `Token ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`[scraper] Webshare API ${res.status}: ${body.slice(0, 200)}`);
          break;
        }
        const data = (await res.json()) as WebshareListResponse;
        collected.push(...(data.results ?? []));
        url = data.next;
      }
      _proxyList = collected
        .filter(p => p.valid !== false && p.proxy_address && p.port)
        .map(p => ({
          server: `http://${p.proxy_address}:${p.port}`,
          username: p.username,
          password: p.password,
        }));
      if (_proxyList.length > 0) {
        console.log(`[scraper] first proxy: ${_proxyList[0].server} (auth: yes)`);
      }
      console.log(`[scraper] ${_proxyList.length} proxies loaded from WEBSHARE_API_KEY`);
      return;
    } catch (err) {
      console.error("[scraper] Webshare API fetch failed:", err instanceof Error ? err.message : err);
    }
  }

  if (listUrl) {
    try {
      const res = await fetch(listUrl, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const baseCreds = singleUrl ? (() => { try { return new URL(singleUrl); } catch { return null; } })() : null;
      console.log(`[scraper] proxy list raw sample: ${lines.slice(0, 2).join(" | ")}`);
      // Strict IP:port validator — anything that doesn't match is rejected.
      const HOST_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})$/;
      const buildProxy = (host: string, username?: string, password?: string) => {
        if (!HOST_RE.test(host)) return null;
        return { server: `http://${host}`, username, password };
      };

      _proxyList = lines.map(line => {
        // Format 1: http://user:pass@ip:port
        if (/^https?:\/\//i.test(line)) {
          try {
            const u = new URL(line);
            return buildProxy(u.host, u.username || undefined, u.password || undefined);
          } catch { return null; }
        }
        // Format 2: user:pass@ip:port
        if (line.includes("@")) {
          const [auth, host] = line.split("@");
          const [username, password] = auth.split(":");
          return buildProxy(host, username, password);
        }
        const parts = line.split(":");
        // Format 3: ip:port:user:pass
        if (parts.length === 4) {
          return buildProxy(`${parts[0]}:${parts[1]}`, parts[2], parts[3]);
        }
        // Format 4: ip:port only
        if (parts.length === 2) {
          return buildProxy(line, baseCreds?.username, baseCreds?.password);
        }
        return null;
      }).filter((p): p is NonNullable<typeof p> => p !== null);

      if (_proxyList.length > 0) {
        console.log(`[scraper] first proxy: ${_proxyList[0].server} (auth: ${_proxyList[0].username ? "yes" : "no"})`);
      } else {
        console.error("[scraper] PROXY_LIST_URL fetched but no valid proxies parsed. First raw line:", lines[0]?.slice(0, 100));
      }
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
