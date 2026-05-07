/**
 * Single-worker async scrape queue.
 *
 * One job runs at a time — no parallel LinkedIn sessions that would spike
 * the request rate and look like a bot. Jobs are kept in memory; if the
 * process restarts they're lost (the app re-fires via FetchSession on next
 * poll cycle, so nothing is permanently dropped).
 */

export interface ScrapeJob {
  id:           string;
  linkedinUrl:  string;
  sessionId:    string;   // FetchSession ID — sent back to app on completion
  callbackUrl:  string;   // app base URL, e.g. https://recruitme.railway.app
  apiKey:       string;   // SCRAPER_API_KEY for callback auth
  enqueuedAt:   number;
}

type JobStatus = "queued" | "running" | "done" | "failed";

interface JobRecord extends ScrapeJob {
  status:    JobStatus;
  error?:    string;
}

const jobs = new Map<string, JobRecord>();
let running = false;

type ProcessFn = (job: ScrapeJob) => Promise<void>;
let processFn: ProcessFn | null = null;

export function setProcessor(fn: ProcessFn) {
  processFn = fn;
}

export function enqueue(job: ScrapeJob): void {
  jobs.set(job.id, { ...job, status: "queued" });
  drain();
}

export function getStatus(id: string): JobRecord | null {
  return jobs.get(id) ?? null;
}

async function drain() {
  if (running || !processFn) return;
  const next = [...jobs.values()].find((j) => j.status === "queued");
  if (!next) return;
  running = true;
  jobs.set(next.id, { ...next, status: "running" });
  try {
    await processFn(next);
    jobs.set(next.id, { ...next, status: "done" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jobs.set(next.id, { ...next, status: "failed", error: msg });
    console.error(`[queue] job ${next.id} failed:`, msg);
  } finally {
    running = false;
    // Remove completed jobs after 10 minutes to avoid memory leak
    setTimeout(() => jobs.delete(next.id), 10 * 60 * 1000);
    drain();
  }
}
