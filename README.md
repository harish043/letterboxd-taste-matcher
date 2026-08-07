# Letterboxd Taste Matcher

A Next.js app that finds Letterboxd users who share your taste. Enter a username, and it scans the fans of your Top 4 films to surface profiles whose favorites overlap with yours, ranked by match percentage.

## How it works

1. `src/lib/scraper.mjs` fetches a user's profile page and extracts their **Top 4** film slugs.
2. For each film it scans the film's **fans** pages (a fan = member with that film in their Top 4).
3. Users who appear across multiple fan lists share films with you — the more films, the higher the match percentage.
4. `POST /api/match` returns the intersection; the UI lets you filter by minimum shared films.

### Scraping transport

Letterboxd sits behind Cloudflare, which serves a "Just a moment…" challenge to datacenter IPs (AWS/Vercel) and TLS-fingerprints Node's default HTTP stack. The scraper shells out to a curl-style binary whose ClientHello is trusted:

- **Local (Windows):** the bundled `curl.exe` (Schannel TLS)
- **VM (Linux):** `curl-impersonate`'s Chrome 133 uTLS binary from `apify-node-curl-impersonate`

The platform is detected at **runtime** via `process.env.OS` (a runtime value — `process.platform` would be folded to the build machine's OS by the bundler). The Linux binary is bundled into the `/api/match` route via `outputFileTracingIncludes` in `next.config.ts`. Override the binary path with the `LETTERBOXD_CURL_BIN` env var if needed.

> **Why a scraper VM?** Letterboxd's Cloudflare blocks **all** datacenter IPs regardless of TLS fingerprint, so scraping directly from Vercel serverless always fails. The solution is a small VM that egresses through **Cloudflare WARP (1.1.1.1)** — traffic then leaves from Cloudflare's own IP ranges, which are not challenged. Vercel proxies `/api/match` to the VM via the `SCRAPER_URL` env var.

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

When `SCRAPER_URL` is set (Vercel env var), this route proxies to the VM's scraper service instead of scraping locally.

## Deploying the scraper VM

Create a Debian **e2-micro** instance (1 vCPU / 1 GB, free tier), then from an SSH session run:

```bash
cd /opt
git clone https://github.com/harish043/letterboxd-taste-matcher.git
cd letterboxd-taste-matcher
sudo bash scraper-service/provision.sh
```

`provision.sh`:

1. Installs Node.js 20, Cloudflare WARP (`cloudflare-warp`), and `ufw`
2. Registers + connects WARP in **proxy mode** (`127.0.0.1:40000`) so all scraper egress uses Cloudflare IPs
3. Runs `npm ci`, writes `scraper-service/.env`, and installs the `letterboxd-scraper` systemd service on port 8080
4. Opens firewall port 8080

**Before you go live, change the token:**

```bash
sudo nano /opt/letterboxd-taste-matcher/scraper-service/.env
# SCRAPER_TOKEN=your_strong_token
sudo systemctl restart letterboxd-scraper
```

Test the service:

```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/match \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer your_strong_token' \
  -d '{"username":"dave","maxPagesPerFilm":1,"delayMs":0}'
```

### Point Vercel at the VM

In the Vercel project, set two env vars (Production):

```
SCRAPER_URL=https://<vm-external-ip>:8080   # or behind a domain/TCP proxy
SCRAPER_TOKEN=your_strong_token
```

`/api/match` will then proxy scraping to the VM. A domain with TLS (e.g. via Cloudflare) is recommended so the token isn't sent in plaintext — or use a GCP Cloud Run / internal LB in front.
