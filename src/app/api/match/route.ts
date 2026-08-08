import {
  getTopFourSlugs,
  getSharedFans,
  fetchFansPage,
  buildMatchResult,
  LetterboxdNotFoundError,
  TooFewFavoritesError,
  LetterboxdForbiddenError,
  ProxyTimeoutError,
  ProxyError,
} from "@/lib/scraper.mjs";
import { unstable_cache } from "next/cache";

export const runtime = "nodejs";
export const maxDuration = 60;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;
const MAX_PAGES_PER_FILM = 20;
const DEFAULT_PAGES_PER_FILM = 10;
// Measured sweet spot: higher concurrency saturates the proxy and re-triggers
// failures; lower leaves latency on the table. 12 ≈ 21s for 60 pages (vs 34s
// at 8).
const DEFAULT_CONCURRENCY = 12;

// Fan lists change slowly (only when users edit their Top 4), so cache each
// parsed (slug, page) for a day by default. Every scan that touches a cached
// film reuses these instead of paying the residential proxy again. Only
// successful fetches are cached — a thrown error is never stored, so transient
// proxy failures can't poison the cache.
const FANS_CACHE_TTL_SECONDS = Number(
  process.env.FANS_CACHE_TTL_SECONDS ?? 86400
);
// A user's Top 4 changes less often still, but people do edit it — keep it
// fresher than the fan lists.
const PROFILE_CACHE_TTL_SECONDS = Number(
  process.env.PROFILE_CACHE_TTL_SECONDS ?? 3600
);

const getCachedFansPage = unstable_cache(
  async (slug: string, page: number) =>
    fetchFansPage(slug, page, { attempts: 6 }),
  ["fans-page"],
  { revalidate: FANS_CACHE_TTL_SECONDS }
);

const getCachedTopFour = unstable_cache(
  async (username: string) => getTopFourSlugs(username),
  ["top-four"],
  { revalidate: PROFILE_CACHE_TTL_SECONDS }
);

export async function POST(request: Request) {
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

    if (error instanceof LetterboxdForbiddenError) {
      return Response.json(
        {
          error: `The profile "${username}" is private or inaccessible. Make sure the profile is public.`,
        },
        { status: 403 }
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
