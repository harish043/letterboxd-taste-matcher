# Letterboxd Taste Matcher

A Next.js app that finds Letterboxd users who share your taste. Enter a username, and it scans the fans of your Top 4 films to surface profiles whose favorites overlap with yours, ranked by match percentage.

## Features

- **Top 4 matching** — scans each of your four favorite films' fan lists and intersects them; every user found is someone who shares at least one film with you.
- **Unbiased sampling** — Letterboxd sorts fan lists alphabetically by username, so scanning only the first pages would surface accounts starting with `0`–`b` and miss everyone else. The scanner instead **spreads its page budget evenly across each film's entire fan list** (capped at Letterboxd's 256-page limit).
- **Match tiers** — filter results by shared-film count: 2+, 3+, 4/4 only, or all.
- **Load more** — results render in batches of 24 to keep the page responsive even with thousands of 1+ matches.
- **Transparent scan info** — each film shows its total fan count and exactly how many pages were actually fetched.

## How it works

1. `src/lib/scraper.mjs` fetches a user's profile page and extracts their **Top 4** film slugs.
2. For each film it fetches page 1 (to learn the fan count) and then spreads the remaining requests evenly across the fan list — a fan is a member with that film in their Top 4.
3. Users who appear across multiple fan lists share films with you — the more films, the higher the match percentage.
4. `POST /api/match` returns the intersection; the UI lets you filter by minimum shared films.

### Scraping transport

Letterboxd sits behind Cloudflare, which serves a "Just a moment…" challenge to datacenter IPs (AWS/Vercel) and TLS-fingerprints Node's default HTTP stack. The scraper shells out to the **system `curl`** (with plain browser headers) through the residential proxy:

- **Local (Windows):** the system `curl.exe`
- **Vercel (Linux):** the system `curl` on PATH

Overrides and efficiency knobs:

- `LETTERBOXD_CURL_BIN` — override the curl binary if the runtime lacks it.
- Every fetch requests **gzip** (`Accept-Encoding` + `--compressed`) — cuts each fans page from ~109KB to ~21KB (5.2x less proxy bandwidth).
- The route caches parsed fan lists and Top 4 lookups with `unstable_cache` (Vercel's data cache), so repeat scans and scans sharing films reuse results instead of paying the proxy again. Only successful fetches are cached — transient proxy failures are never stored.

> **Why a proxy?** Letterboxd's Cloudflare serves a JS-based "Just a moment…" challenge to **all** datacenter egress IPs — AWS (Vercel serverless), Cloudflare Workers, and even WARP tunnels all get challenged regardless of TLS fingerprint. The fix is a **residential proxy** (e.g. proxying.io, ScraperAPI, BrightData): the scraper routes every Letterboxd fetch through `SCRAPER_PROXY`, so egress comes from a residential IP that Letterboxd does not challenge. This works from Vercel directly — no VM needed.

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
- `maxPagesPerFilm` (optional, default 10, capped at 20) — fans page requests per film, spread evenly across the fan list
- `delayMs` (optional, capped at 10000) — politeness delay between requests
- `minMatches` (optional, 1–4) — minimum shared films for a match

Returns `{ username, topFour, matchCount, matches, scanned }`, where each entry of `scanned` is `{ totalFans, pagesFetched, scannedPages }` — `pagesFetched` is the number of pages that actually returned fans (a few can fail on a slow proxy), and `scannedPages` is the deepest page number reached.

## Production setup (Vercel + residential proxy)

No VM needed. Set these Production env vars in the Vercel project (Settings → Environment Variables):

```
SCRAPER_PROXY=http://USER:PASSWORD@proxy.proxying.io:8080
```

Optional cache TTLs (defaults are sane; tune to trade freshness vs proxy spend):

```
FANS_CACHE_TTL_SECONDS=86400     # parsed fan pages cached for 24h
PROFILE_CACHE_TTL_SECONDS=3600   # Top 4 lookups cached for 1h
```

`/api/match` then routes every Letterboxd fetch through the residential proxy, whose IP passes Cloudflare, and caches the parsed results so repeat scans don't re-pay the proxy.

Notes:
- If you use proxying.io, you can add options by appending `_quality-high` (or `_country-xx`) to the password: `http://user:pass_quality-high@proxy.proxying.io:8080`.
- For higher rate limits or more concurrent scans, a paid plan helps. The scraper does **not** pin a sticky proxy session — it relies on the proxy's own per-request IP rotation so a Cloudflare-flagged IP is automatically abandoned on the next request.
- The `SCRAPER_TOKEN`/`SCRAPER_URL` env vars are only needed for the (now optional) scraper VM setup below.

## Optional: scraper VM (not required)

The repo includes a self-hosted fallback in `scraper-service/` (a Debian/Ubuntu e2-micro running the scraper behind Cloudflare WARP). It is **not needed** if you use `SCRAPER_PROXY` on Vercel — keep it only if you prefer to run the scraper on your own infrastructure:

1. Create an Ubuntu 24.04 e2-micro instance.
2. `sudo bash scraper-service/provision.sh` — installs Node, WARP (proxy mode), npm deps, and a systemd service on port 8080.
3. Set `SCRAPER_TOKEN` and `SCRAPER_PROXY` in `scraper-service/.env`.
4. Point Vercel at it: `SCRAPER_URL=http://<vm-ip>:8080` + `SCRAPER_TOKEN`.
