# Letterboxd Taste Matcher

A Next.js app that finds Letterboxd users who share your taste. Enter a username, and it scans the fans of your Top 4 films to surface profiles whose favorites overlap with yours, ranked by match percentage.

## How it works

1. `src/lib/scraper.mjs` fetches a user's profile page and extracts their **Top 4** film slugs.2. For each film it scans the film's **fans** pages (a fan = member with that film in their Top 4).
3. Users who appear across multiple fan lists share films with you — the more films, the higher the match percentage.
4. `POST /api/match` returns the intersection; the UI lets you filter by minimum shared films.

### Scraping transport

Letterboxd sits behind Cloudflare, which serves a "Just a moment…" challenge to datacenter IPs (AWS/Vercel) and TLS-fingerprints Node's default HTTP stack. The scraper shells out to a curl-style binary whose ClientHello is trusted:

- **Local (Windows):** the bundled `curl.exe` (Schannel TLS)
- **VM (Linux):** `curl-impersonate`'s Chrome 133 uTLS binary from `apify-node-curl-impersonate`

The platform is detected at **runtime** via `process.env.OS` (a runtime value — `process.platform` would be folded to the build machine's OS by the bundler). The Linux binary is bundled into the `/api/match` route via `outputFileTracingIncludes` in `next.config.ts`. Override the binary path with the `LETTERBOXD_CURL_BIN` env var if needed.

> **Why a Cloudflare Worker?** Letterboxd's Cloudflare blocks **all** datacenter IPs regardless of TLS fingerprint, so scraping directly from Vercel serverless always fails. The fix is a **Cloudflare Worker fetch relay** (`workers/fetch-relay`): Vercel sends each Letterboxd URL to the worker, which fetches it from Cloudflare's own network — an egress IP that isn't challenged. This is simpler and cheaper than running a VM (optionally, a VM + Cloudflare WARP works too; see below).

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
- `maxPagesPerFilm` (optional, capped at 3) — fans pages scanned per film
- `delayMs` (optional, capped at 10000) — politeness delay between requests
- `minMatches` (optional, 1–4) — minimum shared films for a match

Returns `{ username, topFour, matchCount, matches, scanned }`.

When `SCRAPER_FETCH_URL` is set (Vercel env var), the scraper routes every Letterboxd fetch through the Cloudflare Worker relay instead of scraping from the serverless function.

## Deploying the Cloudflare Worker relay (recommended)

1. **Deploy the worker.** Either:
   - **Dashboard:** Cloudflare → Workers & Pages → Create Worker → paste the contents of `workers/fetch-relay/worker.js` → Deploy.
   - **CLI:** `npx wrangler deploy --config workers/fetch-relay/wrangler.toml` (after `cd workers/fetch-relay`).
2. **Set the secret:** `npx wrangler secret put SCRAPER_TOKEN --name <worker-name>` (or in the dashboard under the worker's Settings → Variables). Pick a long random value.
3. **Verify the relay works:** open the worker URL with a target, e.g. `https://<worker-name>.<account>.workers.dev/fetch?url=https%3A%2F%2Fletterboxd.com%2Fdave%2F`. You should see Letterboxd's real profile HTML (not a "Just a moment…" challenge).
4. **Point Vercel at it.** In the Vercel project set Production env vars:
   ```
   SCRAPER_FETCH_URL=https://<worker-name>.<account>.workers.dev
   SCRAPER_TOKEN=the_secret_you_set
   ```

## Alternative: scraper VM with Cloudflare WARP

If you prefer a dedicated VM (e.g. for higher rate limits or to avoid Cloudflare Worker subrequests), the repo includes a self-hosted option in `scraper-service/`:

1. Create a Debian **e2-micro** instance.
2. `sudo bash scraper-service/provision.sh` — installs Node, Cloudflare WARP (proxy mode, `127.0.0.1:40000`), npm deps, and a systemd service on port 8080.
3. Change `SCRAPER_TOKEN` in `scraper-service/.env`, restart the service.
4. Point Vercel at it: `SCRAPER_URL=https://<vm-ip>:8080` + `SCRAPER_TOKEN`.
