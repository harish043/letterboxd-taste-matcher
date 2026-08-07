import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

const BASE_URL = "https://letterboxd.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stable per-process id used to pin a sticky proxy session across requests.
const STICKY_SESSION_ID = Date.now().toString(36);

// proxying.io sticky sessions: append `_session-<id>` to the password so the
// proxy keeps the same egress IP for the lifetime of this process. If the URL
// already carries a session option (or SCRAPER_PROXY is unset/not proxying.io),
// leave it untouched.
function applyStickySession(proxyUrl) {
  if (!proxyUrl) return proxyUrl;
  if (/_session-[A-Za-z0-9]+/.test(proxyUrl)) return proxyUrl;
  const match = proxyUrl.match(/^(https?:\/\/)([^:/@]+):([^@]*)@(.*)$/);
  if (!match) return proxyUrl;
  const [, scheme, user, pass, host] = match;
  return `${scheme}${user}:${pass}_session-${STICKY_SESSION_ID}@${host}`;
}

// Letterboxd sits behind Cloudflare, which fingerprints Node's OpenSSL TLS
// stack (JA3/JA4) and serves a "Just a moment..." challenge to it. Native
// `fetch` is blocked on most networks. We therefore fetch through a curl-style
// binary whose TLS ClientHello is trusted:
//   - Windows dev: the bundled curl.exe (Schannel).
//   - Linux serverless (Vercel): curl-impersonate's Chrome uTLS binary, which
//     ships with apify-node-curl-impersonate (a current curl-impersonate build
//     with Chrome 133 fingerprints).
//
// IMPORTANT: the platform check must NOT be a build-time constant. Bundlers
// (Turbopack) fold `os.platform()` / `process.platform` into the platform the
// app was *built* on, which would hardcode "curl.exe" into a Linux deploy and
// 502. `process.env` reads are runtime values, so `OS === "Windows_NT"` (set
// by Windows, absent on Linux) survives bundling. The binary itself is resolved
// from `process.cwd()` (project root in dev and on Vercel) and is bundled by
// `outputFileTracingIncludes` in next.config.
function resolveCurlBinary() {
  const override = process.env.LETTERBOXD_CURL_BIN;
  if (override) return override;

  if (process.env.OS === "Windows_NT") return "curl.exe";

  const candidate = path.join(
    process.cwd(),
    "node_modules",
    "apify-node-curl-impersonate",
    "bin",
    "curl-impersonate-linux-x86"
  );
  try {
    fs.chmodSync(candidate, 0o755);
  } catch {
    // chmod is best-effort; execFile will surface EACCES if it matters.
  }
  return candidate;
}

/**
 * Fetch a URL's HTML using the platform-appropriate curl binary so Cloudflare
 * doesn't challenge the request.
 *
 * On Linux the bundled curl-impersonate binary must be given the full Chrome
 * preset (cipher suite, HTTP/2, header order) — the binary alone isn't enough;
 * Cloudflare fingerprints the TLS/HTTP2 negotiation, which is exactly what the
 * preset provides. On Windows the stock curl.exe (Schannel TLS) passes without
 * the preset.
 */
async function fetchHtml(url, signal) {
  // When SCRAPER_FETCH_URL is set, route fetches through a Cloudflare Worker
  // relay. (Kept for reference; not the working path.)
  const relayUrl = process.env.SCRAPER_FETCH_URL;
  if (relayUrl) {
    const relay = new URL(
      relayUrl.endsWith("/fetch") ? relayUrl : `${relayUrl.replace(/\/$/, "")}/fetch`
    );
    relay.searchParams.set("url", url);
    const res = await fetch(relay, {
      headers: process.env.SCRAPER_TOKEN
        ? { Authorization: `Bearer ${process.env.SCRAPER_TOKEN}` }
        : {},
      signal,
    });
    if (!res.ok) {
      throw new Error(`Relay fetch to ${url} failed with status ${res.status}`);
    }
    return res.text();
  }

  const isWindows = process.env.OS === "Windows_NT";

  // When SCRAPER_PROXY is set (residential proxy on Vercel), use curl through
  // the proxy with plain browser headers. The proxy's residential egress IP is
  // what passes Letterboxd's Cloudflare — TLS impersonation is not needed (its
  // BoringSSL flags can break the HTTPS CONNECT tunnel intermittently). Node's
  // native fetch is NOT usable here: undici's TLS fingerprint is detected even
  // through a residential proxy (403), whereas curl passes (200).
  //
  // Proxying.io rotates the egress IP on every request by default; rotating IPs
  // re-trigger Cloudflare challenges. Pin a sticky session so the whole scan
  // uses one trusted IP. `_session-<id>` is the proxying.io sticky-session
  // suffix. The session id is stable for the lifetime of this process, so all
  // requests in a scan share the same IP.
  const proxy = applyStickySession(process.env.SCRAPER_PROXY);

  const browserHeaders = [
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "-H",
    "Accept-Language: en-US,en;q=0.9",
    "-H",
    "Sec-Fetch-Site: none",
    "-H",
    "Sec-Fetch-Mode: navigate",
    "-H",
    "Sec-Fetch-Dest: document",
  ];

  const curlArgs = isWindows || proxy
    ? [
        "-sSL",
        "--http1.1",
        "--max-time",
        "30",
        ...(proxy ? ["--proxy", proxy] : []),
        ...browserHeaders,
        url,
      ]
    : [
        "-sSL",
        "--max-time",
        "30",
        "--compressed",
        "--ciphers",
        "TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384,TLS_CHACHA20_POLY1305_SHA256,ECDHE-ECDSA-AES128-GCM-SHA256,ECDHE-RSA-AES128-GCM-SHA256,ECDHE-ECDSA-AES256-GCM-SHA384,ECDHE-RSA-AES256-GCM-SHA384,ECDHE-ECDSA-CHACHA20-POLY1305,ECDHE-RSA-CHACHA20-POLY1305,ECDHE-RSA-AES128-SHA,ECDHE-RSA-AES256-SHA,AES128-GCM-SHA256,AES256-GCM-SHA384,AES128-SHA,AES256-SHA",
        "--curves",
        "X25519MLKEM768:X25519:P-256:P-384",
        "--http2-settings",
        "1:65536;2:0;4:6291456;6:262144",
        "--http2-window-update",
        "15663105",
        "--http2-stream-weight",
        "256",
        "--http2-stream-exclusive",
        "1",
        "--ech",
        "GREASE",
        "--tlsv1.2",
        "--alps",
        "--tls-permute-extensions",
        "--cert-compression",
        "brotli",
        "-H",
        `sec-ch-ua: "Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"`,
        "-H",
        "sec-ch-ua-mobile: ?0",
        "-H",
        "sec-ch-ua-platform: macOS",
        "-H",
        "Upgrade-Insecure-Requests: 1",
        "-H",
        "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "-H",
        "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "-H",
        "Sec-Fetch-Site: none",
        "-H",
        "Sec-Fetch-Mode: navigate",
        "-H",
        "Sec-Fetch-User: ?1",
        "-H",
        "Sec-Fetch-Dest: document",
        "-H",
        "Accept-Encoding: gzip, deflate, br, zstd",
        "-H",
        "Accept-Language: en-US,en;q=0.9",
        "-H",
        "Priority: u=0, i",
        url,
      ];

  // Retry transient tunnel failures (e.g. curl-impersonate BoringSSL
  // "BAD_DECRYPT" through an HTTP proxy) and Cloudflare challenge pages
  // (sticky-session IPs can occasionally be flagged) a few times.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await execFileP(resolveCurlBinary(), curlArgs, {
        maxBuffer: 10 * 1024 * 1024,
        signal,
      });
      // A 403 challenge page comes back as a successful curl run with a
      // "Just a moment..." body. Treat it as retryable.
      if (result.stdout.includes("Just a moment")) {
        lastError = new Error(`Cloudflare challenge for ${url}`);
        if (attempt < 2) {
          await sleep(600);
          continue;
        }
        throw lastError;
      }
      return result.stdout;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(500);
    }
  }
  throw lastError;
}

/**
 * Fetch a Letterboxd profile page and return the URL slugs of the user's
 * Top 4 favorite films.
 *
 * @param {string} username Letterboxd username.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string[]>} Array of 4 film slugs, e.g. ["high-and-low", ...].
 * @throws {Error} On non-200 response or if the profile has no favorites section.
 */
export async function getTopFourSlugs(username, { signal } = {}) {
  const url = `${BASE_URL}/${username}/`;
  const html = await fetchHtml(url, signal);
  const slugs = parseTopFourSlugs(html);

  if (slugs.length === 0) {
    throw new Error(
      `No favorites section found for username "${username}" (profile may not exist or has no Top 4). Received ${html.length} bytes, starts: "${html.slice(0, 120)}"`
    );
  }
  return slugs;
}

/**
 * Extract the URL slugs of a user's Top 4 films from a profile page's HTML.
 *
 * @param {string} html Raw profile page HTML.
 * @returns {string[]} Film slugs, e.g. ["high-and-low", ...].
 */
export function parseTopFourSlugs(html) {
  const $ = cheerio.load(html);
  const slugs = [];
  $("#favourites li.griditem div.react-component").each((_, el) => {
    const slug = $(el).attr("data-item-slug");
    if (slug) slugs.push(slug);
  });
  return slugs;
}

/**
 * Parse the fan count of a film from its fans page sub-nav, e.g. 146,599.
 *
 * @param {CheerioAPI} $
 * @param {string} slug
 * @returns {number|null} Number of fans, or null if not present.
 */
function parseFanCount($, slug) {
  const title = $(`li.js-route-fans a[href="/film/${slug}/fans/"]`).attr(
    "title"
  );
  if (!title) return null;
  const match = String(title).match(/([\d,]+)/);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

/**
 * Extract usernames, pagination state, and fan count from a fans page's HTML.
 *
 * @param {string} html Raw fans page HTML.
 * @param {string} slug Film slug (used to locate the fan-count link).
 * @param {number} page 1-indexed page number.
 * @returns {{ usernames: string[], hasNext: boolean, count: number|null }}
 */
export function parseFansPage(html, slug, page) {
  const $ = cheerio.load(html);
  const usernames = [];
  $("table.member-table tbody tr a.name").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      usernames.push(href.replace(/^\//, "").replace(/\/$/, ""));
    }
  });
  const hasNext = $("div.pagination a.next").length > 0;
  const count = page === 1 ? parseFanCount($, slug) : null;
  return { usernames, hasNext, count };
}

/**
 * Fetch one fans page and return the usernames on it.
 *
 * @param {string} slug
 * @param {number} page 1-indexed page number.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ usernames: string[], hasNext: boolean, count: number|null }>}
 */
async function fetchFansPage(slug, page, { signal } = {}) {
  const url =
    page === 1
      ? `${BASE_URL}/film/${slug}/fans/`
      : `${BASE_URL}/film/${slug}/fans/page/${page}/`;
  const html = await fetchHtml(url, signal);
  return parseFansPage(html, slug, page);
}

/**
 * Fetch the fans of several films and return the usernames that appear on the
 * fans page of every film (i.e. fans whose Top 4 includes all given films).
 *
 * @param {string[]} slugs Film slugs to intersect over.
 * @param {object} [options]
 * @param {number} [options.maxPagesPerFilm=5] Max fans pages to scan per film.
 * @param {number} [options.delayMs=1500] Politeness delay between requests.
 * @param {number} [options.concurrency=8] Max concurrent proxy requests.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ shared: string[], perFilm: Record<string, { count: number|null, scannedPages: number, fans: string[] }> }>}
 */
export async function getSharedFans(
  slugs,
  { maxPagesPerFilm = 5, delayMs = 1500, signal, concurrency = 8 } = {}
) {
  const perFilm = Object.fromEntries(
    slugs.map((slug) => [
      slug,
      { count: null, scannedPages: 0, done: false, fans: new Set() },
    ])
  );

  // Worker-pool fetch: schedule every (film, page) fetch up front and run them
  // through a bounded pool (default 8 concurrent) so the residential proxy is
  // kept saturated. This is much faster than strict per-page waves, which stall
  // waiting for the slowest film each round.
  const tasks = [];
  for (const slug of slugs) {
    for (let page = 1; page <= maxPagesPerFilm; page++) {
      tasks.push({ slug, page });
    }
  }

  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const { slug, page } = task;
      if (perFilm[slug].done) continue; // skip once the film has no more pages
      try {
        const { usernames, hasNext, count } = await fetchFansPage(slug, page, {
          signal,
        });
        if (perFilm[slug].done) continue; // lost a race with page 1's hasNext
        for (const username of usernames) perFilm[slug].fans.add(username);
        if (count != null) perFilm[slug].count = count;
        perFilm[slug].scannedPages = Math.max(perFilm[slug].scannedPages, page);
        if (!hasNext) perFilm[slug].done = true;
      } catch {
        // Skip failures; the film's other pages still get processed. Retries
        // for transient proxy errors happen inside fetchHtml.
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length || 1) }, worker)
  );

  const clean = Object.fromEntries(
    slugs.map((slug) => [
      slug,
      {
        count: perFilm[slug].count,
        scannedPages: perFilm[slug].scannedPages,
        fans: [...perFilm[slug].fans],
      },
    ])
  );

  const shared = slugs.length
    ? clean[slugs[0]].fans.filter((username) =>
        slugs.every((slug) => clean[slug].fans.includes(username))
      )
    : [];

  return { shared, perFilm: clean };
}

/**
 * Build the match result from a per-film fan scan: intersect fan lists, rank
 * by shared-film percentage, filter by minimum matches.
 *
 * @param {string[]} topFour The user's Top 4 film slugs.
 * @param {Record<string, { count: number|null, scannedPages: number, fans: string[] }>} perFilm
 * @param {number} [minMatches=1] Minimum shared films for a match.
 * @returns {{ matches: Array<{ username: string, sharedFilms: string[], percentage: number }>, scanned: Record<string, { totalFans: number|null, scannedPages: number }> }}
 */
export function buildMatchResult(topFour, perFilm, minMatches = 1) {
  const seen = new Map();

  for (const [slug, { fans }] of Object.entries(perFilm)) {
    for (const fan of fans) {
      const films = seen.get(fan) ?? [];
      films.push(slug);
      seen.set(fan, films);
    }
  }

  const matches = [...seen.entries()]
    .map(([username, sharedFilms]) => ({
      username,
      sharedFilms,
      percentage: Math.round((sharedFilms.length / topFour.length) * 100),
    }))
    .filter((match) => match.sharedFilms.length >= minMatches)
    .sort(
      (a, b) =>
        b.percentage - a.percentage || a.username.localeCompare(b.username)
    );

  const scanned = Object.fromEntries(
    Object.entries(perFilm).map(([slug, { count, scannedPages }]) => [
      slug,
      { totalFans: count, scannedPages },
    ])
  );

  return { matches, scanned };
}
