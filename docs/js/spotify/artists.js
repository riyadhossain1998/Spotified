/**
 * Artist metadata reads.
 *
 * This used to batch 50 ids into a single /v1/artists call. Spotify removed
 * every batch endpoint in its 2026-02 migration, so one request per artist is
 * now the only way to resolve a name and an image -- the same shape as the
 * original project, which is why the two mitigations below exist:
 *
 *   - a small pool of concurrent requests, rather than a sequential loop, so a
 *     100-artist playlist is a few seconds instead of a minute;
 *   - a session-lifetime cache, because artists recur heavily across playlists
 *     and their metadata does not change within a sitting.
 */

import { apiGet } from "./client.js";

/**
 * Enough to hide per-request latency, low enough not to trip rate limiting.
 * The client retries a 429, but a burst that earns one has already cost more
 * time than the parallelism saved.
 */
const CONCURRENCY = 6;

const CACHE_KEY = "spotified.artists";

/** Shown when an artist has no image, so nodes never render broken. */
export const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>" +
  "<rect width='64' height='64' fill='%23333'/>" +
  "<text x='32' y='40' font-size='28' text-anchor='middle' fill='%23888'>?</text>" +
  "</svg>";

/**
 * Pick a ~160px image: nodes render at 32-72px, so the 640px original is a
 * waste of bandwidth multiplied by a few hundred artists.
 */
function mediumImage(images) {
  if (!images?.length) return PLACEHOLDER_IMAGE;
  return images.reduce((best, image) =>
    Math.abs((image.width || 320) - 160) < Math.abs((best.width || 320) - 160)
      ? image
      : best
  ).url;
}

function toArtist(payload) {
  return {
    id: payload.id,
    name: payload.name || "Unknown artist",
    popularity: payload.popularity || 0,
    followers: payload.followers?.total || 0,
    genres: payload.genres || [],
    image_url: mediumImage(payload.images),
    profile_url: payload.external_urls?.spotify ?? null,
  };
}

/**
 * Artists already seen this session, so revisiting a playlist -- or opening a
 * second one that shares artists -- costs no requests at all.
 *
 * sessionStorage rather than a module-level Map because every page here is a
 * real navigation: going back to the playlist grid and into another graph
 * would otherwise throw the whole cache away.
 */
function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return new Map(Object.entries(raw ? JSON.parse(raw) : {}));
  } catch {
    return new Map(); // corrupt or unavailable: rebuild it, do not fail the page
  }
}

function writeCache(cache) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Quota. The cache is an optimisation, never state the graph depends on.
  }
}

/**
 * Resolve metadata for every id, one request each, `CONCURRENCY` at a time.
 *
 * A single failed artist degrades gracefully: it falls back to the name on its
 * track credit rather than sinking the whole build. The count is logged because
 * the previous silent version hid an entire endpoint being withdrawn -- every
 * lookup failed, every node lost its image, and nothing said so.
 */
export async function fetchArtists(artistIds, { onProgress } = {}) {
  const unique = [...new Set(artistIds.filter(Boolean))];
  const resolved = new Map();
  const cache = readCache();

  const pending = [];
  for (const id of unique) {
    const cached = cache.get(id);
    if (cached) resolved.set(id, cached);
    else pending.push(id);
  }

  let done = unique.length - pending.length;
  let failed = 0;
  let cursor = 0;
  onProgress?.(done, unique.length);

  async function worker() {
    while (cursor < pending.length) {
      const id = pending[cursor++];
      try {
        const artist = toArtist(await apiGet(`/artists/${encodeURIComponent(id)}`));
        resolved.set(id, artist);
        cache.set(id, artist);
      } catch (error) {
        if (error.needsLogin) throw error; // a dead session will not fix itself
        failed += 1;
      }
      onProgress?.(++done, unique.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker)
  );

  if (failed) console.warn(`${failed} of ${unique.length} artist lookups failed.`);
  writeCache(cache);
  return resolved;
}
