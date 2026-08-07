/**
 * Cloudflare Worker fetch relay.
 *
 * Letterboxd's Cloudflare challenges requests that egress from datacenter IPs
 * (AWS/Vercel). This worker lives on Cloudflare's own network, so when it
 * fetches Letterboxd the egress IP is a Cloudflare IP that is NOT challenged.
 *
 * Vercel's /api/match calls this worker instead of scraping directly:
 *   GET /fetch?url=<letterboxd-url>
 *
 * Protected by a bearer token (SCRAPER_TOKEN secret). Only letterboxd.com is
 * allowed as a target (SSRF guard).
 */

const ALLOWED_HOST = "letterboxd.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const worker = {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return json(405, { error: "Method not allowed." });
    }

    const token = env.SCRAPER_TOKEN;
    if (token) {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${token}`) {
        return json(401, { error: "Unauthorized." });
      }
    }

    const url = new URL(request.url);
    if (url.pathname !== "/fetch") {
      return json(404, { error: "Not found." });
    }

    const target = url.searchParams.get("url");
    if (!target) {
      return json(400, { error: "Missing 'url' query parameter." });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return json(400, { error: "Invalid target URL." });
    }

    if (parsed.hostname !== ALLOWED_HOST && !parsed.hostname.endsWith(`.${ALLOWED_HOST}`)) {
      return json(403, { error: `Only ${ALLOWED_HOST} URLs are allowed.` });
    }

    const upstream = await fetch(target, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      },
      redirect: "follow",
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

export default worker;

function json(status, data) {
  const body = JSON.stringify(data);
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
