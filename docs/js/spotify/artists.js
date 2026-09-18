/**
 * Artist metadata reads.
 *
 * The original project called /v1/artists/{id} once per artist, so a 156-node
 * graph meant 156 sequential round trips -- most of why a build took minutes.
 * /v1/artists accepts 50 ids per call, turning that into 4 requests.
 */

import { apiGet } from "./client.js";

const BATCH_SIZE = 50;

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
 * Resolve metadata for every id, 50 at a time.
 *
 * Batches run sequentially rather than via Promise.all: firing twenty parallel
 * requests at Spotify is the fastest way to earn a 429, and the client's
 * backoff would then serialise them anyway, just less predictably.
 *
 * A failed batch degrades gracefully -- those artists fall back to their track
 * credit name rather than sinking the whole build.
 */
export async function fetchArtists(artistIds, { onProgress } = {}) {
  const unique = [...new Set(artistIds.filter(Boolean))];
  const resolved = new Map();

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);

    try {
      const response = await apiGet("/artists", { ids: batch.join(",") });
      for (const payload of response.artists || []) {
        if (payload?.id) resolved.set(payload.id, toArtist(payload));
      }
    } catch (error) {
      if (error.needsLogin) throw error;
      console.warn(`Artist batch failed (${batch.length} ids):`, error.message);
    }

    onProgress?.(Math.min(i + BATCH_SIZE, unique.length), unique.length);
  }

  return resolved;
}
