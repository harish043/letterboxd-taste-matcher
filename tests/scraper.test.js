import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseTopFour,
  parseFansPage,
  parseFilmPoster,
  buildMatchResult,
  buildFansPageUrl,
  buildSearchUrl,
  parseSearchResults,
  parseProfileStats,
  generateSessionId,
} from "../src/lib/scraper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (name) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("buildFansPageUrl always uses the paginated form", () => {
  assert.equal(
    buildFansPageUrl("pulp-fiction", 1),
    "https://letterboxd.com/film/pulp-fiction/fans/page/1/"
  );
  assert.equal(
    buildFansPageUrl("pulp-fiction", 2),
    "https://letterboxd.com/film/pulp-fiction/fans/page/2/"
  );
});

test("generateSessionId returns unique sticky-session ids", () => {
  const seen = new Set([generateSessionId(), generateSessionId(), generateSessionId()]);
  assert.equal(seen.size, 3);
  for (const id of seen) {
    assert.match(id, /^[a-z0-9]+-[a-z0-9]{4}$/);
  }
});

test("parseTopFour extracts slug, title, and year for the 4 favorite films", () => {
  const html = fixtures("profile-favourites.html");
  const films = parseTopFour(html);
  assert.deepEqual(films, [
    { slug: "high-and-low", title: "High and Low (1963)", year: "1963" },
    { slug: "burning-2018", title: "Burning (2018)", year: "2018" },
    { slug: "my-neighbor-totoro", title: "My Neighbor Totoro (1988)", year: "1988" },
    { slug: "mulholland-drive", title: "Mulholland Drive (2001)", year: "2001" },
  ]);
});

test("parseTopFour returns [] when no favourites section", () => {
  assert.deepEqual(parseTopFour("<html><body></body></html>"), []);
});

test("parseFilmPoster extracts the og:image poster URL", () => {
  const html = fixtures("film-page.html");
  const poster = parseFilmPoster(html);
  assert.match(poster, /^https:\/\/a\.ltrbxd\.com\/resized\/sm\/upload\//);
});

test("parseFilmPoster returns null when no og:image", () => {
  assert.equal(parseFilmPoster("<html><body></body></html>"), null);
});

test("parseFansPage extracts usernames, count, and next-page link", () => {
  const html = fixtures("fans-page.html");
  const { usernames, hasNext, count } = parseFansPage(html, "pulp-fiction", 1);

  assert.equal(usernames.length, 25);
  assert.equal(usernames[0], "0000000000");
  assert.equal(hasNext, true);
  assert.equal(count, 146599);
});

test("parseFansPage count is null on non-first pages", () => {
  const html = fixtures("fans-page.html");
  const { count } = parseFansPage(html, "pulp-fiction", 2);
  assert.equal(count, null);
});

test("parseFansPage count is null when the fans link is absent", () => {
  const html = "<html><body><table class='table-base member-table'></table></body></html>";
  const { usernames, hasNext, count } = parseFansPage(html, "pulp-fiction", 1);
  assert.deepEqual(usernames, []);
  assert.equal(hasNext, false);
  assert.equal(count, null);
});

test("buildMatchResult intersects fans, ranks by percentage, and filters", () => {
  const perFilm = {
    "film-a": { count: 100, scannedPages: 1, fans: ["u1", "u2", "u3"] },
    "film-b": { count: 200, scannedPages: 1, fans: ["u2", "u3", "u4"] },
  };
  const { matches, scanned } = buildMatchResult(["film-a", "film-b"], perFilm, 2);

  assert.deepEqual(matches, [
    { username: "u2", sharedFilms: ["film-a", "film-b"], percentage: 100 },
    { username: "u3", sharedFilms: ["film-a", "film-b"], percentage: 100 },
  ]);
  assert.deepEqual(scanned, {
    "film-a": { totalFans: 100, scannedPages: 1 },
    "film-b": { totalFans: 200, scannedPages: 1 },
  });
});

test("buildMatchResult minMatches=1 includes single-film matches", () => {
  const perFilm = {
    "film-a": { count: 10, scannedPages: 1, fans: ["u1"] },
    "film-b": { count: 20, scannedPages: 1, fans: ["u1", "u2"] },
  };
  const { matches } = buildMatchResult(["film-a", "film-b"], perFilm, 1);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].percentage, 100);
  assert.equal(matches[1].percentage, 50);
});

test("buildSearchUrl ORs all pairs for 2+ matches", () => {
  const url = buildSearchUrl(["a", "b", "c", "d"], 2);
  assert.match(url, /^https:\/\/letterboxd\.com\/s\/search\/members\//);
  // 6 pairs: ab, ac, ad, bc, bd, cd
  assert.match(url, /\(fan:a\+fan:b\)/);
  assert.match(url, /\(fan:a\+fan:c\)/);
  assert.match(url, /\(fan:a\+fan:d\)/);
  assert.match(url, /\(fan:b\+fan:c\)/);
  assert.match(url, /\(fan:b\+fan:d\)/);
  assert.match(url, /\(fan:c\+fan:d\)/);
  assert.match(url, /%20OR%20/);
});

test("buildSearchUrl builds triples for 3+ and a single AND for 4/4", () => {
  const triples = buildSearchUrl(["a", "b", "c", "d"], 3);
  assert.match(triples, /\(fan:a\+fan:b\+fan:c\)/);
  assert.match(triples, /\(fan:b\+fan:c\+fan:d\)/);

  const quad = buildSearchUrl(["a", "b", "c", "d"], 4);
  assert.equal(
    quad,
    "https://letterboxd.com/s/search/members/(fan:a+fan:b+fan:c+fan:d)/"
  );
});

test("buildSearchUrl ORs the singles for 1+ matches", () => {
  const singles = buildSearchUrl(["a", "b", "c", "d"], 1);
  assert.match(singles, /\(fan:a\)%20OR%20\(fan:b\)%20OR%20\(fan:c\)%20OR%20\(fan:d\)/);
});

test("parseSearchResults extracts username, display name, avatar, and badge", () => {
  const html = fixtures("search-results.html");
  const results = parseSearchResults(html);
  assert.equal(results.length, 20);
  assert.equal(results[0].username, "smilepolicy");
  assert.equal(results[0].displayName, "harish");
  assert.ok(results[0].avatar.includes("a.ltrbxd.com"));
  // every result has a username and display name
  for (const r of results) {
    assert.ok(r.username.length > 0);
    assert.ok(r.displayName.length > 0);
  }
  // the fixture has a Pro badge on matthistory; display name excludes it
  const matthistory = results.find((r) => r.username === "matthistory");
  assert.equal(matthistory?.badge, "Pro");
  assert.equal(matthistory?.displayName, "Matt");
});

test("parseProfileStats extracts films and this-year diary counts", () => {
  const html = fixtures("profile-stats.html");
  const stats = parseProfileStats(html);
  assert.equal(stats.films, 343);
  assert.equal(stats.thisYear, 45);
});

test("parseProfileStats returns nulls when no stats block", () => {
  assert.deepEqual(parseProfileStats("<html><body></body></html>"), {
    films: null,
    thisYear: null,
  });
});
