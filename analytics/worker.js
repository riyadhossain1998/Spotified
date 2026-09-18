/**
 * Cloudflare Worker that records the handful of events the site reports.
 *
 * It exists because GitHub Pages is static: the demo has nowhere of its own to
 * write to. This is the whole back end -- one route, one INSERT -- and it is
 * write-only. Reading is done with `wrangler d1 execute`, so there is no query
 * endpoint to secure and no dashboard to keep logged in.
 */

// Only these origins may write. Anyone can still POST here with curl, but an
// allowlist keeps a stray script on someone else's page out of the table.
const ALLOWED_ORIGINS = [
  "https://riyadhossain1998.github.io",
  "http://127.0.0.1:8099",
  "http://127.0.0.1:5000",
];

// An unknown kind is a bug or an intruder; either way it is not data.
const KINDS = new Set(["visit", "artist_click", "song_click", "spotify_open"]);

// Track and artist names are short. The cap is about the table, not the UI.
const MAX_NAME = 200;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return new Response("Not found", { status: 404, headers: cors });
    if (!allowed) return new Response("Forbidden", { status: 403, headers: cors });

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("Bad request", { status: 400, headers: cors });
    }

    if (!KINDS.has(payload?.kind)) {
      return new Response("Bad request", { status: 400, headers: cors });
    }

    const name = trim(payload.name, MAX_NAME);
    const page = trim(payload.page, MAX_NAME);

    await env.DB.prepare("INSERT INTO events (kind, name, page) VALUES (?, ?, ?)")
      .bind(payload.kind, name, page)
      .run();

    // The browser sent this with sendBeacon and is not listening for a body.
    return new Response(null, { status: 204, headers: cors });
  },
};

function trim(value, limit) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, limit);
  return cleaned || null;
}
