/**
 * Cloudflare Worker backing the static site. Two routes, both of which exist
 * because GitHub Pages has no server of its own:
 *
 *   POST /          record one of the handful of events the site reports
 *   GET  /artists   resolve artist metadata (names, pictures, genres)
 *
 * The artist route is not a convenience. `GET /v1/artists` returns 403 for the
 * browser app's PKCE *user* token -- for a single id just as readily as for
 * fifty, so it is neither batch size nor the rate limit -- while the same ids
 * return 200 with images for a *client-credentials* token. Client credentials
 * needs a client secret, a secret cannot ship to a browser, and so the call has
 * to happen somewhere with a server. This is that somewhere.
 */

// Only these origins may write. Anyone can still POST here with curl, but an
// allowlist keeps a stray script on someone else's page out of the table.
//
// Localhost is deliberately absent. The published URL is committed in
// analytics.js, so a development run reports by default; a 403 is what keeps
// that traffic out of the numbers without anyone having to remember to switch
// the endpoint off first. Add an origin here to measure a local run on purpose.
const ALLOWED_ORIGINS = ["https://riyadhossain1998.github.io"];

// An unknown kind is a bug or an intruder; either way it is not data.
const KINDS = new Set(["visit", "artist_click", "song_click", "spotify_open"]);

// Track and artist names are short. The cap is about the table, not the UI.
const MAX_NAME = 200;

/** Spotify's documented ceiling for /v1/artists. */
const MAX_IDS = 50;

/** A Spotify id is 22 base62 characters. Anything else never reaches Spotify. */
const ID_PATTERN = /^[0-9A-Za-z]{22}$/;

/**
 * Artist metadata is effectively static -- a name or a profile picture changes
 * perhaps once a year -- so a day at the edge costs nothing in freshness and
 * takes reloads of the same playlist off Spotify's rate limit entirely.
 */
const ARTIST_TTL_SECONDS = 86400;

const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const SPOTIFY_API = "https://api.spotify.com/v1";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // Reads are also allowed from a loopback origin: the artist route is what
    // puts pictures on the graph, so blocking it locally would mean developing
    // the site against permanently broken nodes. Writes stay locked to the
    // published origin, which is what keeps development out of the numbers.
    const mayWrite = ALLOWED_ORIGINS.includes(origin);
    const mayRead = mayWrite || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);

    const cors = {
      "Access-Control-Allow-Origin": mayRead ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/artists" && request.method === "GET") {
      // An Origin header is absent on a curl or a server-side call. Those are
      // allowed through: this returns Spotify's public catalogue, so there is
      // nothing here to protect beyond the app's own request quota, and CORS
      // cannot protect that anyway -- only browsers honour it. The origin check
      // is a speed bump for embedding, not a security boundary.
      if (origin && !mayRead) {
        return json({ error: "Forbidden" }, 403, cors);
      }
      return handleArtists(url, env, cors);
    }

    if (request.method !== "POST" || url.pathname !== "/") {
      return new Response("Not found", { status: 404, headers: cors });
    }
    if (!mayWrite) return new Response("Forbidden", { status: 403, headers: cors });

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

/**
 * Resolve up to 50 artist ids, answering in Spotify's own shape so the browser
 * parses one format whatever served it.
 */
async function handleArtists(url, env, cors) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    // A missing secret is a deployment mistake, and a 500 that says so beats
    // the browser reporting "artist lookups failed" for the second time.
    return json({ error: "Worker is missing its Spotify credentials." }, 500, cors);
  }

  const requested = (url.searchParams.get("ids") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const ids = [...new Set(requested)];

  if (!ids.length || ids.length > MAX_IDS || ids.some((id) => !ID_PATTERN.test(id))) {
    return json({ error: `Pass 1-${MAX_IDS} comma-separated artist ids.` }, 400, cors);
  }

  // Sorted, so two playlists asking for the same artists in a different order
  // share one cache entry. Safe because callers key the response by each
  // artist's own id rather than by its position in the array.
  const cacheKey = new Request(
    `https://artists.spotified.internal/v1?ids=${[...ids].sort().join(",")}`
  );
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) return json(await cached.json(), 200, cors, "HIT");

  let response = await spotifyArtists(ids, await appToken(env));

  // A 401 means the cached token was revoked or rotated rather than merely
  // expired. Mint a fresh one and try once more before giving up.
  if (response.status === 401) {
    tokenCache = { value: null, expires: 0 };
    response = await spotifyArtists(ids, await appToken(env));
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    // Pass Spotify's own status and message through. Swallowing these is what
    // made the original 403 look like a login failure for days.
    return json(
      { error: body?.error?.message || `Spotify request failed (${response.status})` },
      response.status,
      cors
    );
  }

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ARTIST_TTL_SECONDS}` },
    })
  );

  return json(body, 200, cors, "MISS");
}

function spotifyArtists(ids, token) {
  return fetch(`${SPOTIFY_API}/artists?ids=${ids.join(",")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Client-credentials token, held for as long as it is valid.
 *
 * Module scope, so it survives for the life of the isolate and a warm Worker
 * spends no round trip on auth. A cold start pays for one.
 */
let tokenCache = { value: null, expires: 0 };

async function appToken(env) {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expires) return tokenCache.value;

  const credentials = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    throw new Error(`Spotify refused the client credentials (${response.status})`);
  }

  const payload = await response.json();
  // A minute short of the stated lifetime, so a token cannot expire in flight.
  tokenCache = {
    value: payload.access_token,
    expires: now + Math.max(payload.expires_in - 60, 30) * 1000,
  };
  return tokenCache.value;
}

function json(body, status, cors, cacheState) {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (cacheState) headers["X-Artist-Cache"] = cacheState;
  return new Response(JSON.stringify(body), { status, headers });
}

function trim(value, limit) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, limit);
  return cleaned || null;
}
