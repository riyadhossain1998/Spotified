/**
 * Playlist reads: the user's playlists, and the tracks inside one.
 *
 * A direct port of app/spotify/playlists.py. The `fields` mask matters as much
 * here as it does there -- asking for album art, release date and duration in
 * the same call that fetches the tracks is what removes an entire second pass
 * of one request per track.
 *
 * Tracks come out already in the wire format the D3 view expects (the shape
 * Track.to_dict() produces on the server), so there is no second mapping layer
 * between here and the renderer.
 */

import { MAX_PLAYLIST_TRACKS } from "../config.js";
import { apiGet, apiGetAll } from "./client.js";

const PAGE_SIZE = 50; // Spotify's max for playlist listings
const TRACK_PAGE_SIZE = 100; // Spotify's max for playlist items

const TRACK_FIELDS = [
  "next",
  "items(added_at,track(",
  "id,name,popularity,duration_ms,explicit,",
  "external_urls(spotify),",
  "artists(id,name),",
  "album(name,release_date,images)",
  "))",
].join("");

const PLAYLIST_FIELDS =
  "id,name,snapshot_id,description,public,collaborative," +
  "images,external_urls(spotify),owner(display_name),tracks(total)";

function firstImage(images) {
  return images?.length ? images[0].url : null;
}

/** Album art is only ever a thumbnail here, so take the cheapest size. */
function smallestImage(images) {
  if (!images?.length) return null;
  return images.reduce((best, image) =>
    (image.width || 10000) < (best.width || 10000) ? image : best
  ).url;
}

export function toPlaylistRef(payload) {
  return {
    id: payload.id,
    name: payload.name || "Untitled playlist",
    snapshot_id: payload.snapshot_id || "",
    track_count: payload.tracks?.total ?? 0,
    owner_name: payload.owner?.display_name ?? null,
    description: payload.description || null,
    image_url: firstImage(payload.images),
    spotify_url: payload.external_urls?.spotify ?? null,
    public: payload.public ?? null,
    collaborative: Boolean(payload.collaborative),
  };
}

/** One page of the current user's playlists, plus whether more exist. */
export async function listPlaylists({ limit = PAGE_SIZE, offset = 0 } = {}) {
  const page = await apiGet("/me/playlists", {
    limit: Math.min(limit, PAGE_SIZE),
    offset,
  });

  // Spotify occasionally returns nulls in this array for playlists the account
  // can no longer see.
  const items = (page.items || []).filter(Boolean).map(toPlaylistRef);

  return { items, total: page.total ?? items.length, hasMore: Boolean(page.next) };
}

export async function getPlaylist(playlistId) {
  const payload = await apiGet(`/playlists/${encodeURIComponent(playlistId)}`, {
    fields: PLAYLIST_FIELDS,
  });
  return toPlaylistRef(payload);
}

/**
 * Map one playlist item to a track, or null if it is not usable.
 *
 * Items get skipped when they are local files, podcast episodes, or tracks
 * pulled from the catalogue -- all of which arrive with a null id.
 *
 * preview_url is deliberately not requested: Spotify appends the app's client
 * id to those URLs, and this payload is handled by code that also writes
 * committed demo files.
 */
function toTrack(item) {
  const raw = item?.track;
  if (!raw?.id) return null;

  const artists = (raw.artists || []).filter((a) => a?.id);
  if (artists.length === 0) return null;

  const releaseDate = raw.album?.release_date || null;
  const year = releaseDate ? Number.parseInt(releaseDate.slice(0, 4), 10) : NaN;

  return {
    id: raw.id,
    name: raw.name || "Untitled",
    artist_ids: artists.map((a) => a.id),
    artist_names: artists.map((a) => a.name || "Unknown"),
    popularity: raw.popularity || 0,
    duration_ms: raw.duration_ms || 0,
    explicit: Boolean(raw.explicit),
    preview_url: null,
    spotify_url: raw.external_urls?.spotify ?? null,
    album_name: raw.album?.name ?? null,
    album_art_url: smallestImage(raw.album?.images),
    release_date: releaseDate,
    release_year: Number.isNaN(year) ? null : year,
  };
}

/**
 * Every playable track in a playlist, de-duplicated by track id.
 *
 * Discography playlists routinely contain the same song twice (an album cut
 * plus a deluxe or remastered edition). Counting it once keeps collaboration
 * weights honest.
 */
export async function fetchPlaylistTracks(playlistId, { onProgress } = {}) {
  const items = await apiGetAll(
    `/playlists/${encodeURIComponent(playlistId)}/tracks`,
    { limit: TRACK_PAGE_SIZE, fields: TRACK_FIELDS, additional_types: "track" },
    { limit: MAX_PLAYLIST_TRACKS, onPage: onProgress }
  );

  const byId = new Map();
  for (const item of items) {
    const track = toTrack(item);
    if (track && !byId.has(track.id)) byId.set(track.id, track);
  }
  return [...byId.values()];
}
