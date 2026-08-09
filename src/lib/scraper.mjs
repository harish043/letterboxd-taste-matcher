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
// Bounded parallelism for the search pipeline: firing all 15 combo queries at
// once re-triggers Cloudflare challenges on the residential proxy (~8-12 is
// the measured safe sweet spot).
const MAX_SEARCH_CONCURRENCY = 8;

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
 * failures and Cloudflare challenge pages are retried up to `attempts`.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.attempts=MAX_ATTEMPTS] Max fetch attempts before giving up.
 * @returns {Promise<string>} The HTML body.
 * @throws {ProxyTimeoutError|ProxyError|CloudflareBlockedError}
 */
async function fetchHtml(url, { attempts = MAX_ATTEMPTS } = {}) {
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

  for (let attempt = 0; attempt < attempts; attempt++) {
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
        if (attempt < attempts - 1) {
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

      if (attempt < attempts - 1) {
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
 * Fetch a Letterboxd profile page and return the user's Top 4 favorite films
 * (slug, title, release year, poster URL) plus their profile stats.
 *
 * @param {string} username Letterboxd username.
 * @returns {Promise<{ topFour: Array<{ slug: string, title: string, year: string|null, posterUrl: string|null }>, stats: { films: number|null, thisYear: number|null } }>}
 * @throws {LetterboxdNotFoundError} Profile does not exist.
 * @throws {TooFewFavoritesError} Profile exists with fewer than 4 favorites.
 * @throws {ProxyTimeoutError|ProxyError|CloudflareBlockedError} Transport failure.
 */
export async function getTopFour(username) {
  const url = `${BASE_URL}/${username}/`;
  const html = await fetchHtml(url);
  const films = parseTopFour(html);

  if (films.length < 4) {
    // A nonexistent profile returns HTTP 404; distinguish that from a real
    // profile that simply has fewer than four favorites. Letterboxd renders
    // the profile header for existing users even with an empty favourites grid.
    if (html.includes("Letterboxd - Not Found") || !html.includes("profile-header")) {
      throw new LetterboxdNotFoundError(username);
    }
    throw new TooFewFavoritesError(username, films.length);
  }

  // Resolve a poster for each film. The profile only exposes a JS-resolvable
  // poster path, so fetch each film page once and read its og:image — that's
  // a stable CDN URL that returns a real image.
  const topFour = await Promise.all(
    films.map(async (film) => ({
      ...film,
      posterUrl: await getFilmPoster(film.slug),
    }))
  );

  // Stats come from the same profile HTML we already fetched — no extra call.
  const stats = parseProfileStats(html);

  return { topFour, stats };
}

/**
 * Extract the slug, title, and release year of each of a user's Top 4 films
 * from a profile page's HTML. The year is parsed from the title's trailing
 * "(YYYY)" segment (e.g. "High and Low (1963)" -> "1963").
 *
 * @param {string} html Raw profile page HTML.
 * @returns {Array<{ slug: string, title: string, year: string|null }>}
 */
export function parseTopFour(html) {
  const $ = cheerio.load(html);
  const films = [];
  $("#favourites li.griditem div.react-component").each((_, el) => {
    const slug = $(el).attr("data-item-slug");
    const title = $(el).attr("data-item-name") || "";
    const yearMatch = String(title).match(/\((\d{4})\)\s*$/);
    if (slug) films.push({ slug, title, year: yearMatch ? yearMatch[1] : null });
  });
  return films;
}

/**
 * Parse the poster image URL from a film page's og:image meta tag.
 *
 * @param {string} html Raw film page HTML.
 * @returns {string|null} Absolute poster URL, or null if absent.
 */
export function parseFilmPoster(html) {
  const $ = cheerio.load(html);
  const content =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    null;
  return content || null;
}

/**
 * Fetch a film page and return its poster URL (og:image).
 *
 * @param {string} slug Film slug.
 * @returns {Promise<string|null>} Poster URL, or null if it can't be found.
 */
export async function getFilmPoster(slug) {
  try {
    const html = await fetchHtml(`${BASE_URL}/film/${slug}/`, { attempts: 3 });
    return parseFilmPoster(html);
  } catch {
    return null; // poster is cosmetic; never fail the scan for it
  }
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
 * the username in `.metadata`, display name + badge in `.name`, and avatar in
 * `.avatar`.
 *
 * @param {string} html Raw search-results HTML.
 * @returns {Array<{ username: string, displayName: string, avatar: string|null, badge: string|null }>}
 */
export function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("li.search-result.-person").each((_, el) => {
    const href = $(el).find("a.name").attr("href");
    if (!href) return;
    const username = href.replace(/^\//, "").replace(/\/$/, "");
    const nameEl = $(el).find("a.name");
    // Keep only the display name text (badge sits inside the same <a>).
    const displayName = nameEl.clone().find("span.badge").remove().end().text().trim();
    const badge =
      nameEl.find("span.badge").first().text().trim() || null;
    const avatar =
      $(el).find("a.avatar img").attr("src") ||
      $(el).find(".avatar img").attr("src") ||
      null;
    results.push({ username, displayName, avatar, badge });
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
 * Parse the bio text from a profile page. Long bios are truncated on the page
 * with a link to a full-text AJAX endpoint; that URL is returned too so
 * callers can fetch the complete bio when the snippet isn't enough.
 *
 * @param {string} html Raw profile page HTML.
 * @returns {{ bio: string, fullTextUrl: string|null }}
 */
export function parseProfileBio(html) {
  const $ = cheerio.load(html);
  const content = $(".bio .js-bio-content").first();
  const bio = content.length ? content.text().trim() : "";
  const fullTextUrl = content.attr("data-full-text-url") || null;
  return { bio, fullTextUrl };
}

/**
 * Extract the bio text from the full-text AJAX payload. The endpoint is
 * consumed by Letterboxd's own JS, so the shape is not contractual — handle
 * JSON ({ body } / { text } / { content }) and raw text/HTML fragments.
 *
 * @param {string} payload Response body of the full-text endpoint.
 * @returns {string} The full bio text.
 */
function extractFullBioText(payload) {
  if (typeof payload !== "string" || payload.trim() === "") return "";
  let parsed = null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // not JSON — fall through to fragment handling
  }
  if (parsed && typeof parsed === "object") {
    for (const key of ["body", "text", "content"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim() !== "") {
        return parsed[key].trim();
      }
    }
  }
  const $ = cheerio.load(payload);
  return $.root().text().trim();
}

/**
 * Fetch a user's profile and return their bio text. Deliberately bypasses all
 * caching — the bio is the ownership-challenge target and must be read fresh.
 * Long bios are truncated on the page; `fullTextUrl` (when present) lets the
 * caller fetch the complete bio via getFullProfileBio if the token isn't in
 * the snippet.
 *
 * @param {string} username Letterboxd username.
 * @returns {Promise<{ bio: string, fullTextUrl: string|null }>}
 * @throws {LetterboxdNotFoundError|ProxyTimeoutError|ProxyError|CloudflareBlockedError}
 */
export async function getProfileBio(username) {
  const html = await fetchHtml(`${BASE_URL}/${username}/`);
  if (
    html.includes("Letterboxd - Not Found") ||
    !html.includes("profile-header")
  ) {
    throw new LetterboxdNotFoundError(username);
  }
  return parseProfileBio(html);
}

/**
 * Fetch the complete bio from the full-text AJAX endpoint (best-effort).
 *
 * @param {string} fullTextUrl Relative URL from `data-full-text-url`.
 * @returns {Promise<{ bio: string }>}
 * @throws {ProxyTimeoutError|ProxyError|CloudflareBlockedError}
 */
export async function getFullProfileBio(fullTextUrl) {
  const payload = await fetchHtml(`${BASE_URL}${fullTextUrl}`);
  return { bio: extractFullBioText(payload) };
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
 * Find users who share the given Top 4 films using only Letterboxd's
 * member-search engine — no per-match profile fetches. Runs one discrete query
 * per film combination (6 pairs + 4 triples + 1 quad, plus 4 singles when
 * minTier=1). A member returned by a combination is a fan of every film in it,
 * so unioning the combo films across queries yields each match's exact
 * shared-film set. Excludes the searcher.
 *
 * @param {Array<{ slug: string, title: string, year: string|null, posterUrl: string|null }>} topFour The user's Top 4 films.
 * @param {object} [options]
 * @param {string} [options.excludeUsername] Searcher's username (excluded from results).
 * @param {(query: string) => Promise<Array<{ username: string, displayName: string, avatar: string|null }>>} [options.search]
 *   Injectable search fetcher (defaults to searchMembers).
 * @param {number} [options.minTier=1] Smallest film-combination size to query.
 *   1 includes single-film queries (the 1-match tier); 2 skips them, which
 *   drops the 1-match tier but saves 4 of 15 queries.
 * @param {number|null} [options.deadlineAt] Epoch ms. Once passed, no new
 *   queries are issued and the result degrades gracefully to partial matches.
 * @returns {Promise<{ matches: Array<{ username: string, displayName: string, avatar: string|null, sharedFilms: string[], percentage: number }> }>}
 */
export async function searchMatches(
  topFour,
  {
    excludeUsername = null,
    search = searchMembers,
    minTier = 1,
    deadlineAt = null,
  } = {}
) {
  const slugs = topFour.map((film) => film.slug);

  // Every combination of the films, sizes minTier..4. Each is a discrete AND
  // query; a member in the result is a fan of every film in that combination.
  // Depth 1 (single films) is included so users sharing exactly one film are
  // found too — otherwise the 1-film tier would always be empty.
  const combos = [];
  const pick = (start, depth, chosen) => {
    if (chosen.length === depth) {
      combos.push(chosen);
      return;
    }
    for (let i = start; i < slugs.length; i++) {
      pick(i + 1, depth, [...chosen, slugs[i]]);
    }
  };
  const startDepth = Math.min(Math.max(minTier, 1), 4);
  for (let depth = startDepth; depth <= Math.min(4, slugs.length); depth++) {
    pick(0, depth, []);
  }

  const queries = combos.map((combo) => ({
    combo,
    url: buildSearchUrl(combo, combo.length),
  }));

  // Run queries through a bounded pool so the residential proxy stays saturated
  // without being overloaded. A failing query just yields fewer matches.
  const results = new Array(queries.length);
  let cursor = 0;
  async function worker() {
    while (cursor < queries.length) {
      // Stop issuing new queries once the deadline passes; the response
      // degrades to whatever completed in time.
      if (deadlineAt && Date.now() >= deadlineAt) break;
      const i = cursor++;
      try {
        results[i] = {
          status: "fulfilled",
          value: await search(queries[i].url),
        };
      } catch (error) {
        results[i] = { status: "rejected", reason: error };
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_SEARCH_CONCURRENCY, queries.length || 1) },
      worker
    )
  );

  const byUsername = new Map();
  results.forEach((result, i) => {
    if (result?.status !== "fulfilled") return;
    const combo = queries[i].combo;
    for (const member of result.value) {
      if (excludeUsername && member.username === excludeUsername) continue;
      const entry = byUsername.get(member.username) ?? {
        username: member.username,
        displayName: member.displayName,
        avatar: member.avatar,
        badge: member.badge ?? null,
        films: new Set(),
      };
      for (const slug of combo) entry.films.add(slug);
      byUsername.set(member.username, entry);
    }
  });

  const matches = [...byUsername.values()]
    .map(({ username, displayName, avatar, badge, films }) => {
      const sharedFilms = slugs.filter((slug) => films.has(slug));
      return {
        username,
        displayName,
        avatar,
        badge,
        sharedFilms,
        percentage: Math.round((sharedFilms.length / slugs.length) * 100),
      };
    })
    .sort(
      (a, b) =>
        b.percentage - a.percentage || a.username.localeCompare(b.username)
    );

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
