# RecruitMe Scraper

Async human-paced LinkedIn profile scraper for RecruitMe.

Runs as a separate Railway service. Accepts scrape jobs, queues them one at a time, and processes each with ~5–9 minute human-paced delays to avoid LinkedIn bot detection. Results are POSTed back to the main RecruitMe app.

## Deploy on Railway

1. Create a new Railway service pointing at this repo
2. Railway will detect the Dockerfile automatically

## Environment variables

Set these on the scraper service:

| Variable | Description |
|---|---|
| `SCRAPER_API_KEY` | Shared secret — must match `SCRAPER_API_KEY` on the main app |
| `LINKEDIN_EMAIL` | LinkedIn account email (dedicated throwaway account recommended) |
| `LINKEDIN_PASSWORD` | LinkedIn account password |
| `PORT` | HTTP port (default 3001, Railway sets this automatically) |

Set these on the main RecruitMe service:

| Variable | Description |
|---|---|
| `SCRAPER_URL` | Public URL of this service, e.g. `https://recruitmescraper.railway.app` |
| `SCRAPER_API_KEY` | Same value as above |

## How it works

1. Recruiter clicks "Fetch profile" in the RecruitMe app
2. App fires `POST /scrape-async` to this service with the LinkedIn URL and a callback session ID
3. Service queues the job and returns `202 Accepted` immediately
4. Background worker navigates to the profile with human-paced delays:
   - Main profile: 60–120s pause (simulates reading)
   - Each detail section (experience/skills/education/certifications): 45–90s pause
   - Total: ~5–9 minutes per profile
5. On completion, POSTs the profile text to the RecruitMe app's existing `/api/extension/fetch-session/complete` endpoint
6. App scores the candidate — the "Fetching…" toast updates automatically

## Endpoints

- `GET /health` — liveness check
- `POST /scrape-async` — queue a scrape job (requires `X-Scraper-Api-Key` header)
- `GET /status/:id` — check job status
- `POST /login` — trigger a fresh LinkedIn login
