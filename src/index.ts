/**
 * RecruitMe Scraper Service — async queue edition
 *
 * Accepts scrape jobs, queues them, and processes one at a time with
 * human-paced delays (~5–9 minutes per profile). Results are POSTed back
 * to the RecruitMe app via the existing fetch-session/complete endpoint so
 * the app's existing polling UI works without changes.
 *
 * Environment variables:
 *   PORT              HTTP port (default 3001)
 *   SCRAPER_API_KEY   Shared secret between this service and the app
 *   LINKEDIN_EMAIL    LinkedIn account email
 *   LINKEDIN_PASSWORD LinkedIn account password
 *   LINKEDIN_COOKIES  JSON cookie array (alternative to email/password)
 *
 * Endpoints:
 *   GET  /health
 *   POST /scrape-async   { sessionId, linkedinUrl, callbackUrl } → 202 Accepted
 *   GET  /status/:id     → { status, error? }
 *   POST /login          { email, password } → trigger fresh login
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { scrapeProfile, postResultToApp, postErrorToApp } from "./scrape.js";
import { enqueue, getStatus, setProcessor } from "./queue.js";
import { loginLinkedIn, setSessionCookies } from "./browser.js";
import type { ScrapeJob } from "./queue.js";

const PORT    = Number(process.env.PORT ?? 3001);
const API_KEY = process.env.SCRAPER_API_KEY ?? "";

if (!API_KEY) console.warn("[scraper] WARNING: SCRAPER_API_KEY not set — all requests rejected");

// Register the queue processor
setProcessor(async (job: ScrapeJob) => {
  console.log(`[scraper] starting job ${job.id} for ${job.linkedinUrl}`);
  const start = Date.now();
  try {
    const profileText = await scrapeProfile(job);
    console.log(`[scraper] job ${job.id} done in ${Math.round((Date.now()-start)/1000)}s — ${profileText.length} chars`);
    await postResultToApp(job, profileText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scraper] job ${job.id} failed in ${Math.round((Date.now()-start)/1000)}s:`, msg);
    await postErrorToApp(job, msg);
  }
});

async function initSession(): Promise<void> {
  const cookieJson = process.env.LINKEDIN_COOKIES;
  if (cookieJson) {
    try {
      setSessionCookies(JSON.parse(cookieJson));
      console.log("[scraper] session cookies loaded");
      return;
    } catch { console.warn("[scraper] LINKEDIN_COOKIES was not valid JSON"); }
  }
  const email = process.env.LINKEDIN_EMAIL;
  const pass  = process.env.LINKEDIN_PASSWORD;
  if (email && pass) {
    console.log("[scraper] logging into LinkedIn…");
    await loginLinkedIn(email, pass).catch((e: Error) => {
      console.error("[scraper] login failed:", e.message);
    });
  } else {
    console.warn("[scraper] no LinkedIn credentials — scrapes will fail unless LINKEDIN_COOKIES is set");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rej);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  // Auth — every request except /health
  if (req.url !== "/health") {
    if (!API_KEY || req.headers["x-scraper-api-key"] !== API_KEY) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }
  }

  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true, version: "2.0.0" });
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/status/")) {
    const id = req.url.replace("/status/", "");
    const record = getStatus(id);
    if (!record) { json(res, 404, { error: "Job not found" }); return; }
    json(res, 200, { status: record.status, error: record.error });
    return;
  }

  if (req.method === "POST" && req.url === "/scrape-async") {
    let body: { sessionId?: string; linkedinUrl?: string; callbackUrl?: string };
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }

    const { sessionId, linkedinUrl, callbackUrl } = body;
    if (!sessionId || !linkedinUrl?.includes("linkedin.com/in/") || !callbackUrl) {
      json(res, 400, { error: "sessionId, linkedinUrl (linkedin.com/in/), and callbackUrl are required" });
      return;
    }

    const id = randomUUID();
    enqueue({ id, linkedinUrl, sessionId, callbackUrl, apiKey: API_KEY, enqueuedAt: Date.now() });
    console.log(`[scraper] queued job ${id} (session ${sessionId})`);
    json(res, 202, { queued: true, jobId: id });
    return;
  }

  if (req.method === "POST" && req.url === "/login") {
    let body: { email?: string; password?: string };
    try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "Invalid JSON" }); return; }
    if (!body.email || !body.password) { json(res, 400, { error: "email and password required" }); return; }
    try {
      await loginLinkedIn(body.email, body.password);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e instanceof Error ? e.message : String(e) }); }
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, async () => {
  console.log(`[scraper] listening on port ${PORT}`);
  await initSession();
});

process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
