import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const BASE_URL = "https://letterboxd.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Hard per-fetch timeout. Residential proxies charge per open connection and
// Vercel functions time out, so a slow/hung page must abort quickly. Most
// successful responses arrive in 2–4s; 10s catches stragglers without letting
// a hung connection eat the whole function budget.
const FETCH_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stable per-process id used to pin a sticky proxy session across requests.
const STICKY_SESSION_ID = Date.now().toString(36);

// proxying.io sticky sessions: append `_session-<id>` to the password so the
// proxy keeps the same egress IP for the lifetime of this process. If the URL
// already carries a session option, leave it untouched.
function applyStickySession(proxyUrl) {
  if (!proxyUrl) return proxyUrl;
  if (/_session-[A-Za-z0-9]+/.test(proxyUrl)) return proxyUrl;
  const match = proxyUrl.match(/^(https?:\/\/)([^:/@]+):([^@]*)@(.*)$/);
  if (!match) return proxyUrl;
  const [, scheme, user, pass, host] = match;
  return `${scheme}${user}:${pass}_session-${STICKY_SESSION_ID}@${host}`;
}

// ---------------------------------------------------------------------------
// Typed errors so the API route can map to the right HTTP status.
// ---------------------------------------------------------------------------

/** Letterboxd returned 404 — the profile does not exist. */
export class LetterboxdNotFoundError extends Error {
  constructor(username) {
    super(`Profile "${username}" not found.`);
    this.name = "LetterboxdNotFoundError";
  }
}

/** The profile exists but has fewer than 4 favorite films. */
export class TooFewFavoritesError extends Error {
  constructor(username, count) {
    super(
      `Profile "${username}" needs at least 4 favorite films (has ${count}).`
    );
    this.name = "TooFewFavoritesError";
  }
}

/** Cloudflare blocked the request (403) after retries — private/inaccessible. */
export class LetterboxdForbiddenError extends Error {
  constructor(username) {
    super(`Profile "${username}" is private or inaccessible.`);
    this.name = "LetterboxdForbiddenError";
  }
}

/** The proxy timed out. */
export class ProxyTimeoutError extends Error {
  constructor(url) {
    super(`Request to ${url} timed out.`);
    this.name = "ProxyTimeoutError";
  }
}

/** The proxy dropped the connection or returned an error. */
export class ProxyError extends Error {
  constructor(url, cause) {
    super(`Proxy request to ${url} failed: ${cause}`);
    this.name = "ProxyError";
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Resolve the curl binary. No custom/native packages are bundled — Windows uses
 * the system curl.exe; Linux uses the system `curl` on PATH. Override with
 * LETTERBOXD_CURL_BIN if the runtime lacks curl.
 */
function resolveCurlBinary() {
  const override = process.env.LETTERBOXD_CURL_BIN;
  if (override) return override;

  if (process.env.OS === "Windows_NT") return "curl.exe";

  return "curl";
}

/**
 * Fetch a URL's HTML. When SCRAPER_PROXY is set (residential proxy on Vercel),
 * route through it with plain browser headers — the proxy's residential egress
 * IP is what passes Letterboxd's Cloudflare. Without a proxy (local dev on
 * Windows), use the system curl directly.
 *
 * Every attempt runs under an AbortController with a strict timeout so a hung
 * proxy connection is aborted instead of consuming paid bandwidth. Transient
 * failures and Cloudflare challenge pages are retried up to MAX_ATTEMPTS.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.attempts] Max fetch attempts (defaults to MAX_ATTEMPTS).
 *   Fans-page fetches pass attempts=1 because the worker pool already tolerates
 *   a dropped page — retrying here just burns the function budget.
 * @returns {Promise<string>} The HTML body.
 * @throws {ProxyTimeoutError|ProxyError|LetterboxdForbiddenError}
 */
async function fetchHtml(url, { attempts = MAX_ATTEMPTS } = {}) {
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

  const curlArgs = [
    "-sS", // silent, but surface errors
    "--http1.1",
    // On Windows, curl uses the schannel TLS backend, which is prone to
    // spurious "server closed abruptly (missing close_notify)" failures and
    // TLS handshake errors on some proxies. --ssl-no-revoke skips certificate
    // revocation checks and is ignored by OpenSSL builds (Linux/Vercel), so it
    // is safe everywhere.
    "--ssl-no-revoke",
    "--max-time",
    String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    ...(proxy ? ["--proxy", proxy] : []),
    ...browserHeaders,
    url,
  ];

  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const result = await execFileP(resolveCurlBinary(), curlArgs, {
        maxBuffer: 10 * 1024 * 1024,
        signal: controller.signal,
      });

      // A 403 challenge page arrives as a successful curl run (HTTP 200-ish
      // body with "Just a moment..."). Treat it as retryable; if it persists,
      // report the profile as inaccessible.
      if (result.stdout.includes("Just a moment")) {
        lastError = new Error("Cloudflare challenge");
        if (attempt < attempts - 1) {
          await sleep(600);
          continue;
        }
        throw new LetterboxdForbiddenError("profile");
      }

      return result.stdout;
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof LetterboxdForbiddenError) throw error;

      if (error?.name === "AbortError" || controller.signal.aborted) {
        lastError = new ProxyTimeoutError(url);
      } else {
        lastError = new ProxyError(url, error.message);
      }

      if (attempt < attempts - 1) await sleep(500);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/**
 * Fetch a Letterboxd profile page and return the URL slugs of the user's
 * Top 4 favorite films.
 *
 * @param {string} username Letterboxd username.
 * @returns {Promise<string[]>} Array of 4 film slugs, e.g. ["high-and-low", ...].
 * @throws {LetterboxdNotFoundError} Profile does not exist.
 * @throws {TooFewFavoritesError} Profile exists with fewer than 4 favorites.
 * @throws {ProxyTimeoutError|ProxyError|LetterboxdForbiddenError} Transport failure.
 */
export async function getTopFourSlugs(username) {
  const url = `${BASE_URL}/${username}/`;
  const html = await fetchHtml(url);
  const slugs = parseTopFourSlugs(html);

  if (slugs.length < 4) {
    // A nonexistent profile returns HTTP 404; distinguish that from a real
    // profile that simply has fewer than four favorites. Letterboxd renders
    // the profile header for existing users even with an empty favourites grid.
    if (html.includes("Letterboxd - Not Found") || !html.includes("profile-header")) {
      throw new LetterboxdNotFoundError(username);
    }
    throw new TooFewFavoritesError(username, slugs.length);
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
 * @returns {Promise<{ usernames: string[], hasNext: boolean, count: number|null }>}
 */
async function fetchFansPage(slug, page, { attempts = 1 } = {}) {
  // Always use the paginated URL form — even for page 1. The bare `/fans/` URL
  // triggers a Cloudflare challenge nearly 100% of the time, while
  // `/fans/page/1/` returns the same content with a 200.
  const url = `${BASE_URL}/film/${slug}/fans/page/${page}/`;
  // Default to a single attempt: the worker pool skips a dropped page anyway,
  // so retrying here (up to 10s per attempt) would only burn the function
  // budget. Callers that need the fan count pass attempts: 3.
  const html = await fetchHtml(url, { attempts });
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
 * @returns {Promise<{ shared: string[], perFilm: Record<string, { count: number|null, scannedPages: number, fans: string[] }> }>}
 */
export async function getSharedFans(
  slugs,
  { maxPagesPerFilm = 5, delayMs = 1500, concurrency = 8 } = {}
) {
  const perFilm = Object.fromEntries(
    slugs.map((slug) => [
      slug,
      { count: null, totalPages: null, scannedPages: 0, fans: new Set() },
    ])
  );

  // Phase 1: fetch page 1 of every film first. It carries the fan count (in the
  // sub-nav), which tells us the total number of pages for that film. The fans
  // list is sorted alphabetically by username, so taking only the first pages
  // would bias matches toward accounts starting with digits/a-f. We instead
  // spread the page budget evenly across the entire list (phase 2).
  const firstPageResults = await Promise.all(
    slugs.map(async (slug) => {
      try {
        // Page 1 is load-bearing: it carries the fan count that determines the
        // spread schedule. Give it the full retry budget.
        const { usernames, hasNext, count } = await fetchFansPage(slug, 1, {
          attempts: 3,
        });
        return { slug, usernames, hasNext, count };
      } catch {
        return { slug, usernames: [], hasNext: false, count: null };
      }
    })
  );

  const tasks = [];

  for (const { slug, usernames, count } of firstPageResults) {
    for (const username of usernames) perFilm[slug].fans.add(username);
    if (count != null) perFilm[slug].count = count;
    perFilm[slug].scannedPages = Math.max(perFilm[slug].scannedPages, 1);

    if (count != null) {
      // Letterboxd caps the fans list at 256 pages (6,400 fans) even for
      // films with far more fans; pages beyond that return empty. Clamp so we
      // never schedule unreachable pages.
      perFilm[slug].totalPages = Math.min(256, Math.max(1, Math.ceil(count / 25)));
    }

    // Schedule the remaining pages as an even spread across the whole list so
    // every part of the alphabet is represented. 25 fans per page.
    const totalPages = perFilm[slug].totalPages ?? maxPagesPerFilm;
    const remaining = Math.max(0, maxPagesPerFilm - 1);
    for (let i = 1; i <= remaining; i++) {
      let page;
      if (totalPages <= 1) {
        page = 1; // degenerate: single-page film; re-fetch is cheap and deduped
      } else {
        // Spread i over (1, totalPages] so the last page is included.
        page = Math.round(1 + (i * (totalPages - 1)) / remaining);
        page = Math.max(2, Math.min(totalPages, page));
      }
      tasks.push({ slug, page });
    }
  }

  // Phase 2: worker-pool fetch the spread pages.
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const { slug, page } = tasks[cursor++];
      try {
        const { usernames } = await fetchFansPage(slug, page, { attempts: 1 });
        for (const username of usernames) perFilm[slug].fans.add(username);
        perFilm[slug].scannedPages = Math.max(perFilm[slug].scannedPages, page);
      } catch {
        // Skip individual page failures; a single dropped page is tolerable.
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
