import {
  getProfileBio,
  getFullProfileBio,
  LetterboxdNotFoundError,
  CloudflareBlockedError,
  ProxyTimeoutError,
  ProxyError,
} from "@/lib/scraper.mjs";
import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdmin } from "@/lib/firebase-admin";

export const runtime = "nodejs";
export const maxDuration = 30;

const USERNAME_REGEX = /^[a-zA-Z0-9_]{1,30}$/;
const TOKEN_REGEX = /^[A-Za-z0-9]{6}$/;
// Bound the scrape so the route always answers with a JSON body inside the
// function budget — a killed platform function returns an empty body, which
// the client can't parse.
const SCRAPE_DEADLINE_MS = 20000;

class VerifyTimeoutError extends Error {
  constructor() {
    super("The verification request timed out. Please try again.");
    this.name = "VerifyTimeoutError";
  }
}

/** Race a promise against a hard deadline, always answering before it dies. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VerifyTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Error response with a machine-readable code + a server log line. */
function fail(message: string, status: number, code: string) {
  console.error(`[verify] ${code} (${status}): ${message}`);
  return Response.json({ error: message, code }, { status });
}

/**
 * Ownership challenge: the user places a 6-character token in their Letterboxd
 * bio, then we verify it's there (fresh scrape — never cached, the bio is the
 * challenge target) and mint a Firebase custom token bound to that username.
 * The custom token's UID equals the Letterboxd username, so Firestore rules
 * can tie writes to the verified owner.
 */
export async function POST(request: Request) {
  try {
    return await handleVerify(request);
  } catch (error) {
    // Never let an unforeseen crash escape as an empty/HTML body — always
    // answer with JSON so the client can show a readable message.
    console.error("[verify] unhandled:", error);
    return Response.json(
      {
        error: "Unexpected verification error. Please try again.",
        code: "unhandled",
      },
      { status: 500 }
    );
  }
}

async function handleVerify(request: Request) {
  let body: { username?: string; token?: string };
  try {
    body = await request.json();
  } catch {
    return fail(
      "Invalid JSON body. Expected { \"username\": string, \"token\": string }.",
      400,
      "bad_request"
    );
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";

  if (!username || !USERNAME_REGEX.test(username)) {
    return fail(
      "Invalid username. Only letters, numbers, and underscores (1–30 characters) are allowed.",
      400,
      "bad_username"
    );
  }

  if (!token || !TOKEN_REGEX.test(token)) {
    return fail(
      "Invalid token. Use the 6-character code shown on screen.",
      400,
      "bad_token"
    );
  }

  try {
    // One light scrape: the profile page, parsed for its bio text. The token
    // is checked as a plain substring of the bio HTML — no extra requests
    // beyond the (best-effort) full-text fetch for truncated bios.
    const { bio, fullTextUrl } = await withDeadline(
      getProfileBio(username, { attempts: 2 }),
      SCRAPE_DEADLINE_MS
    );
    // Long bios are truncated on the profile page; check the full text too
    // (best-effort — a failed full-text fetch just reports the token as
    // missing from the truncated bio).
    let hasToken = bio.includes(token);
    if (!hasToken && fullTextUrl) {
      try {
        const { bio: full } = await withDeadline(
          getFullProfileBio(fullTextUrl),
          SCRAPE_DEADLINE_MS
        );
        hasToken = full.includes(token);
      } catch {
        // best-effort fallback only
      }
    }

    if (!hasToken) {
      return fail(
        "Token not found in your Letterboxd bio yet. Save your bio on Letterboxd, then try again.",
        401,
        "token_not_in_bio"
      );
    }

    const admin = getFirebaseAdmin();
    const customToken = await getAuth(admin).createCustomToken(username);
    return Response.json({ token: customToken });
  } catch (error) {
    if (error instanceof VerifyTimeoutError) {
      return fail(error.message, 504, "timeout");
    }

    if (error instanceof LetterboxdNotFoundError) {
      return fail(
        `We couldn't find the Letterboxd profile "${username}". Double-check the username and try again.`,
        401,
        "not_found"
      );
    }

    if (error instanceof CloudflareBlockedError) {
      return fail(
        "The scraper was temporarily rate-limited by upstream protection. Please try again in a few moments.",
        429,
        "cloudflare_blocked"
      );
    }

    if (error instanceof ProxyTimeoutError) {
      return fail(
        "The verification request timed out. Please try again.",
        504,
        "proxy_timeout"
      );
    }

    if (error instanceof ProxyError) {
      return fail(
        "The proxy could not complete the request. Please try again.",
        502,
        "proxy_error"
      );
    }

    const message =
      error instanceof Error ? error.message : "Unknown verification error.";
    return fail(message, 502, "verify_error");
  }
}
