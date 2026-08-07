import { getTopFourSlugs, getSharedFans } from "@/lib/scraper";

export const runtime = "nodejs";
export const maxDuration = 60;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;
const MAX_PAGES_PER_FILM = 3;

type Match = {
  username: string;
  sharedFilms: string[];
  percentage: number;
};

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
      : MAX_PAGES_PER_FILM;
  const delayMs =
    typeof body.delayMs === "number" && body.delayMs >= 0
      ? Math.min(body.delayMs, 10000)
      : undefined;
  const minMatches =
    typeof body.minMatches === "number" && body.minMatches >= 1
      ? Math.min(Math.floor(body.minMatches), 4)
      : 1;

  try {
    const topFour = await getTopFourSlugs(username);
    const { perFilm } = await getSharedFans(topFour, {
      maxPagesPerFilm,
      delayMs,
    });

    const seen = new Map<string, string[]>();

    for (const [slug, { fans }] of Object.entries(perFilm)) {
      for (const fan of fans) {
        const films = seen.get(fan) ?? [];
        films.push(slug);
        seen.set(fan, films);
      }
    }

    const matches: Match[] = [...seen.entries()]
      .map(([fan, films]) => ({
        username: fan,
        sharedFilms: films,
        percentage: Math.round((films.length / topFour.length) * 100),
      }))
      .filter((match) => match.sharedFilms.length >= minMatches)
      .sort(
        (a, b) =>
          b.percentage - a.percentage || a.username.localeCompare(b.username)
      );

    return Response.json({
      username,
      topFour,
      matchCount: matches.length,
      matches,
      scanned: Object.fromEntries(
        Object.entries(perFilm).map(([slug, { count, scannedPages }]) => [
          slug,
          { totalFans: count, scannedPages },
        ])
      ),
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
