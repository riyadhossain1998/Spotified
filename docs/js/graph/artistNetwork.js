/**
 * Artist collaboration network, built in the browser.
 *
 * A port of app/graph/builders/artist_network.py. The output is byte-for-byte
 * the same payload shape the Flask API returns, which is what lets this build
 * reuse artistNetworkView.js and detailPanel.js unmodified.
 *
 * Algorithm
 * ---------
 * For each track, sort the credited artist ids and emit every unordered pair:
 *
 *     ["A", "B", "C"]  ->  (A,B) (A,C) (B,C)
 *
 * Sorting first is what makes the pair canonical: without it the same
 * collaboration shows up as both (A,B) and (B,A) and gets drawn twice. Pairs
 * accumulate into a map keyed by the pair, so collab_count falls out of the
 * track list length for free -- no separate counting pass.
 *
 * The nested loop is O(k^2) in the credits on a single track, where k is almost
 * always under six, so cost is effectively linear in playlist length.
 */

const SCHEMA_VERSION = 1;

/** Map every canonical artist pair to the tracks they share. */
function collectPairs(tracks) {
  const pairs = new Map();

  for (const track of tracks) {
    // Dedupe first: an artist occasionally appears twice in one track's
    // credits, which would otherwise create a self-loop.
    const artistIds = [...new Set(track.artist_ids)].sort();

    for (let i = 0; i < artistIds.length; i += 1) {
      for (let j = i + 1; j < artistIds.length; j += 1) {
        const key = `${artistIds[i]}--${artistIds[j]}`;
        const existing = pairs.get(key);
        if (existing) existing.track_ids.push(track.id);
        else {
          pairs.set(key, {
            source: artistIds[i],
            target: artistIds[j],
            track_ids: [track.id],
          });
        }
      }
    }
  }

  return pairs;
}

/** Map every artist to the set of tracks they appear on. */
function collectArtistTracks(tracks) {
  const artistTracks = new Map();

  for (const track of tracks) {
    for (const artistId of new Set(track.artist_ids)) {
      let set = artistTracks.get(artistId);
      if (!set) artistTracks.set(artistId, (set = new Set()));
      set.add(track.id);
    }
  }

  return artistTracks;
}

/**
 * Decide which artists become nodes.
 *
 * With includeSoloArtists (the default) every credited artist is kept, even
 * those whose tracks are all solo. They render as isolated nodes the UI can
 * toggle off -- dropping them at build time is not recoverable at render time,
 * which is the mistake the previous generation made by deriving nodes from the
 * link list.
 */
function selectNodeIds(pairs, artistTracks, includeSoloArtists) {
  if (includeSoloArtists) return [...artistTracks.keys()];

  const connected = new Set();
  for (const { source, target } of pairs.values()) {
    connected.add(source);
    connected.add(target);
  }
  return [...artistTracks.keys()].filter((id) => connected.has(id));
}

/** degree = distinct collaborators; collab_count = collaboration tracks. */
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

/**
 * The artist on the most tracks. For a discography playlist this is the artist
 * the playlist is about, so the UI can highlight them without being told who.
 */
function primaryArtistId(artistTracks, nodeIds) {
  let best = null;
  let bestCount = -1;

  for (const id of nodeIds) {
    const count = artistTracks.get(id)?.size || 0;
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }

  return best;
}

/** Use the credit name when the artist endpoint returned nothing. */
function fallbackName(artistId, tracks) {
  for (const track of tracks) {
    const index = track.artist_ids.indexOf(artistId);
    if (index !== -1) return track.artist_names[index];
  }
  return "Unknown artist";
}

/** Only the headline numbers the graph header renders. */
function summarise(nodes, links, tracks) {
  return {
    track_count: tracks.length,
    artist_count: nodes.length,
    connection_count: links.length,
    collaboration_track_count: tracks.filter((t) => t.artist_ids.length > 1).length,
    solo_artist_count: nodes.filter((n) => n.degree === 0).length,
  };
}

export function buildArtistNetwork(
  playlist,
  tracks,
  artistMetadata,
  { includeSoloArtists = true } = {}
) {
  const pairs = collectPairs(tracks);
  const artistTracks = collectArtistTracks(tracks);
  const nodeIds = selectNodeIds(pairs, artistTracks, includeSoloArtists);
  const nodeIdSet = new Set(nodeIds);

  const links = [...pairs.values()]
    .filter((p) => nodeIdSet.has(p.source) && nodeIdSet.has(p.target))
    .map((p) => ({
      id: `${p.source}--${p.target}`,
      source: p.source,
      target: p.target,
      track_ids: p.track_ids,
      collab_count: p.track_ids.length,
    }));

  const { degree, collabs } = degreeAndCollabs(links);
  const primaryId = primaryArtistId(artistTracks, nodeIds);

  const nodes = nodeIds.map((artistId) => {
    const meta = artistMetadata.get(artistId);
    const trackIds = [...(artistTracks.get(artistId) || [])].sort();

    return {
      id: artistId,
      label: meta ? meta.name : fallbackName(artistId, tracks),
      track_ids: trackIds,
      track_count: trackIds.length,
      degree: degree.get(artistId) || 0,
      collab_count: collabs.get(artistId) || 0,
      image_url: meta?.image_url ?? null,
      profile_url: meta?.profile_url ?? null,
      popularity: meta?.popularity ?? 0,
      followers: meta?.followers ?? 0,
      genres: meta?.genres ?? [],
      is_primary: artistId === primaryId,
    };
  });

  // Biggest contributors first. A stable order means the force simulation lays
  // the same playlist out the same way every time.
  nodes.sort((a, b) => {
    if (a.track_count !== b.track_count) return b.track_count - a.track_count;
    const left = a.label.toLowerCase();
    const right = b.label.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const trackIndex = {};
  for (const track of tracks) trackIndex[track.id] = track;

  return {
    schema_version: SCHEMA_VERSION,
    mode: "artist",
    generated_at: new Date().toISOString(),
    playlist,
    stats: summarise(nodes, links, tracks),
    nodes,
    links,
    tracks: trackIndex,
  };
}
