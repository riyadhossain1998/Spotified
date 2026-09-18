"""Domain models.

Plain dataclasses, deliberately decoupled from both the Spotify API shape
and the JSON wire format. Adapters live at the edges: `app.spotify.*` maps
API payloads into these, and `to_dict()` maps these out to the browser.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Sentinel playlist id for the future "Liked Songs" view. Liked songs are not
# a real playlist in Spotify's model (different endpoint, no snapshot_id), so
# they get routed through a dedicated source while reusing the same builders.
LIKED_SONGS_ID = "__liked_songs__"


@dataclass(frozen=True, slots=True)
class ArtistRef:
    """A minimal artist credit as it appears on a track."""

    id: str
    name: str


@dataclass(slots=True)
class Track:
    """A playlist track, flattened to only what the graph needs."""

    id: str
    name: str
    artists: list[ArtistRef]
    popularity: int = 0
    duration_ms: int = 0
    explicit: bool = False
    preview_url: str | None = None
    spotify_url: str | None = None
    album_name: str | None = None
    album_art_url: str | None = None
    release_date: str | None = None
    added_at: str | None = None

    @property
    def artist_ids(self) -> list[str]:
        return [a.id for a in self.artists]

    @property
    def release_year(self) -> int | None:
        if not self.release_date:
            return None
        try:
            return int(self.release_date[:4])
        except ValueError:
            return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "artist_ids": self.artist_ids,
            "artist_names": [a.name for a in self.artists],
            "popularity": self.popularity,
            "duration_ms": self.duration_ms,
            "explicit": self.explicit,
            "preview_url": self.preview_url,
            "spotify_url": self.spotify_url,
            "album_name": self.album_name,
            "album_art_url": self.album_art_url,
            "release_date": self.release_date,
            "release_year": self.release_year,
        }


@dataclass(slots=True)
class Artist:
    """Full artist metadata used to render a node."""

    id: str
    name: str
    popularity: int = 0
    followers: int = 0
    genres: list[str] = field(default_factory=list)
    image_url: str | None = None
    profile_url: str | None = None


@dataclass(slots=True)
class PlaylistRef:
    """Playlist summary for the selection grid."""

    id: str
    name: str
    snapshot_id: str
    track_count: int
    owner_name: str | None = None
    owner_id: str | None = None
    description: str | None = None
    image_url: str | None = None
    spotify_url: str | None = None
    public: bool | None = None
    collaborative: bool = False

    def readable_by(self, user_id: str | None) -> bool:
        """Will Spotify serve this playlist's contents to `user_id`?

        Since the 2026-02 API migration, playlist items are only returned for
        playlists the user owns or collaborates on. Metadata stays public, so a
        followed playlist looks perfectly openable right up until its items come
        back 403 -- which is why this is asked in advance rather than inferred
        from the failure.

        Unknown answers yes. Liked Songs has no owner, and an unauthenticated
        caller has no id to compare; refusing to open anything would be a far
        worse failure than the occasional clear error further down.
        """
        if not user_id or not self.owner_id:
            return True
        return self.collaborative or self.owner_id == user_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "snapshot_id": self.snapshot_id,
            "track_count": self.track_count,
            "owner_name": self.owner_name,
            "owner_id": self.owner_id,
            "description": self.description,
            "image_url": self.image_url,
            "spotify_url": self.spotify_url,
            "public": self.public,
            "collaborative": self.collaborative,
        }


@dataclass(slots=True)
class GraphNode:
    """One node in the rendered network.

    `track_ids` answers "which songs from this playlist feature this artist?"
    -- the node-click interaction reads straight off it.
    """

    id: str
    label: str
    track_ids: list[str] = field(default_factory=list)
    degree: int = 0
    collab_count: int = 0
    image_url: str | None = None
    profile_url: str | None = None
    popularity: int = 0
    followers: int = 0
    genres: list[str] = field(default_factory=list)
    is_primary: bool = False  # the playlist's dominant artist
    # The artists a composite node stands for, biggest contributor first.
    # Empty in artist mode, where a node already *is* one artist; populated in
    # genre mode, where the renderer tiles the first few faces into the circle
    # and the detail panel lists the rest. Each entry is
    # {id, name, image_url, track_count}.
    members: list[dict[str, Any]] = field(default_factory=list)

    @property
    def track_count(self) -> int:
        return len(self.track_ids)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "track_ids": self.track_ids,
            "track_count": self.track_count,
            "degree": self.degree,
            "collab_count": self.collab_count,
            "image_url": self.image_url,
            "profile_url": self.profile_url,
            "popularity": self.popularity,
            "followers": self.followers,
            "genres": self.genres,
            "is_primary": self.is_primary,
            "members": self.members,
        }


@dataclass(slots=True)
class GraphLink:
    """One edge: two artists and every track they share on this playlist.

    Gen 1 emitted a separate link row per (pair, track), so a 3-artist song
    produced 3 rows that all carried the same aggregate count. Here a pair
    appears exactly once and carries the track list, which is both smaller
    on the wire and exactly what the link-click panel needs.
    """

    source: str
    target: str
    track_ids: list[str] = field(default_factory=list)

    @property
    def id(self) -> str:
        return f"{self.source}--{self.target}"

    @property
    def collab_count(self) -> int:
        return len(self.track_ids)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "source": self.source,
            "target": self.target,
            "track_ids": self.track_ids,
            "collab_count": self.collab_count,
        }


@dataclass(slots=True)
class Graph:
    """The complete payload handed to the browser.

    Tracks live in a single id-keyed dict rather than being inlined on nodes
    and links. Both sides reference track ids, so a track shared by five
    artists is stored once instead of five times.
    """

    mode: str
    playlist: PlaylistRef
    nodes: list[GraphNode] = field(default_factory=list)
    links: list[GraphLink] = field(default_factory=list)
    tracks: dict[str, Track] = field(default_factory=dict)
    stats: dict[str, Any] = field(default_factory=dict)
    generated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "mode": self.mode,
            "generated_at": self.generated_at,
            "playlist": self.playlist.to_dict(),
            "stats": self.stats,
            "nodes": [n.to_dict() for n in self.nodes],
            "links": [l.to_dict() for l in self.links],
            "tracks": {tid: t.to_dict() for tid, t in self.tracks.items()},
        }
