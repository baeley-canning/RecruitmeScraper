/**
 * Human-paced LinkedIn profile scraper.
 *
 * Timing is deliberately slow and randomised so the session looks like a
 * real recruiter reading a profile — not a bot hammering endpoints.
 * Each deep section (experience, skills, education, certifications) gets its
 * own navigation with a human-paced wait before and after.
 *
 * Total time per profile: ~5–9 minutes.
 *
 * On completion the profile text is POSTed back to the app via the
 * /api/extension/fetch-session/complete endpoint, which the existing UI
 * already polls. No changes needed on the app side.
 */

import { newContext } from "./browser.js";
import type { Page } from "playwright";
import type { ScrapeJob } from "./queue.js";

// ── Timing config (seconds) ───────────────────────────────────────────────
// Each value is a [min, max] range. Actual delay = random within range.
// Total per profile: ~3-5 minutes. The key signal LinkedIn detects is
// rapid link-to-link navigation — beforeDetailFetch is the most important.
const TIMING: Record<string, [number, number]> = {
  afterPageLoad:      [15,  30],   // reading the header + about section
  scroll:             [ 5,  10],   // scrolling down the profile
  beforeDetailFetch:  [20,  45],   // pause before opening each sub-page (key: must feel human)
  afterDetailFetch:   [12,  25],   // reading the section before moving on
};

function randMs([min, max]: [number, number]): number {
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Simulate human scrolling — moves in steps with pauses.
async function humanScroll(page: Page): Promise<void> {
  const distance = 2000 + Math.round(Math.random() * 2000);
  let scrolled = 0;
  while (scrolled < distance) {
    const step = 200 + Math.round(Math.random() * 300);
    await page.evaluate((s: number) => window.scrollBy(0, s), step);
    scrolled += step;
    await sleep(120 + Math.round(Math.random() * 180));
  }
  // Drift back up slightly — humans rarely read straight to the bottom
  await page.evaluate(() => window.scrollBy(0, -(200 + Math.round(Math.random() * 300))));
}

// Move the mouse to a random plausible position — helps with bot fingerprints.
async function randomMouseMove(page: Page): Promise<void> {
  try {
    const x = 200 + Math.round(Math.random() * 800);
    const y = 100 + Math.round(Math.random() * 500);
    await page.mouse.move(x, y, { steps: 10 + Math.round(Math.random() * 20) });
  } catch { /* non-fatal */ }
}

function extractMainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement | null;
    if (!main) return document.body.innerText ?? "";
    const lines: string[] = [];
    const walk = (el: Element) => {
      const tag = el.tagName.toLowerCase();
      if (["script","style","noscript","svg","button","nav"].includes(tag)) return;
      if ((el as HTMLElement).offsetParent === null && tag !== "body") return;
      const text = (el as HTMLElement).innerText?.trim();
      if (text && el.children.length === 0 && text.length > 0 && text.length < 500) lines.push(text);
      for (const child of Array.from(el.children)) walk(child);
    };
    walk(main);
    return [...new Set(lines)].join("\n");
  });
}

async function fetchSection(
  page: Page,
  baseUrl: string,
  section: string,
): Promise<string> {
  const url = baseUrl.replace(/\/?$/, `/details/${section}/`);
  // Human pause before navigating — this is the main detection signal.
  await sleep(randMs(TIMING.beforeDetailFetch));
  await randomMouseMove(page);
  await humanScroll(page);
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (!res || !res.ok()) return "";
    if (!page.url().includes(`/details/${section}`)) return "";
    await sleep(randMs(TIMING.afterDetailFetch));
    await randomMouseMove(page);
    return await extractMainText(page);
    // No bounce-back — navigate directly to next section from here.
    // Bouncing back to the base profile every time is an unnatural pattern.
  } catch {
    return "";
  }
}

export async function scrapeProfile(job: ScrapeJob): Promise<string> {
  const ctx = await newContext();
  const page = await ctx.newPage();

  // Set realistic browser headers on every request — missing Accept headers
  // are a strong bot signal that triggers LinkedIn's HTTP 999 block.
  await page.setExtraHTTPHeaders({
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-NZ,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    // Safari doesn't send Sec-Fetch-* headers — omitting them matches WebKit behaviour
  });

  // Only block tracking pixels — keep CSS/fonts/images so the page looks
  // like a real browser visit. Blocking too many resources is itself a bot signal.
  await page.route("**/li/track*", (r) => r.abort());
  await page.route("**/*ads*", (r) => r.abort());

  try {
    const res = await page.goto(job.linkedinUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    console.log(`[scraper] page loaded: ${page.url().slice(0, 120)} (status ${res?.status()})`);
    if (res?.status() === 999) {
      throw new Error("LinkedIn returned 999 — bot detection. Update LINKEDIN_COOKIES in Railway with fresh cookies from your browser.");
    }
    if (!res || !res.ok()) throw new Error(`LinkedIn returned HTTP ${res?.status() ?? "?"}`);
    if (page.url().includes("/authwall") || page.url().includes("/checkpoint") || page.url().includes("/login")) {
      throw new Error(`LinkedIn requires login — session expired. Landed on: ${page.url()}`);
    }

    // Human pause — reading the header and about section
    await sleep(randMs(TIMING.afterPageLoad));
    await randomMouseMove(page);
    await humanScroll(page);
    await sleep(randMs(TIMING.scroll));

    // Canonical URL after any slug redirect
    const canonicalUrl = await page.evaluate(() =>
      (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href ?? location.href
    );
    const baseUrl = canonicalUrl.split("?")[0].replace(/\/$/, "");

    const mainText = await extractMainText(page);

    // Fetch detail sections one at a time with human pacing
    const sections: { name: string; text: string }[] = [];
    for (const section of ["experience", "skills", "education", "certifications"]) {
      const text = await fetchSection(page, baseUrl, section);
      if (text.length > 100) sections.push({ name: section, text });
    }

    const parts = [
      mainText,
      ...sections.map(({ name, text }) =>
        `\n\n${name.charAt(0).toUpperCase() + name.slice(1)}\n${text}`
      ),
    ];

    const profileText = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
    if (profileText.length < 200) throw new Error("Profile text too short — may be private or empty");
    return profileText.slice(0, 100_000);
  } finally {
    await ctx.close();
  }
}

// ── Callback to app ────────────────────────────────────────────────────────

export async function postResultToApp(job: ScrapeJob, profileText: string): Promise<void> {
  const url = `${job.callbackUrl.replace(/\/$/, "")}/api/extension/fetch-session/complete`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${btoa(`scraper:${job.apiKey}`)}`,
    },
    body: JSON.stringify({
      sessionId:   job.sessionId,
      linkedinUrl: job.linkedinUrl,
      profileText,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`App callback failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

export async function postErrorToApp(job: ScrapeJob, error: string): Promise<void> {
  const url = `${job.callbackUrl.replace(/\/$/, "")}/api/extension/fetch-session/error`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${btoa(`scraper:${job.apiKey}`)}`,
      },
      body: JSON.stringify({ sessionId: job.sessionId, error }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[scraper] error callback failed: ${res.status} ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error("[scraper] error callback threw:", err instanceof Error ? err.message : err);
  }
}
