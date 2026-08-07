import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseTopFourSlugs, parseFansPage } from "../src/lib/scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (name) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("parseTopFourSlugs extracts the 4 favorite film slugs", () => {
  const html = fixtures("profile-favourites.html");
  const slugs = parseTopFourSlugs(html);
  assert.deepEqual(slugs, [
    "high-and-low",
    "burning-2018",
    "my-neighbor-totoro",
    "mulholland-drive",
  ]);
});

test("parseTopFourSlugs returns [] when no favourites section", () => {
  assert.deepEqual(parseTopFourSlugs("<html><body></body></html>"), []);
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
