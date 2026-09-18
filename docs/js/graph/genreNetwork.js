/**
 * Genre network, built in the browser.
 *
 * A port of app/graph/builders/genre_network.py, which is where the reasoning
 * lives -- why the vocabulary exists, why the match is longest-first, and what
 * an edge means. The rules themselves are generated into genreAliases.js from
 * that same file, so the only thing duplicated here is the loop over them.
 *
 * Output shape matches buildArtistNetwork exactly, which is what lets
 * artistNetworkView.js and detailPanel.js render either one unmodified.
 */

import { GENRE_ALIASES, UNCLASSIFIED, WEAK_ALIASES } from "./genreAliases.js";

const SCHEMA_VERSION = 1;

/** Below this many bridging tracks an edge is noise; see the Python builder. */
const MIN_EDGE_WEIGHT = 2;

// Longest fragment first, so the scan below can return on its first hit and
// still be the longest match. "reggaeton" has to be tried before "reggae".
const byLength = (rules) =>
  Object.entries(rules).sort((a, b) => b[0].length - a[0].length);

const ALIASES_BY_LENGTH = byLength(GENRE_ALIASES);
// A second pass, not more entries in the first: length stands in for
// specificity only among rules that name a genre, and "girl group" is longer
// than "k-pop" without being more specific. See the Python builder.
const WEAK_BY_LENGTH = byLength(WEAK_ALIASES);

/** Fold one Spotify micro-genre into a top-level bucket. */
export function normaliseGenre(raw) {
  const needle = raw.toLowerCase();
  for (const [fragment, canonical] of ALIASES_BY_LENGTH) {
    if (needle.includes(fragment)) return canonical;
  }
  for (const [fragment, canonical] of WEAK_BY_LENGTH) {
    if (needle.includes(fragment)) return canonical;
  }
  // Unrecognised labels survive as themselves rather than vanishing.
  return needle;
}

/**
 * The buckets one artist contributes.
 *
 * An artist Spotify has no genres for is bucketed rather than dropped, or the
 * genre totals stop adding up to the playlist length.
 */
function bucketsFor(meta) {
  if (!meta?.genres?.length) return new Set([UNCLASSIFIED]);
  return new Set(meta.genres.map(normaliseGenre));
}

/**
 * Edges are tracks spanning two genres.
 *
 * The unit is the track, not the artist pair: one song by three rappers and a
 * house producer is a single hip hop--electronic bridge. Taking the union of
 * the track's genres before pairing is what collapses that.
 */
function collectPairs(tracks, artistGenres) {
  const pairs = new Map();

  for (const track of tracks) {
    const genres = new Set();
    for (const artistId of new Set(track.artist_ids)) {
      for (const genre of artistGenres.get(artistId) || []) genres.add(genre);
    }

    const ordered = [...genres].sort();
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const key = `${ordered[i]}--${ordered[j]}`;
        const existing = pairs.get(key);
        if (existing) existing.track_ids.push(track.id);
        else {
          pairs.set(key, {
            source: ordered[i],
            target: ordered[j],
            track_ids: [track.id],
          });
        }
      }
    }
  }

  return pairs;
}

/** degree = genres bridged to; collab_count = bridging tracks. */
function degreeAndCollabs(links) {
  const degree = new Map();
  const collabs = new Map();

  for (const link of links) {
    for (const id of [link.source, link.target]) {
      degree.set(id, (degree.get(id) || 0) + 1);
      collabs.set(id, (collabs.get(id) || 0) + link.collab_count);
    }
  }

  return { degree, collabs };
}

/** Artists inside one genre, biggest contributor first. */
function membersOf(artistTracks, metadata) {
  return [...artistTracks.entries()]
    .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
    .map(([artistId, trackIds]) => {
      const meta = metadata.get(artistId);
      return {
        id: artistId,
        name: meta?.name ?? "Unknown artist",
        image_url: meta?.image_url ?? null,
        track_count: trackIds.size,
      };
    });
}

/** Only the headline numbers the graph header renders. */
function summarise(nodes, links, tracks) {
  return {
    track_count: tracks.length,
    // A node count under an older name; the header supplies the noun.
    artist_count: nodes.length,
    connection_count: links.length,
    collaboration_track_count: tracks.filter((t) => t.artist_ids.length > 1).length,
    solo_artist_count: nodes.filter((n) => n.degree === 0).length,
  };
}

export function buildGenreNetwork(
  playlist,
  tracks,
  artistMetadata,
  { includeSoloGenres = true, minEdgeWeight = MIN_EDGE_WEIGHT } = {}
) {
  // Resolve each artist once; everything below reads this rather than
  // re-normalising per track.
  const artistGenres = new Map();
  for (const track of tracks) {
    for (const artistId of track.artist_ids) {
      if (!artistGenres.has(artistId)) {
        artistGenres.set(artistId, bucketsFor(artistMetadata.get(artistId)));
      }
    }
  }

  const genreTracks = new Map(); // genre -> Set(track id)
  const genreArtists = new Map(); // genre -> Map(artist id -> Set(track id))
  const rawLabels = new Map(); // genre -> Set(original Spotify label)

  for (const track of tracks) {
    for (const artistId of new Set(track.artist_ids)) {
      for (const genre of artistGenres.get(artistId)) {
        if (!genreTracks.has(genre)) genreTracks.set(genre, new Set());
        genreTracks.get(genre).add(track.id);

        if (!genreArtists.has(genre)) genreArtists.set(genre, new Map());
        const byArtist = genreArtists.get(genre);
        if (!byArtist.has(artistId)) byArtist.set(artistId, new Set());
        byArtist.get(artistId).add(track.id);
      }
    }
  }

  for (const artistId of artistGenres.keys()) {
    for (const raw of artistMetadata.get(artistId)?.genres || []) {
      const bucket = normaliseGenre(raw);
      if (!rawLabels.has(bucket)) rawLabels.set(bucket, new Set());
      rawLabels.get(bucket).add(raw);
    }
  }

  const links = [...collectPairs(tracks, artistGenres).values()]
    .filter((p) => p.track_ids.length >= minEdgeWeight)
    .map((p) => ({
      id: `${p.source}--${p.target}`,
      source: p.source,
      target: p.target,
      track_ids: [...p.track_ids].sort(),
      collab_count: p.track_ids.length,
    }));

  let nodeIds = [...genreTracks.keys()];
  if (!includeSoloGenres) {
    const connected = new Set(links.flatMap((l) => [l.source, l.target]));
    nodeIds = nodeIds.filter((g) => connected.has(g));
  }

  const { degree, collabs } = degreeAndCollabs(links);

  let primaryId = null;
  let primaryCount = -1;
  for (const genre of nodeIds) {
    const count = genreTracks.get(genre).size;
    if (count > primaryCount) {
      primaryId = genre;
      primaryCount = count;
    }
  }

  const nodes = nodeIds.map((genre) => {
    const members = membersOf(genreArtists.get(genre), artistMetadata);
    const trackIds = [...genreTracks.get(genre)].sort();

    return {
      id: genre,
      label: genre,
      track_ids: trackIds,
      track_count: trackIds.length,
      degree: degree.get(genre) || 0,
      collab_count: collabs.get(genre) || 0,
      // A single image so anything expecting one still has it; `members` is
      // what the mosaic actually draws.
      image_url: members.find((m) => m.image_url)?.image_url ?? null,
      profile_url: null,
      popularity: 0,
      followers: 0,
      // The Spotify labels that folded in here, which is the only way to see
      // that "hip hop" absorbed "toronto rap".
      genres: [...(rawLabels.get(genre) || [])].sort(),
      is_primary: genre === primaryId,
      members,
    };
  });

  nodes.sort((a, b) => b.track_count - a.track_count || (a.label < b.label ? -1 : 1));

  const trackIndex = {};
  for (const track of tracks) trackIndex[track.id] = track;

  return {
    schema_version: SCHEMA_VERSION,
    mode: "genre",
    generated_at: new Date().toISOString(),
    playlist,
    stats: summarise(nodes, links, tracks),
    nodes,
    links,
    tracks: trackIndex,
  };
}
