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
const TIMING: Record<string, [number, number]> = {
  afterPageLoad:      [60, 120],   // reading the header + about section
  scroll:             [15,  30],   // scrolling down the profile
  beforeDetailFetch:  [45,  90],   // pause before opening each sub-page
  afterDetailFetch:   [30,  60],   // pause after processing each sub-page
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
  await sleep(randMs(TIMING.beforeDetailFetch));
  await randomMouseMove(page);
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    if (!res || !res.ok()) return "";
    // Verify we actually landed on the section, not a redirect
    if (!page.url().includes(`/details/${section}`)) return "";
    await sleep(randMs(TIMING.afterDetailFetch));
    await randomMouseMove(page);
    const text = await extractMainText(page);
    // Navigate back to base profile before next section
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    return text;
  } catch {
    return "";
  }
}

export async function scrapeProfile(job: ScrapeJob): Promise<string> {
  const ctx = await newContext();
  const page = await ctx.newPage();

  // Block heavy assets — speeds up loads and reduces fingerprint noise
  await page.route("**/*.{png,jpg,jpeg,gif,webp,woff,woff2,ttf}", (r) => r.abort());
  await page.route("**/li/track*", (r) => r.abort());

  try {
    const res = await page.goto(job.linkedinUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    if (!res || !res.ok()) throw new Error(`LinkedIn returned HTTP ${res?.status() ?? "?"}`);
    if (page.url().includes("/authwall") || page.url().includes("/checkpoint") || page.url().includes("/login")) {
      throw new Error("LinkedIn requires login — session may have expired");
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
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${btoa(`scraper:${job.apiKey}`)}`,
    },
    body: JSON.stringify({ sessionId: job.sessionId, error }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}
