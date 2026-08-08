# Letterboxd Taste Matcher

A Next.js app that finds Letterboxd users who share your taste. Enter a username, and it finds users whose favorite films overlap with yours, ranked by match percentage — with exact shared films and activity stats on every match.

## How it works

1. `src/lib/scraper.mjs` fetches a user's profile page and extracts their **Top 4** film slugs.
2. It then queries **Letterboxd's own member-search engine** with `fan:<film>` operators OR'd together (e.g. `(fan:A+fan:B) OR (fan:A+fan:C) …`) — one request per match tier, which finds every member whose Top 4 overlaps with ≥2 of yours. This is far cheaper and more complete than scraping fan pages.
3. Each match's profile is fetched to compute the **exact shared films**, **match percentage**, and **activity stats** (films logged this year, total films).
4. `POST /api/match` returns the enriched matches; the UI filters by minimum shared films (2+ / 3+ / 4/4).

### Scraping transport

Letterboxd sits behind Cloudflare, which serves a "Just a moment…" challenge to datacenter IPs (AWS/Vercel) and TLS-fingerprints Node's default HTTP stack. The scraper shells out to the **system `curl`** (with plain browser headers) through the residential proxy:

- **Local (Windows):** the system `curl.exe`
- **Vercel (Linux):** the system `curl` on PATH

Override the binary with the `LETTERBOXD_CURL_BIN` env var if the runtime lacks curl. No custom/native scraping packages are bundled.

> **Why a proxy?** Letterboxd's Cloudflare serves a JS-based "Just a moment…" challenge to **all** datacenter egress IPs — AWS (Vercel serverless), Cloudflare Workers, and even WARP tunnels all get challenged regardless of TLS fingerprint. The fix is a **residential proxy** (e.g. proxying.io, ScraperAPI, BrightData): the scraper routes every Letterboxd fetch through `SCRAPER_PROXY`, so egress comes from a residential IP that Letterboxd does not challenge. This works from Vercel directly — no VM needed.

> **Fallback:** set `SCRAPE_MODE=pages` to switch back to scraping each film's fan pages instead of the member-search engine (used if the search endpoint changes).

> **Note:** The `scraper-service/` (VM + WARP) and `workers/fetch-relay/` (Cloudflare Worker) approaches were both implemented and tested but **do not bypass the challenge**. They remain in the repo as reference. The `SCRAPER_PROXY` residential-proxy path is the working solution.

## Getting started (local dev)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Commands

- `npm run dev` — Turbopack dev server
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm test` — unit tests (`node --test`)

## API

`POST /api/match` with a JSON body:

```json
{ "username": "dave", "maxPagesPerFilm": 3, "delayMs": 300, "minMatches": 1 }
```

- `username` (required) — Letterboxd username, `/^[a-zA-Z0-9_]{1,30}$/`
- `maxPagesPerFilm` (optional, default 10, capped at 20) — fans pages scanned per film
- `delayMs` (optional, capped at 10000) — politeness delay between requests
- `minMatches` (optional, 1–4) — minimum shared films for a match

Returns `{ username, topFour, matchCount, matches, scanned }`, where each `topFour` entry is `{ slug, title, posterUrl }` (poster resolved from the film's og:image; poster fetches are cached 24h).

## Production setup (Vercel + residential proxy)

No VM needed. Set these Production env vars in the Vercel project (Settings → Environment Variables):

```
SCRAPER_PROXY=http://USER:PASSWORD@proxy.proxying.io:8080
```

Optional cache TTLs (defaults are sane; tune to trade freshness vs proxy spend):

```
FANS_CACHE_TTL_SECONDS=86400     # parsed search results cached for 24h
PROFILE_CACHE_TTL_SECONDS=1800   # profile lookups cached for 30 min
SCRAPE_MODE=search               # search = member-search engine; pages = fan-page scraping
```

`/api/match` routes every Letterboxd fetch through the residential proxy, whose IP passes Cloudflare, and caches the parsed results (`unstable_cache`, Vercel's data cache) so repeat scans and scans sharing films don't re-pay the proxy. Only successful fetches are cached — transient failures are never stored.

Rate limiting: `POST /api/match` is limited to **5 requests per 10 minutes per IP** (sliding window, keyed on `x-forwarded-for`), returning `429` + `Retry-After` on exceed. The limiter is in-process — best-effort on serverless, but enough to blunt traffic spikes and protect the proxy budget.

Notes:
- If you use proxying.io, you can add options by appending `_quality-high` (or `_country-xx`) to the password: `http://user:pass_quality-high@proxy.proxying.io:8080`.
- The scraper pins a sticky proxy session per process and **rotates to a fresh session** whenever Cloudflare challenges or the proxy drops the connection, so a flagged IP is abandoned instead of failing every retry.
- The `SCRAPER_TOKEN`/`SCRAPER_URL` env vars are only needed for the (now optional) scraper VM setup below.

## Optional: scraper VM (not required)

The repo includes a self-hosted fallback in `scraper-service/` (a Debian/Ubuntu e2-micro running the scraper behind Cloudflare WARP). It is **not needed** if you use `SCRAPER_PROXY` on Vercel — keep it only if you prefer to run the scraper on your own infrastructure:

1. Create an Ubuntu 24.04 e2-micro instance.
2. `sudo bash scraper-service/provision.sh` — installs Node, WARP (proxy mode), npm deps, and a systemd service on port 8080.
3. Set `SCRAPER_TOKEN` and `SCRAPER_PROXY` in `scraper-service/.env`.
4. Point Vercel at it: `SCRAPER_URL=http://<vm-ip>:8080` + `SCRAPER_TOKEN`.
