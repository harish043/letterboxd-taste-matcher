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
import ClaimProfile from "@/components/claim-profile";
import { SocialLinksRow, type SocialLinks } from "@/components/social-icons";

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

  // Load claimed socials for every match plus the scanned user's own claim
  // (shown inline in the stats line). Firestore `in` queries cap at 30 values,
  // so chunk the usernames (100 matches -> 4 reads).
  useEffect(() => {
    let cancelled = false;
    const db = getFirestoreClient();
    const usernames = [
      ...new Set([
        ...matches.map((m) => m.username),
        ...(result.username ? [result.username] : []),
      ]),
    ];
    if (usernames.length === 0) return;
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
  }, [matches, result]);

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

      {(() => {
        const statsHasData =
          result.stats &&
          (result.stats.films != null || result.stats.thisYear != null);
        const mySocials = socials[result.username];
        if (!statsHasData && !mySocials) return null;
        return (
          <p className="mt-3 font-mono text-xs text-slate">
            {result.stats?.thisYear != null &&
              `${result.stats.thisYear} films logged this year`}
            {result.stats?.thisYear != null &&
              result.stats.films != null &&
              " \u00b7 "}
            {result.stats?.films != null &&
              `${result.stats.films} films total`}
            {statsHasData && mySocials && " \u00b7 "}
            <SocialLinksRow links={mySocials} />
          </p>
        );
      })()}

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

      <SocialLinksRow links={socials} />

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
