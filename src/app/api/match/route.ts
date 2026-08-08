import {
  getTopFourSlugs,
  getSharedFans,
  fetchFansPage,
  buildMatchResult,
  LetterboxdNotFoundError,
  TooFewFavoritesError,
  CloudflareBlockedError,
  ProxyTimeoutError,
  ProxyError,
} from "@/lib/scraper.mjs";
import { unstable_cache } from "next/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;
const MAX_PAGES_PER_FILM = 20;
const DEFAULT_PAGES_PER_FILM = 10;
const DEFAULT_CONCURRENCY = 8;

// --- Rate limiting ----------------------------------------------------------
// In-memory sliding-window limiter keyed by client IP. Vercel serverless
// instances are per-invocation, so this is best-effort (each instance keeps its
// own counter and instances can run in parallel) — but it comfortably blunts a
// feedback spike from Reddit without adding a distributed store. The heavy
// operation here is the residential-proxy scrape, so throttling requests
// protects the proxy budget.
const RATE_LIMIT_MAX = 5; // requests per window per IP
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** ip -> sorted request timestamps (ms) within the current window. */
const rateLimitHits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

/**
 * Record a request for the given IP. Returns the Retry-After (seconds) if the
 * request is over the limit, otherwise null and records the request.
 */
function checkRateLimit(ip: string): number | null {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const recent = (rateLimitHits.get(ip) ?? []).filter(
    (t) => t > windowStart
  );

  if (recent.length >= RATE_LIMIT_MAX) {
    const oldest = recent[0];
    const retryAfter = Math.max(
      1,
      Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000)
    );
    rateLimitHits.set(ip, recent);
    return retryAfter;
  }

  recent.push(now);
  rateLimitHits.set(ip, recent);
  return null;
}
// ----------------------------------------------------------------------------

// Fan lists change slowly (only when users edit their Top 4), so cache each
// parsed (slug, page) for a day by default. Every scan that touches a cached
// film reuses these instead of paying the residential proxy again. Only
// successful fetches are cached — a thrown error is never stored, so transient
// proxy failures can't poison the cache. `unstable_cache` (not `use cache`)
// because the latter's default in-memory handler does not persist across
// serverless requests on Vercel.
const FANS_CACHE_TTL_SECONDS = Number(
  process.env.FANS_CACHE_TTL_SECONDS ?? 86400
);
// A user's Top 4 changes less often still, but people do edit it — keep it
// fresher than the fan lists (30 min; long enough to cache, short enough that
// adding a 4th favorite is reflected quickly).
const PROFILE_CACHE_TTL_SECONDS = Number(
  process.env.PROFILE_CACHE_TTL_SECONDS ?? 1800
);

const getCachedFansPage = unstable_cache(
  async (slug: string, page: number) => fetchFansPage(slug, page),
  ["fans-page"],
  { revalidate: FANS_CACHE_TTL_SECONDS }
);

const getCachedTopFour = unstable_cache(
  async (username: string) => getTopFourSlugs(username),
  ["top-four"],
  { revalidate: PROFILE_CACHE_TTL_SECONDS }
);

export async function POST(request: Request) {
  const ip = clientIp(request);
  const retryAfter = checkRateLimit(ip);
  if (retryAfter !== null) {
    return Response.json(
      {
        error:
          "Too many requests from your network. Please wait a few minutes and try again.",
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }

  let body: {
    username?: string;
    maxPagesPerFilm?: number;
    delayMs?: number;
    minMatches?: number;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body. Expected { \"username\": string }." },
      { status: 400 }
    );
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";

  if (!username) {
    return Response.json(
      { error: "Missing required field: username." },
      { status: 400 }
    );
  }

  if (!USERNAME_REGEX.test(username)) {
    return Response.json(
      {
        error:
          "Invalid username. Only letters, numbers, and underscores (1–30 characters) are allowed.",
      },
      { status: 400 }
    );
  }

  const maxPagesPerFilm =
    typeof body.maxPagesPerFilm === "number" && body.maxPagesPerFilm > 0
      ? Math.min(Math.floor(body.maxPagesPerFilm), MAX_PAGES_PER_FILM)
      : DEFAULT_PAGES_PER_FILM;
  const delayMs =
    typeof body.delayMs === "number" && body.delayMs >= 0
      ? Math.min(body.delayMs, 10000)
      : undefined;
  const minMatches =
    typeof body.minMatches === "number" && body.minMatches >= 1
      ? Math.min(Math.floor(body.minMatches), 4)
      : 1;

  // Optional: delegate scraping to a self-hosted scraper service (SCRAPER_URL).
  // When unset, this function scrapes directly through the residential proxy
  // configured in SCRAPER_PROXY.
  const scraperUrl = process.env.SCRAPER_URL;
  if (scraperUrl) {
    try {
      const res = await fetch(`${scraperUrl.replace(/\/$/, "")}/match`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(process.env.SCRAPER_TOKEN
            ? { Authorization: `Bearer ${process.env.SCRAPER_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          username,
          maxPagesPerFilm,
          delayMs,
          minMatches,
          concurrency: DEFAULT_CONCURRENCY,
        }),
        signal: AbortSignal.timeout(55000),
      });
      const data = await res.json();
      return Response.json(data, { status: res.status });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Scraper service unreachable.";
      return Response.json(
        { error: `Scraper service error: ${message}` },
        { status: 502 }
      );
    }
  }

  try {
    const topFour = await getCachedTopFour(username);
    const { perFilm } = await getSharedFans(topFour, {
      maxPagesPerFilm,
      delayMs,
      concurrency: DEFAULT_CONCURRENCY,
      fetchPage: getCachedFansPage,
    });

    const { matches, scanned } = buildMatchResult(topFour, perFilm, minMatches);

    return Response.json({
      username,
      topFour,
      matchCount: matches.length,
      matches,
      scanned,
    });
  } catch (error) {
    if (error instanceof LetterboxdNotFoundError) {
      return Response.json(
        {
          error: `We couldn't find the Letterboxd profile "${username}". Double-check the username and try again.`,
        },
        { status: 404 }
      );
    }

    if (error instanceof TooFewFavoritesError) {
      return Response.json(
        {
          error: `The profile "${username}" needs at least 4 favorite films on Letterboxd to find matches (it currently has fewer). Add favorites and try again.`,
        },
        { status: 400 }
      );
    }

    if (error instanceof CloudflareBlockedError) {
      // Upstream protection (Cloudflare) throttled our proxy egress after all
      // retries. This is rate-limiting, not the profile being private.
      return Response.json(
        {
          error:
            "The scraper was temporarily rate-limited by upstream protection. Please try again in a few moments.",
        },
        { status: 429 }
      );
    }

    if (error instanceof ProxyTimeoutError) {
      return Response.json(
        { error: "The match request timed out. Please try again." },
        { status: 504 }
      );
    }

    if (error instanceof ProxyError) {
      return Response.json(
        { error: "The proxy could not complete the request. Please try again." },
        { status: 502 }
      );
    }

    const message =
      error instanceof Error ? error.message : "Unknown scraping error.";
    return Response.json({ error: message }, { status: 502 });
  }
}
