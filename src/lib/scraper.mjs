import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const BASE_URL = "https://letterboxd.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Hard per-fetch timeout. Residential proxies charge per open connection and
// Vercel functions time out, so a slow/hung page must abort quickly.
const FETCH_TIMEOUT_MS = 15000;
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
 * @returns {Promise<string>} The HTML body.
 * @throws {ProxyTimeoutError|ProxyError|LetterboxdForbiddenError}
 */
async function fetchHtml(url) {
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
    "--max-time",
    String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    ...(proxy ? ["--proxy", proxy] : []),
    ...browserHeaders,
    url,
  ];

  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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
        if (attempt < MAX_ATTEMPTS - 1) {
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

      if (attempt < MAX_ATTEMPTS - 1) await sleep(500);
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
async function fetchFansPage(slug, page) {
  const url =
    page === 1
      ? `${BASE_URL}/film/${slug}/fans/`
      : `${BASE_URL}/film/${slug}/fans/page/${page}/`;
  const html = await fetchHtml(url);
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
      { count: null, scannedPages: 0, done: false, fans: new Set() },
    ])
  );

  // Worker-pool fetch: schedule every (film, page) fetch up front and run them
  // through a bounded pool so the residential proxy is kept saturated without
  // overloading it (which re-triggers Cloudflare challenges).
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
        const { usernames, hasNext, count } = await fetchFansPage(slug, page);
        if (perFilm[slug].done) continue; // lost a race with page 1's hasNext
        for (const username of usernames) perFilm[slug].fans.add(username);
        if (count != null) perFilm[slug].count = count;
        perFilm[slug].scannedPages = Math.max(perFilm[slug].scannedPages, page);
        if (!hasNext) perFilm[slug].done = true;
      } catch {
        // Skip individual page failures; the film's other pages still get
        // processed. Per-page retries happen inside fetchHtml.
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
