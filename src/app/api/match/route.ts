import { getTopFourSlugs, getSharedFans, buildMatchResult } from "@/lib/scraper.mjs";

export const runtime = "nodejs";
export const maxDuration = 60;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;
const MAX_PAGES_PER_FILM = 20;
const DEFAULT_PAGES_PER_FILM = 15;
const DEFAULT_CONCURRENCY = 8;

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

  // In production the scraping runs on a dedicated VM (scraper-service/) whose
  // residential/datacenter egress isn't blocked by Letterboxd's Cloudflare.
  // When SCRAPER_URL is set, proxy the request there instead of scraping from
  // the serverless function (whose datacenter IPs are always challenged).
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
    const topFour = await getTopFourSlugs(username);
    const { perFilm } = await getSharedFans(topFour, {
      maxPagesPerFilm,
      delayMs,
      concurrency: DEFAULT_CONCURRENCY,
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
    const message =
      error instanceof Error ? error.message : "Unknown scraping error.";

    if (message.includes("No favorites section")) {
      return Response.json(
        { error: `Username "${username}" not found or has no Top 4.` },
        { status: 404 }
      );
    }

    return Response.json({ error: message }, { status: 502 });
  }
}
