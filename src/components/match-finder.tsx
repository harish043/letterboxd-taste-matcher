"use client";

import { useRef, useState } from "react";
import Link from "next/link";

type Match = {
  username: string;
  displayName?: string;
  avatar?: string | null;
  sharedFilms: string[];
  percentage: number;
  stats?: { films: number | null; thisYear: number | null };
};

type ScannedFilm = {
  totalFans: number | null;
  scannedPages: number;
};

type MatchResult = {
  username: string;
  topFour: string[];
  matchCount: number;
  matches: Match[];
  scanned: Record<string, ScannedFilm> | null;
};

type Status = "idle" | "loading" | "success" | "error";

const DEFAULT_OPTIONS = { maxPagesPerFilm: 10, delayMs: 0 };

const FILTER_OPTIONS = [
  { value: 2, label: "2+ Matches" },
  { value: 3, label: "3+ Matches" },
  { value: 4, label: "4/4 Only" },
  { value: 1, label: "All (1+)" },
];

export default function MatchFinder() {
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = username.trim();
    if (!name) return;

    setStatus("loading");
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: name, ...DEFAULT_OPTIONS }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data?.error ?? "Something went wrong on our side.");
        setStatus("error");
        return;
      }

      setResult(data as MatchResult);
      setStatus("success");
    } catch {
      setError("Could not reach the server. Try again in a moment.");
      setStatus("error");
    }
  }

  return (
    <div className="mt-10 flex w-full flex-col items-center">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xl flex-col gap-3 sm:flex-row"
      >
        <label className="sr-only" htmlFor="username">
          Letterboxd username
        </label>
        <input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="your letterboxd username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-14 flex-1 rounded-full border border-steel bg-surface px-6 font-mono text-sm text-bone placeholder:text-slate outline-none transition-colors focus:border-amber"
        />
        <button
          type="submit"
          disabled={status === "loading" || !username.trim()}
          className="h-14 rounded-full bg-amber px-8 font-mono text-sm font-medium tracking-wide text-ink transition-all hover:bg-bone disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "loading" ? (
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden
                className="h-2 w-2 animate-pulse rounded-full bg-ink"
              />
              Finding matches&hellip;
            </span>
          ) : (
            "Find my matches"
          )}
        </button>
      </form>

      <p className="mt-4 font-mono text-xs text-slate">
        e.g. dave &middot; checks the fans of your four favorites
      </p>

      {status === "error" && (
        <p
          role="alert"
          className="mt-6 w-full max-w-xl rounded-2xl border border-steel bg-surface px-5 py-4 text-sm text-bone"
        >
          <span className="mr-2 text-amber">&bull;</span>
          {error}
        </p>
      )}

      {status === "success" && result && (
        <Results result={result} />
      )}
    </div>
  );
}

function Results({ result }: { result: MatchResult }) {
  const [minMatchFilter, setMinMatchFilter] = useState(2);
  // Cumulative: "2+ Matches" includes everyone sharing 2, 3, or 4 films.
  const filteredMatches = result.matches.filter(
    (match) => match.sharedFilms.length >= minMatchFilter
  );

  return (
    <div className="mt-14 w-full max-w-5xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-3xl font-bold text-bone">
          {filteredMatches.length}{" "}
          {filteredMatches.length === 1 ? "profile" : "profiles"} share{" "}
          {minMatchFilter >= 2
            ? `${minMatchFilter}+ of your Top 4`
            : "your taste"}
        </h2>
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-slate">
          {result.username}
        </p>
      </div>

      {result.matches.length === 0 ? (
        <p className="mt-10 text-sm leading-7 text-slate">
          No overlapping fans yet. The scan only covers the first few pages of
          each film&rsquo;s fan list &mdash; try a more popular profile.
        </p>
      ) : (
        <>
          <div
            className="mt-8 flex flex-wrap gap-2"
            role="group"
            aria-label="Filter matches by number of shared films"
          >
            {FILTER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMinMatchFilter(option.value)}
                aria-pressed={minMatchFilter === option.value}
                className={`h-10 rounded-full border px-4 font-mono text-xs tracking-wide transition-colors ${
                  minMatchFilter === option.value
                    ? "border-amber bg-amber text-ink"
                    : "border-steel bg-surface text-slate hover:border-amber/60 hover:text-bone"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <p className="mt-4 font-mono text-xs text-slate">
            Showing {filteredMatches.length}{" "}
            {filteredMatches.length === 1 ? "match" : "matches"} sharing at
            least {minMatchFilter}{" "}
            {minMatchFilter === 1 ? "film" : "films"}
          </p>

          {filteredMatches.length === 0 ? (
            <p className="mt-10 text-sm leading-7 text-slate">
              {minMatchFilter >= 2 ? (
                <>
                  No profiles share {minMatchFilter}+ of this user&rsquo;s Top
                  4. Strong taste overlap is rare &mdash; try{" "}
                  <button
                    type="button"
                    onClick={() => setMinMatchFilter(1)}
                    className="font-medium text-amber underline underline-offset-2 hover:text-bone"
                  >
                    seeing all 1+ matches
                  </button>
                  , or a more popular profile.
                </>
              ) : (
                <>
                  No overlapping fans found yet &mdash; try a more popular
                  profile.
                </>
              )}
            </p>
          ) : (
            <MatchCarousel matches={filteredMatches} />
          )}
        </>
      )}

      <Breakdown scanned={result.scanned} />
    </div>
  );
}

function MatchCarousel({ matches }: { matches: Match[] }) {
  const trackRef = useRef<HTMLUListElement>(null);

  function scrollByCards(direction: number) {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelector("li");
    const step = card ? card.getBoundingClientRect().width + 16 : 320;
    track.scrollBy({ left: direction * step, behavior: "smooth" });
  }

  return (
    <div className="mt-8">
      <div aria-hidden className="film-rail mb-3" />
      <div className="flex items-center gap-2">
        <CarouselButton
          direction="left"
          onClick={() => scrollByCards(-1)}
          label="Previous matches"
        />
        <ul
          ref={trackRef}
          className="carousel-track flex gap-4 overflow-x-auto py-1"
        >
          {matches.map((match) => (
            <MatchCard key={match.username} match={match} />
          ))}
        </ul>
        <CarouselButton
          direction="right"
          onClick={() => scrollByCards(1)}
          label="Next matches"
        />
      </div>
      <div aria-hidden className="film-rail mt-3" />
    </div>
  );
}

function CarouselButton({
  direction,
  onClick,
  label,
}: {
  direction: "left" | "right";
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-steel bg-surface text-bone transition-colors hover:border-amber/60 hover:text-amber"    >
      {direction === "left" ? "\u2190" : "\u2192"}
    </button>
  );
}

function MatchCard({ match }: { match: Match }) {
  const shared = match.sharedFilms.length;
  const hasStats = match.stats && (match.stats.films != null || match.stats.thisYear != null);

  return (
    <li className="group flex w-80 shrink-0 flex-col gap-4 rounded-2xl border border-steel bg-surface p-6 transition-colors hover:border-amber/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {match.avatar && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={match.avatar}
              alt=""
              className="h-11 w-11 shrink-0 rounded-full border-2 border-amber/40 bg-raise"
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-display text-lg font-semibold leading-tight text-bone">
              <Link
                href={`https://letterboxd.com/${match.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-amber"
              >
                {match.displayName || `/${match.username}`}
              </Link>
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate">
              /{match.username} &middot; {shared} shared{" "}
              {shared === 1 ? "film" : "films"}
            </p>
          </div>
        </div>
        <PercentageBadge percentage={match.percentage} />
      </div>

      <ul className="flex flex-wrap gap-1.5">
        {match.sharedFilms.map((slug) => (
          <li key={slug}>
            <Link
              href={`https://letterboxd.com/film/${slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-full border border-amber/25 bg-amber-soft px-2.5 py-1 font-mono text-[11px] text-amber transition-colors hover:border-amber/60 hover:bg-amber/15"
            >
              {slug}
            </Link>
          </li>
        ))}
      </ul>

      {hasStats && (
        <p className="mt-auto border-t border-steel pt-3 font-mono text-xs text-slate">
          {match.stats!.thisYear != null && `${match.stats!.thisYear} this year`}
          {match.stats!.thisYear != null && match.stats!.films != null && " · "}
          {match.stats!.films != null && `${match.stats!.films} films total`}
        </p>
      )}
    </li>
  );
}

function PercentageBadge({ percentage }: { percentage: number }) {
  const hot = percentage >= 75;
  return (
    <span
      className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border-2 font-display text-base font-bold ${
        hot
          ? "border-amber bg-amber text-ink"
          : "border-steel bg-raise text-amber"
      }`}
    >
      {percentage}%
    </span>
  );
}

function Breakdown({
  scanned,
}: {
  scanned: Record<string, ScannedFilm> | null;
}) {
  if (!scanned || Object.keys(scanned).length === 0) return null;
  return (
    <section className="mt-16 border-t border-steel pt-8">
      <h3 className="font-mono text-xs uppercase tracking-[0.3em] text-slate">
        What we scanned
      </h3>
      <dl className="mt-6 grid gap-px overflow-hidden rounded-2xl border border-steel bg-steel sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(scanned).map(([slug, info]) => (
          <div key={slug} className="bg-surface px-5 py-4">
            <dt className="truncate font-mono text-sm text-bone">{slug}</dt>
            <dd className="mt-2 font-mono text-xs text-slate">
              {info.totalFans?.toLocaleString() ?? "?"} fans &middot;{" "}
              {info.scannedPages} page
              {info.scannedPages === 1 ? "" : "s"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
