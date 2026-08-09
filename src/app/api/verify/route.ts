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

/**
 * Ownership challenge: the user places a 6-character token in their Letterboxd
 * bio, then we verify it's there (fresh scrape — never cached, the bio is the
 * challenge target) and mint a Firebase custom token bound to that username.
 * The custom token's UID equals the Letterboxd username, so Firestore rules
 * can tie writes to the verified owner.
 */
export async function POST(request: Request) {
  let body: { username?: string; token?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON body. Expected { \"username\": string, \"token\": string }." },
      { status: 400 }
    );
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";

  if (!username || !USERNAME_REGEX.test(username)) {
    return Response.json(
      {
        error:
          "Invalid username. Only letters, numbers, and underscores (1–30 characters) are allowed.",
      },
      { status: 400 }
    );
  }

  if (!token || !TOKEN_REGEX.test(token)) {
    return Response.json(
      { error: "Invalid token. Use the 6-character code shown on screen." },
      { status: 400 }
    );
  }

  try {
    const { bio, fullTextUrl } = await getProfileBio(username);
    const hasToken =
      bio.includes(token) ||
      // Long bios are truncated on the profile page; check the full text too.
      (fullTextUrl &&
        (await getFullProfileBio(fullTextUrl).then(({ bio: full }) =>
          full.includes(token)
        )));

    if (!hasToken) {
      return Response.json(
        {
          error:
            "Token not found in your Letterboxd bio yet. Save your bio on Letterboxd, then try again.",
        },
        { status: 401 }
      );
    }

    const admin = getFirebaseAdmin();
    const customToken = await getAuth(admin).createCustomToken(username);
    return Response.json({ token: customToken });
  } catch (error) {
    if (error instanceof LetterboxdNotFoundError) {
      return Response.json(
        {
          error: `We couldn't find the Letterboxd profile "${username}". Double-check the username and try again.`,
        },
        { status: 401 }
      );
    }

    if (error instanceof CloudflareBlockedError) {
      return Response.json(
        {
          error:
            "The scraper was temporarily rate-limited by upstream protection. Please try again in a few moments.",
        },
        { status: 429 }
      );
    }

    if (error instanceof ProxyTimeoutError) {
      return Response.json(
        { error: "The verification request timed out. Please try again." },
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
      error instanceof Error ? error.message : "Unknown verification error.";
    return Response.json({ error: message }, { status: 502 });
  }
}
