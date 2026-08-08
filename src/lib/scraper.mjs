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

/**
 * Generate a fresh proxy session id. Called when a sticky session's IP gets
 * flagged by Cloudflare, so the next attempt abandons the dead IP and lets the
 * proxy assign a new one.
 *
 * @returns {string} e.g. "m1abcde-9f3k"
 */
export function generateSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
}

// proxying.io sticky sessions: append `_session-<id>` to the password so the
// proxy keeps the same egress IP for the lifetime of this process. If the URL
// already carries a session option, leave it untouched.
function applyStickySession(proxyUrl, sessionId = STICKY_SESSION_ID) {
  if (!proxyUrl) return proxyUrl;
  if (/_session-[A-Za-z0-9]+/.test(proxyUrl)) return proxyUrl;
  const match = proxyUrl.match(/^(https?:\/\/)([^:/@]+):([^@]*)@(.*)$/);
  if (!match) return proxyUrl;
  const [, scheme, user, pass, host] = match;
  return `${scheme}${user}:${pass}_session-${sessionId}@${host}`;
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

/**
 * Cloudflare served a challenge/403 that persisted through all retries. This
 * is throttling/rate-limiting of the proxy egress, NOT proof the profile is
 * private — distinguish it so users aren't told their profile is inaccessible.
 */
export class CloudflareBlockedError extends Error {
  constructor(url) {
    super(`Upstream protection blocked request to ${url}.`);
    this.name = "CloudflareBlockedError";
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
 * @throws {ProxyTimeoutError|ProxyError|CloudflareBlockedError}
 */
async function fetchHtml(url) {
  const baseProxy = process.env.SCRAPER_PROXY;
  // Start with the process's sticky session; rotate on block (see below).
  let sessionId = STICKY_SESSION_ID;

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

  const buildCurlArgs = (proxy) => [
    "-sS", // silent, but surface errors
    "--http1.1",
    // Request gzip/deflate and auto-decompress. Cuts each fans page from
    // ~109KB to ~21KB (~80% less residential-proxy bandwidth).
    "--compressed",
    "--max-time",
    String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
    ...(proxy ? ["--proxy", proxy] : []),
    ...browserHeaders,
    url,
  ];

  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Rebuild the proxy URL each attempt so a blocked session is abandoned in
    // favor of a fresh one on the next try.
    const proxy = applyStickySession(baseProxy, sessionId);
    const curlArgs = buildCurlArgs(proxy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const result = await execFileP(resolveCurlBinary(), curlArgs, {
        maxBuffer: 10 * 1024 * 1024,
        signal: controller.signal,
      });

      // A 403 challenge page arrives as a successful curl run (HTTP 200-ish
      // body with "Just a moment..."). Treat it as retryable; if it persists,
      // the proxy egress IP is being throttled — not the profile being private.
      if (result.stdout.includes("Just a moment")) {
        lastError = new Error("Cloudflare challenge");
        if (attempt < MAX_ATTEMPTS - 1) {
          // The current session's IP is flagged; rotate before retrying.
          sessionId = generateSessionId();
          await sleep(600);
          continue;
        }
        throw new CloudflareBlockedError(url);
      }

      return result.stdout;
    } catch (error) {
      clearTimeout(timer);

      if (error?.name === "AbortError" || controller.signal.aborted) {
        lastError = new ProxyTimeoutError(url);
      } else {
        lastError = new ProxyError(url, error.message);
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        // Timeout/connection drop may mean the current IP is bad; rotate.
        sessionId = generateSessionId();
        await sleep(500);
      }
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
 * @throws {ProxyTimeoutError|ProxyError|CloudflareBlockedError} Transport failure.
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
 * Build the URL of a film's fans page. Always uses the paginated form, even
 * for page 1 — the bare `/film/{slug}/fans/` URL triggers a Cloudflare
 * challenge nearly 100% of the time, while `/fans/page/1/` returns the same
 * content with a 200.
 *
 * @param {string} slug Film slug.
 * @param {number} page 1-indexed page number.
 * @returns {string} Absolute URL.
 */
export function buildFansPageUrl(slug, page) {
  return `${BASE_URL}/film/${slug}/fans/page/${page}/`;
}

/**
 * Build a Letterboxd member-search URL that finds users who are fans of at
 * least `minMatches` of the given films. Uses Letterboxd's own search engine
 * (`fan:<film>` operators OR'd together), which is far cheaper and more
 * complete than scraping every fan page — the search returns the members whose
 * Top 4 overlaps with the query.
 *
 * @param {string[]} slugs Film slugs (the user's Top 4).
 * @param {number} [minMatches=2] How many shared films to require.
 * @returns {string} The member-search URL (encoded, proxy-safe).
 */
export function buildSearchUrl(slugs, minMatches = 2) {
  const combinations = [];
  const pick = (start, depth, chosen) => {
    if (chosen.length === depth) {
      combinations.push(chosen);
      return;
    }
    for (let i = start; i < slugs.length; i++) {
      pick(i + 1, depth, [...chosen, slugs[i]]);
    }
  };
  pick(0, minMatches, []);

  const terms = combinations.map((combo) => `fan:${combo.join("+fan:")}`);
  // The search query uses `OR` (space-separated when URL-encoded). Parenthesize
  // each term so the OR applies across combos.
  const query = terms.map((t) => `(${t})`).join("%20OR%20");
  return `${BASE_URL}/s/search/members/${query}/`;
}

/**
 * Parse a member-search results page (the AJAX fragment returned by
 * `/s/search/members/.../`). Each result is a `li.search-result -person` with
 * the username in `.metadata` and display name + avatar in `.name` / `.avatar`.
 *
 * @param {string} html Raw search-results HTML.
 * @returns {Array<{ username: string, displayName: string, avatar: string|null }>}
 */
export function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("li.search-result.-person").each((_, el) => {
    const href = $(el).find("a.name").attr("href");
    if (!href) return;
    const username = href.replace(/^\//, "").replace(/\/$/, "");
    const displayName = $(el).find("a.name").text().trim();
    const avatar =
      $(el).find("a.avatar img").attr("src") ||
      $(el).find(".avatar img").attr("src") ||
      null;
    results.push({ username, displayName, avatar });
  });
  return results;
}

/**
 * Parse the activity stats from a user's profile page: total films watched and
 * films logged this year (diary). Both live in `.profile-stats`.
 *
 * @param {string} html Raw profile page HTML.
 * @returns {{ films: number|null, thisYear: number|null }}
 */
export function parseProfileStats(html) {
  const $ = cheerio.load(html);
  const stats = { films: null, thisYear: null };
  $(".profile-stats h4.profile-statistic").each((_, el) => {
    const value = $(el).find(".value").text().trim().replace(/,/g, "");
    const label = $(el).find(".definition").text().trim().toLowerCase();
    if (!value || !label) return;
    const num = Number(value);
    if (Number.isNaN(num)) return;
    if (label === "films") stats.films = num;
    else if (label.includes("this year")) stats.thisYear = num;
  });
  return stats;
}

/**
 * Fetch one fans page and return the usernames on it.
 *
 * @param {string} slug
 * @param {number} page 1-indexed page number.
 * @returns {Promise<{ usernames: string[], hasNext: boolean, count: number|null }>}
 */
export async function fetchFansPage(slug, page) {
  const html = await fetchHtml(buildFansPageUrl(slug, page));
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
 * @param {(slug: string, page: number) => Promise<{ usernames: string[], hasNext: boolean, count: number|null }>} [options.fetchPage]
 *   Per-page fetcher, injectable for caching. Defaults to fetchFansPage.
 * @returns {Promise<{ shared: string[], perFilm: Record<string, { count: number|null, scannedPages: number, fans: string[] }> }>}
 */
export async function getSharedFans(
  slugs,
  {
    maxPagesPerFilm = 5,
    delayMs = 1500,
    concurrency = 8,
    fetchPage = fetchFansPage,
  } = {}
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
        const { usernames, hasNext, count } = await fetchPage(slug, page);
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
 * Fetch a user's profile once and return their Top 4 slugs plus activity stats.
 * Used by the search pipeline to enrich matches.
 *
 * @param {string} username
 * @returns {Promise<{ topFour: string[], stats: { films: number|null, thisYear: number|null } }>}
 * @throws {LetterboxdNotFoundError|TooFewFavoritesError|ProxyTimeoutError|ProxyError|CloudflareBlockedError}
 */
export async function getProfile(username) {
  const html = await fetchHtml(`${BASE_URL}/${username}/`, { attempts: 3 });
  const topFour = parseTopFourSlugs(html);
  if (topFour.length < 4) {
    if (
      html.includes("Letterboxd - Not Found") ||
      !html.includes("profile-header")
    ) {
      throw new LetterboxdNotFoundError(username);
    }
    throw new TooFewFavoritesError(username, topFour.length);
  }
  return { topFour, stats: parseProfileStats(html) };
}

/**
 * Find users who share the given Top 4 films, using Letterboxd's member-search
 * engine. Searches every tier (4/4, 3+, 2+, 1+) so results are mutually
 * exclusive by exact shared-film count, excludes the searcher's own profile,
 * and enriches each unique match with their display name, avatar, exact shared
 * films, percentage, and activity stats.
 *
 * @param {string[]} topFour The user's Top 4 film slugs.
 * @param {object} [options]
 * @param {string} [options.excludeUsername] Searcher's username (excluded from results).
 * @param {number} [options.maxTiers=4] Highest tier to search (4, 3, 2, 1).
 * @param {(query: string) => Promise<Array<{ username: string, displayName: string, avatar: string|null }>>} [options.search]
 *   Injectable search fetcher (defaults to searchMembers).
 * @param {(username: string) => Promise<{ topFour: string[], stats: { films: number|null, thisYear: number|null } }>} [options.profile]
 *   Injectable profile fetcher (defaults to getProfile), used to enrich matches.
 * @returns {Promise<{ matches: Array<{ username: string, displayName: string, avatar: string|null, sharedFilms: string[], percentage: number, stats: { films: number|null, thisYear: number|null } }> }>}
 */
export async function searchMatches(
  topFour,
  {
    excludeUsername = null,
    maxTiers = 4,
    search = searchMembers,
    profile = getProfile,
  } = {}
) {
  // Search each tier and dedupe usernames across tiers. Each tier is a distinct
  // query, so a user matching 3 films appears in the 3+ tier but the exact
  // shared-film count is computed below from their real Top 4 — tiers stay
  // mutually exclusive by that exact count.
  const byUsername = new Map();
  for (let tier = maxTiers; tier >= 1; tier--) {
    const query = buildSearchUrl(topFour, tier);
    let results;
    try {
      results = await search(query);
    } catch {
      continue; // a failing tier shouldn't sink the whole scan
    }
    for (const result of results) {
      if (excludeUsername && result.username === excludeUsername) continue;
      if (!byUsername.has(result.username)) {
        byUsername.set(result.username, result);
      }
    }
  }

  const matches = [];
  for (const result of byUsername.values()) {
    try {
      const { topFour: theirTopFour, stats } = await profile(result.username);
      const sharedFilms = topFour.filter((slug) =>
        theirTopFour.includes(slug)
      );
      matches.push({
        username: result.username,
        displayName: result.displayName,
        avatar: result.avatar,
        sharedFilms,
        percentage: Math.round((sharedFilms.length / topFour.length) * 100),
        stats,
      });
    } catch {
      // Profile fetch failed (proxy hiccup / rare). Skip the match.
    }
  }

  return { matches };
}

/**
 * Fetch a member-search URL and parse the results. Standalone so the route can
 * wrap it in `unstable_cache`.
 *
 * @param {string} query A URL returned by buildSearchUrl.
 * @returns {Promise<Array<{ username: string, displayName: string, avatar: string|null }>>}
 */
export async function searchMembers(query) {
  const html = await fetchHtml(query, { attempts: 3 });
  return parseSearchResults(html);
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
