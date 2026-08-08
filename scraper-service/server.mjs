import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTopFour,
  getSharedFans,
  buildMatchResult,
  LetterboxdNotFoundError,
  TooFewFavoritesError,
} from "../src/lib/scraper.mjs";

// Minimal .env loader (works from the repo root via systemd or manually).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  }
} catch {
  // best-effort
}

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.SCRAPER_TOKEN;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;
const MAX_PAGES_PER_FILM = 3;
const MAX_DELAY_MS = 10000;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || "";
  const expected = `Bearer ${TOKEN}`;
  // timingSafeEqual throws on unequal buffer lengths — compare lengths first,
  // and only do the constant-time compare when they match.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleMatch(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, {
      error: "Invalid JSON body. Expected { \"username\": string }.",
    });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";

  if (!username) {
    return sendJson(res, 400, { error: "Missing required field: username." });
  }

  if (!USERNAME_REGEX.test(username)) {
    return sendJson(res, 400, {
      error:
        "Invalid username. Only letters, numbers, and underscores (1–30 characters) are allowed.",
    });
  }

  const maxPagesPerFilm =
    typeof body.maxPagesPerFilm === "number" && body.maxPagesPerFilm > 0
      ? Math.min(Math.floor(body.maxPagesPerFilm), MAX_PAGES_PER_FILM)
      : MAX_PAGES_PER_FILM;
  const delayMs =
    typeof body.delayMs === "number" && body.delayMs >= 0
      ? Math.min(body.delayMs, MAX_DELAY_MS)
      : undefined;
  const minMatches =
    typeof body.minMatches === "number" && body.minMatches >= 1
      ? Math.min(Math.floor(body.minMatches), 4)
      : 1;

  try {
    const { topFour, stats } = await getTopFour(username);
    const slugs = topFour.map((film) => film.slug);
    const { perFilm } = await getSharedFans(slugs, {
      maxPagesPerFilm,
      delayMs,
    });
    const { matches, scanned } = buildMatchResult(slugs, perFilm, minMatches);

    sendJson(res, 200, {
      username,
      topFour,
      stats,
      matchCount: matches.length,
      matches,
      scanned,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown scraping error.";

    if (error instanceof LetterboxdNotFoundError) {
      return sendJson(res, 404, {
        error: `Username "${username}" not found or has no Top 4.`,
      });
    }

    if (error instanceof TooFewFavoritesError) {
      return sendJson(res, 400, {
        error: `Username "${username}" needs at least 4 favorite films.`,
      });
    }

    sendJson(res, 502, { error: message });
  }
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/match") {
      if (!authorized(req)) {
        return sendJson(res, 401, { error: "Unauthorized." });
      }
      return handleMatch(req, res);
    }

    sendJson(res, 404, { error: "Not found." });
  } catch (error) {
    // Never let a malformed request crash the whole process.
    console.error("Request handler error:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error." });
    }
  }
});

// Defensive: keep the service alive if something slips through the handler.
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Scraper service listening on port ${PORT}`);
});
