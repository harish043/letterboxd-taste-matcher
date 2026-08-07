# Letterboxd Taste Matcher

A Next.js app that finds Letterboxd users who share your taste. Enter a username, and it scans the fans of your Top 4 films to surface profiles whose favorites overlap with yours, ranked by match percentage.

## How it works

1. `src/lib/scraper.js` fetches a user's profile page and extracts their **Top 4** film slugs.
2. For each film it scans the film's **fans** pages (a fan = member with that film in their Top 4).
3. Users who appear across multiple fan lists share films with you — the more films, the higher the match percentage.
4. `POST /api/match` returns the intersection; the UI lets you filter by minimum shared films.

### Scraping transport

Letterboxd sits behind Cloudflare, which TLS-fingerprints Node's default HTTP stack and blocks it. The scraper shells out to a curl-style binary whose ClientHello is trusted:

- **Local (Windows):** the bundled `curl.exe` (Schannel TLS)
- **Vercel (Linux):** `curl-impersonate`'s Chrome uTLS binary from `node-curl-impersonate`

The platform is detected at **runtime** via `process.env.OS` (a runtime value — `process.platform` would be folded to the build machine's OS by the bundler). The Linux binary is bundled into the `/api/match` route via `outputFileTracingIncludes` in `next.config.ts`. Override the binary path with the `LETTERBOXD_CURL_BIN` env var if needed.

## Getting started

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
