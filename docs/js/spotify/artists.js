/**
 * Artist metadata reads.
 *
 * One `/v1/artists?ids=` call carries 50 ids, which keeps a 100-artist playlist
 * to two round trips.
 *
 * An earlier version issued one request per artist, on the belief that the
 * 2026-02 migration had withdrawn the batch endpoints along with
 * `/playlists/{id}/tracks`. It had not, and the cost of that mistake was the
 * whole feature: ~60 requests per graph exhausted the app's rate limit, Spotify
 * answered with a `Retry-After` longer than client.js is willing to wait, and
 * so *every* lookup failed rather than a few. Unresolved artists fall back to
 * their track credit -- no image, no genres -- so nodes rendered as placeholder
 * "?" circles and the genre graph collapsed to a single `unclassified` node.
 * Batching is therefore a correctness fix, not an optimisation.
 *
 * A session-lifetime cache sits in front of all of it, because artists recur
 * heavily across playlists and their metadata does not change within a sitting.
 */

import { apiGet } from "./client.js";

/** Spotify's documented ceiling for /v1/artists. */
const MAX_IDS_PER_REQUEST = 50;

/**
 * Batches in flight at once. Two cover most playlists, so this only bites on
 * large ones -- and past a handful of concurrent batches the rate limit is back
 * in play, which is the failure this file exists to avoid.
 */
const CONCURRENCY = 3;

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
 * Resolve metadata for every id, 50 per request, `CONCURRENCY` batches at a time.
 *
 * An artist that cannot be resolved degrades gracefully: it falls back to the
 * name on its track credit rather than sinking the whole build. The shortfall is
 * logged because the silent version of this hid an entire feature failing --
 * every lookup failed, every node lost its image, and nothing said so.
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

  const batches = [];
  for (let i = 0; i < pending.length; i += MAX_IDS_PER_REQUEST) {
    batches.push(pending.slice(i, i + MAX_IDS_PER_REQUEST));
  }

  let done = unique.length - pending.length;
  let cursor = 0;
  onProgress?.(done, unique.length);

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const payload = await apiGet("/artists", { ids: batch.join(",") });
        // Spotify answers positionally and writes null where an id resolved to
        // nothing, so one bad id costs that artist rather than the batch.
        for (const entry of payload.artists || []) {
          if (!entry?.id) continue;
          const artist = toArtist(entry);
          resolved.set(artist.id, artist);
          cache.set(artist.id, artist);
        }
      } catch (error) {
        if (error.needsLogin) throw error; // a dead session will not fix itself
        // Anything else leaves this batch unresolved and is counted below.
      }
      done += batch.length;
      onProgress?.(done, unique.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker)
  );

  const failed = unique.length - resolved.size;
  if (failed) console.warn(`${failed} of ${unique.length} artist lookups failed.`);
  writeCache(cache);
  return resolved;
}
