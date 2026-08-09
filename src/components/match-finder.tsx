"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { track } from "@vercel/analytics";
import {
  collection,
  documentId,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { getFirestoreClient } from "@/lib/firebase-client";
import ClaimProfile, { type SocialLinks } from "@/components/claim-profile";

type Match = {
  username: string;
  displayName?: string;
  avatar?: string | null;
  badge?: string | null;
  sharedFilms: string[];
  percentage: number;
};

type Film = {
  slug: string;
  title: string;
  year?: string | null;
  posterUrl: string | null;
};

type ScannedFilm = {
  totalFans: number | null;
  scannedPages: number;
};

type MatchResult = {
  username: string;
  topFour: Film[];
  stats?: { films: number | null; thisYear: number | null };
  matchCount: number;
  totalMatches: number;
  truncated: boolean;
  matches: Match[];
  scanned: Record<string, ScannedFilm> | null;
};

type Status = "idle" | "loading" | "success" | "error";

const DEFAULT_OPTIONS = { maxPagesPerFilm: 10, delayMs: 0 };
// Initial scans skip the 1-match tier (server runs 11 queries instead of 15);
// the "All (1+)" filter lazily refetches with minMatches=1 when needed.
const DEFAULT_MIN_MATCHES = 2;

class ScanError extends Error {}

const FILTER_OPTIONS = [
  { value: 2, label: "2+ Matches" },
  { value: 3, label: "3+ Matches" },
  { value: 4, label: "4/4 Only" },
  { value: 1, label: "All (1+)" },
];

const LOADING_STEPS = [
  "Fetching profile\u2026",
  "Searching members\u2026",
  "Cross-referencing cinema twins\u2026",
  "Almost there\u2026",
];

const HISTORY_KEY = "tm:history";
const LAST_KEY = "tm:last";

function readStorage(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode / quota); features degrade gracefully
  }
}

export default function MatchFinder() {
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  // Lazy 1-match tier: refetches the result with minMatches=1 (server runs the
  // 4 single-film queries) without touching history/URL/status state.
  const [refreshingTier, setRefreshingTier] = useState(false);
  const [tierError, setTierError] = useState<string | null>(null);

  // Cycle through the loading steps every 4s while a scan is running.
  useEffect(() => {
    if (status !== "loading") return;
    const id = setInterval(() => {
      setLoadingStep((step) => (step + 1) % LOADING_STEPS.length);
    }, 4000);
    return () => clearInterval(id);
  }, [status]);

  // On mount: restore history chips; either deep-link from ?username= or
  // restore the last cached result (never both). Deferred via a microtask so
  // state isn't set synchronously during the effect (avoids a hydration
  // mismatch — server renders the idle state, then we hydrate the cache).
  useEffect(() => {
    queueMicrotask(() => {
      const storedHistory = readStorage(HISTORY_KEY);
      if (Array.isArray(storedHistory)) {
        setHistory(storedHistory.slice(0, 5));
      }

      const params = new URLSearchParams(window.location.search);
      const deepLink = params.get("username");
      if (deepLink) {
        setUsername(deepLink);
        runScan(deepLink);
        return;
      }

      const last = readStorage(LAST_KEY) as
        | { username?: string; result?: MatchResult }
        | null;
      if (last?.result) {
        setUsername(last.username ?? "");
        setResult(last.result);
        setStatus("success");
      }
    });
    // Mount-only: must not re-run when runScan's identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchMatches(name: string, minMatches: number) {
    let res: Response;
    try {
      res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: name,
          ...DEFAULT_OPTIONS,
          minMatches,
        }),
      });
    } catch {
      throw new ScanError("Could not reach the server. Try again in a moment.");
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // non-JSON body (proxy error page, platform error); handled below
    }

    if (!res.ok) {
      // Error payloads can be a string ({ error: "..." }) or an object
      // ({ error: { code, message } } — Vercel platform failures). Coerce
      // both to a readable message; never surface "[object Object]".
      const raw = (data as { error?: unknown } | null)?.error;
      const message =
        typeof raw === "string"
          ? raw
          : typeof (raw as { message?: unknown } | null)?.message === "string"
            ? (raw as { message: string }).message
            : "Something went wrong on our side.";
      throw new ScanError(message);
    }

    if (data === null) {
      throw new ScanError(
        "The server returned an unexpected response. Try again in a moment."
      );
    }
    return data as MatchResult;
  }

  async function runScan(name: string) {
    if (!name) return;
    setUsername(name);
    setStatus("loading");
    setError(null);
    setResult(null);

    try {
      const data = await fetchMatches(name, DEFAULT_MIN_MATCHES);
      setResult(data);
      setStatus("success");

      // Deep-link the successful result.
      window.history.replaceState(
        null,
        "",
        `?username=${encodeURIComponent(name)}`
      );

      // Update recent-history chips.
      setHistory((prev) => {
        const next = [name, ...prev.filter((h) => h !== name)].slice(0, 5);
        writeStorage(HISTORY_KEY, next);
        return next;
      });

      // Cache the last result so a plain revisit restores it instantly.
      writeStorage(LAST_KEY, { username: name, result: data });
    } catch (error) {
      if (error instanceof ScanError) {
        setError(error.message);
      } else {
        setError("Could not reach the server. Try again in a moment.");
      }
      setStatus("error");
    }
  }

  // Lazy 1-match tier: refetches the result with minMatches=1 (server runs the
  // 4 single-film queries) without touching history/URL/status state.
  async function handleRefetchTier(name: string) {
    if (refreshingTier) return;
    setRefreshingTier(true);
    setTierError(null);
    try {
      const data = await fetchMatches(name, 1);
      setResult(data);
    } catch {
      setTierError("Couldn't load the 1+ match tier. Try again in a moment.");
    } finally {
      setRefreshingTier(false);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runScan(username.trim());
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
              {LOADING_STEPS[loadingStep]}
            </span>
          ) : (
            "Find my matches"
          )}
        </button>
      </form>

      <p className="mt-4 font-mono text-xs text-slate">
        e.g. dave &middot; checks the fans of your four favorites
      </p>

      {history.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {history.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => runScan(name)}
              className="rounded-full border border-steel bg-surface px-3 py-1 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
            >
              /{name}
            </button>
          ))}
        </div>
      )}

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
        <Results
          result={result}
          onRefetchTier={handleRefetchTier}
          refreshingTier={refreshingTier}
          tierError={tierError}
        />
      )}
    </div>
  );
}

function FilmFilterStrip({
  films,
  selected,
  onSelect,
}: {
  films: Film[];
  selected: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  function handleStripKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const buttons = Array.from(
      stripRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % buttons.length
        : (index - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  }

  return (
    <div className="mt-8">
      <p className="font-mono text-xs uppercase tracking-[0.3em] text-slate">
        Filter by a favorite film
      </p>
      <div
        ref={stripRef}
        onKeyDown={handleStripKeyDown}
        className="mt-3 flex flex-wrap gap-3"
      >
        {films.map((film) => {
          const isSelected = selected === film.slug;
          return (
            <button
              key={film.slug}
              type="button"
              onClick={() => onSelect(isSelected ? null : film.slug)}
              aria-pressed={isSelected}
              title={film.title}
              className={`group relative overflow-hidden rounded-lg border-2 transition-all ${
                isSelected
                  ? "border-amber ring-2 ring-amber"
                  : "border-steel hover:border-amber/60"
              }`}
            >
              {film.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={film.posterUrl}
                  alt={film.title}
                  className="block h-28 w-[4.6rem] object-cover"
                />
              ) : (
                <span className="flex h-28 w-[4.6rem] items-center justify-center bg-surface px-1 text-center font-mono text-[10px] text-slate">
                  {film.slug}
                </span>
              )}
              <span
                className={`absolute inset-x-0 bottom-0 truncate bg-ink/80 px-1 py-0.5 text-center font-mono text-[9px] ${
                  isSelected ? "text-amber" : "text-slate"
                }`}
              >
                {film.title.split(" (")[0]}
                {film.year ? ` (${film.year})` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MatchDistributionBar({ matches }: { matches: Match[] }) {
  const counts = { 4: 0, 3: 0, 2: 0, 1: 0 } as Record<number, number>;
  for (const match of matches) {
    const n = match.sharedFilms.length;
    if (n >= 1 && n <= 4) counts[n] += 1;
  }
  const total = Math.max(1, matches.length);

  return (
    <div className="mt-8">
      <div className="flex h-2 overflow-hidden rounded-full bg-raise">
        {([4, 3, 2, 1] as const).map((n) => (
          <div
            key={n}
            style={{ width: `${(counts[n] / total) * 100}%` }}
            className={`${n === 4 ? "bg-amber" : n === 3 ? "bg-amber/70" : n === 2 ? "bg-amber/40" : "bg-amber/20"}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-slate">
        {([4, 3, 2, 1] as const).map((n) => (
          <span key={n}>
            <span className="text-amber">{counts[n]}</span> share {n}
            {n === 1 ? " film" : " films"}
          </span>
        ))}
      </div>
    </div>
  );
}

function OpenAllLink({ films }: { films: Film[] }) {
  const slugs = films.map((f) => f.slug);
  if (slugs.length === 0) return null;
  // OR the four singles so the link surfaces every user who is a fan of at
  // least one of the four films, regardless of the active tier filter.
  const query = slugs.map((s) => `(fan:${s})`).join("%20OR%20");
  const url = `https://letterboxd.com/search/members/${query}/`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-full border border-amber/30 bg-amber-soft px-3 py-1.5 font-mono text-xs text-amber transition-colors hover:border-amber/70 hover:bg-amber/15"
    >
      View all matches on Letterboxd
    </a>
  );
}

function Results({
  result,
  onRefetchTier,
  refreshingTier,
  tierError,
}: {
  result: MatchResult;
  onRefetchTier: (username: string) => void;
  refreshingTier: boolean;
  tierError: string | null;
}) {
  const [minMatchFilter, setMinMatchFilter] = useState(2);
  const [selectedFilmFilter, setSelectedFilmFilter] = useState<string | null>(
    null
  );
  const [copied, setCopied] = useState(false);
  // username -> claimed social links, loaded once per scan.
  const [socials, setSocials] = useState<Record<string, SocialLinks>>({});
  // Defensive: tolerate a malformed/legacy payload — a partial scan or an old
  // cached response should never crash the results view. Memoized so the
  // socials-fetch effect below has a stable dependency.
  const matches = useMemo(
    () => (Array.isArray(result.matches) ? result.matches : []),
    [result]
  );
  const topFour = Array.isArray(result.topFour) ? result.topFour : [];
  const totalMatches =
    typeof result.totalMatches === "number"
      ? result.totalMatches
      : matches.length;
  const truncated = result.truncated === true;
  // Whether the current payload already includes 1-film matches (legacy cached
  // results fetched with minMatches=1 do; new lazy scans don't).
  const hasOneTier = matches.some((match) => match.sharedFilms.length === 1);
  // Cumulative: "2+ Matches" includes everyone sharing 2, 3, or 4 films.
  // When a film is selected, only matches that share that film remain.
  const filteredMatches = matches.filter(
    (match) =>
      (Array.isArray(match.sharedFilms) ? match.sharedFilms.length : 0) >=
        minMatchFilter &&
      (selectedFilmFilter === null ||
        (Array.isArray(match.sharedFilms) &&
          match.sharedFilms.includes(selectedFilmFilter)))
  );

  async function copyUsernames() {
    const text = matches.map((m) => m.username).join("\n");
    track("copy_usernames");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable; do nothing
    }
  }

  function handleTierSelect(value: number) {
    setMinMatchFilter(value);
    track("tier_filter", { tier: value });
    // "All (1+)" needs the single-film queries; fetch them lazily if the
    // current result doesn't include the 1-match tier yet.
    if (value === 1 && !hasOneTier) {
      onRefetchTier(result.username);
    }
  }

  function handleFilmSelect(slug: string | null) {
    setSelectedFilmFilter(slug);
    if (slug) track("film_filter", { slug });
  }

  // Load claimed socials for every match. Firestore `in` queries cap at 30
  // values, so chunk the usernames (100 matches -> 4 reads).
  useEffect(() => {
    if (matches.length === 0) return;
    let cancelled = false;
    const db = getFirestoreClient();
    const usernames = matches.map((m) => m.username);
    const chunks: string[][] = [];
    for (let i = 0; i < usernames.length; i += 30) {
      chunks.push(usernames.slice(i, i + 30));
    }
    Promise.all(
      chunks.map((chunk) =>
        getDocs(query(collection(db, "users"), where(documentId(), "in", chunk)))
      )
    )
      .then((snapshots) => {
        if (cancelled) return;
        const next: Record<string, SocialLinks> = {};
        for (const snapshot of snapshots) {
          for (const docSnap of snapshot.docs) {
            const data = docSnap.data();
            next[docSnap.id] = {
              instagram:
                typeof data.instagram === "string" ? data.instagram : undefined,
              x: typeof data.x === "string" ? data.x : undefined,
              discord:
                typeof data.discord === "string" ? data.discord : undefined,
            };
          }
        }
        setSocials(next);
      })
      .catch(() => {
        // socials are decorative; a failed read shouldn't affect results
      });
    return () => {
      cancelled = true;
    };
  }, [matches]);

  function handleClaimed(username: string, links: SocialLinks | null) {
    setSocials((prev) => {
      const next = { ...prev };
      if (links) next[username] = links;
      else delete next[username];
      return next;
    });
  }

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
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-slate">
            {result.username}
          </p>
          <ClaimProfile username={result.username} onClaimed={handleClaimed} />
        </div>
      </div>

      {result.stats &&
        (result.stats.films != null || result.stats.thisYear != null) && (
          <p className="mt-3 font-mono text-xs text-slate">
            {result.stats.thisYear != null &&
              `${result.stats.thisYear} films logged this year`}
            {result.stats.thisYear != null &&
              result.stats.films != null &&
              " \u00b7 "}
            {result.stats.films != null && `${result.stats.films} films total`}
          </p>
        )}

      {truncated && (
        <p className="mt-3 font-mono text-xs text-amber">
          Showing top {matches.length} of {totalMatches} profiles
        </p>
      )}

      <FilmFilterStrip
        films={topFour}
        selected={selectedFilmFilter}
        onSelect={handleFilmSelect}
      />

      <MatchDistributionBar matches={matches} />

      {matches.length === 0 ? (
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
            {FILTER_OPTIONS.map((option) => {
              const isLoadingTier =
                option.value === 1 && refreshingTier && minMatchFilter === 1;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleTierSelect(option.value)}
                  aria-pressed={minMatchFilter === option.value}
                  disabled={isLoadingTier}
                  className={`h-10 rounded-full border px-4 font-mono text-xs tracking-wide transition-colors ${
                    minMatchFilter === option.value
                      ? "border-amber bg-amber text-ink"
                      : "border-steel bg-surface text-slate hover:border-amber/60 hover:text-bone"
                  } disabled:cursor-wait disabled:opacity-70`}
                >
                  {isLoadingTier
                    ? "Loading\u2026"
                    : option.label}
                </button>
              );
            })}
          </div>

          {tierError && (
            <p className="mt-3 font-mono text-xs text-amber">{tierError}</p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <p className="font-mono text-xs text-slate">
              Showing {filteredMatches.length}{" "}
              {filteredMatches.length === 1 ? "match" : "matches"} sharing at
              least {minMatchFilter}{" "}
              {minMatchFilter === 1 ? "film" : "films"}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={copyUsernames}
                className="rounded-full border border-steel bg-surface px-3 py-1.5 font-mono text-xs text-slate transition-colors hover:border-amber/60 hover:text-amber"
              >
                {copied ? "Copied\u2713" : "Copy usernames"}
              </button>
              <OpenAllLink films={topFour} />
            </div>
          </div>

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
            <MatchCarousel
              matches={filteredMatches}
              topFour={topFour}
              socials={socials}
            />
          )}
        </>
      )}

      <Breakdown scanned={result.scanned} />
    </div>
  );
}

function MatchCarousel({
  matches,
  topFour,
  socials,
}: {
  matches: Match[];
  topFour: Film[];
  socials: Record<string, SocialLinks>;
}) {
  const trackRef = useRef<HTMLUListElement>(null);

  function scrollByCards(direction: number) {
    const track = trackRef.current;
    if (!track) return;
    const card = track.querySelector("li");
    const step = card ? card.getBoundingClientRect().width + 16 : 320;
    track.scrollBy({ left: direction * step, behavior: "smooth" });
  }

  function handleTrackKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      scrollByCards(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      scrollByCards(1);
    }
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
          tabIndex={0}
          onKeyDown={handleTrackKeyDown}
          aria-label="Match results (use arrow keys to scroll)"
          className="carousel-track flex gap-4 overflow-x-auto rounded-2xl py-1 focus-visible:outline-2 focus-visible:outline-amber focus-visible:outline-offset-2"
        >
          {matches.map((match) => (
            <MatchCard
              key={match.username}
              match={match}
              topFour={topFour}
              socials={socials[match.username]}
            />
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

function MatchCard({
  match,
  topFour,
  socials,
}: {
  match: Match;
  topFour: Film[];
  socials?: SocialLinks;
}) {
  const shared = match.sharedFilms.length;
  const filmsBySlug = new Map(topFour.map((film) => [film.slug, film]));
  const sharedFilms = match.sharedFilms
    .map((slug) => filmsBySlug.get(slug))
    .filter((film): film is Film => Boolean(film));

  return (
    <li className="group flex w-72 shrink-0 flex-col gap-3 rounded-2xl border border-steel bg-surface p-4 transition-colors hover:border-amber/50">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {match.avatar && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={match.avatar}
              alt=""
              className="h-10 w-10 shrink-0 rounded-full border-2 border-amber/40 bg-raise"
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold leading-tight text-bone">
              <Link
                href={`https://letterboxd.com/${match.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-amber"
              >
                {match.displayName || `/${match.username}`}
              </Link>
              {match.badge && (
                <span className="ml-1.5 rounded border border-amber/40 bg-amber-soft px-1 py-0.5 align-middle font-mono text-[9px] uppercase tracking-wide text-amber">
                  {match.badge}
                </span>
              )}
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-slate">
              /{match.username} &middot; {shared} shared{" "}
              {shared === 1 ? "film" : "films"}
            </p>
          </div>
        </div>
        <PercentageBadge percentage={match.percentage} />
      </div>

      {socials && (socials.instagram || socials.x || socials.discord) && (
        <div className="flex items-center gap-2">
          {socials.instagram && (
            <SocialIconLink
              href={`https://instagram.com/${socials.instagram}`}
              label={`Instagram: ${socials.instagram}`}
              path={INSTAGRAM_PATH}
            />
          )}
          {socials.x && (
            <SocialIconLink
              href={`https://x.com/${socials.x}`}
              label={`X: ${socials.x}`}
              path={X_PATH}
            />
          )}
          {socials.discord && <DiscordCopyChip handle={socials.discord} />}
        </div>
      )}

      {sharedFilms.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {sharedFilms.map((film) => (
            <li key={film.slug} title={film.title}>
              <Link
                href={`https://letterboxd.com/film/${film.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded border border-steel px-2 py-1 font-mono text-[11px] leading-none text-slate transition-colors hover:border-amber/60 hover:text-amber"
              >
                {film.slug}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[11px] text-slate">No shared films found.</p>
      )}
    </li>
  );
}

function PercentageBadge({ percentage }: { percentage: number }) {
  const hot = percentage >= 75;
  return (
    <span
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 font-display text-sm font-bold ${
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

// --- Social icon row (claimed profiles) -------------------------------------

const INSTAGRAM_PATH =
  "M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z";
const X_PATH =
  "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z";
const DISCORD_PATH =
  "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z";

function SocialIconLink({
  href,
  label,
  path,
}: {
  href: string;
  label: string;
  path: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded-full border border-steel text-slate transition-colors hover:border-amber/60 hover:text-amber"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-3.5 w-3.5">
        <path d={path} />
      </svg>
    </a>
  );
}

/** Discord has no public user URL (needs the numeric ID), so copy instead. */
function DiscordCopyChip({ handle }: { handle: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(handle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Discord: ${handle} (click to copy)`}
      aria-label={`Copy Discord username ${handle}`}
      className="flex h-6 max-w-[130px] items-center gap-1.5 rounded-full border border-steel px-2 text-slate transition-colors hover:border-amber/60 hover:text-amber"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="h-3.5 w-3.5 shrink-0">
        <path d={DISCORD_PATH} />
      </svg>
      <span className="truncate font-mono text-[10px]">
        {copied ? "Copied\u2713" : handle}
      </span>
    </button>
  );
}
