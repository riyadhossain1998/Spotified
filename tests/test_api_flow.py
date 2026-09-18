"""End-to-end tests through the Flask test client.

A fake spotipy client stands in for Spotify so the route -> service -> builder
-> cache path is exercised for real, including the cache hit on a second
request and the rebuild when a playlist's snapshot_id changes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import create_app
from app.auth.session import PROFILE_KEY, TOKEN_KEY
from app.graph.builders.genre_network import GenreNetworkBuilder

PLAYLIST_ID = "pl_test"


class FakeSpotify:
    """Minimal stand-in implementing only the methods our code calls."""

    def __init__(self, snapshot_id: str = "snap1"):
        self.snapshot_id = snapshot_id
        self.artist_calls: list[list[str]] = []
        self.track_page_calls = 0
        # Matches the signed-in profile below, so the playlist is readable by
        # default. Tests reassign these to model a followed playlist.
        self.owner_id = "u1"
        self.collaborative = False

    def current_user(self):
        return {"id": "u1", "display_name": "Test User", "images": [], "product": "premium"}

    def playlist(self, playlist_id, fields=None):
        return {
            "id": playlist_id,
            "name": "Test Playlist",
            "snapshot_id": self.snapshot_id,
            "description": "",
            "public": True,
            "collaborative": self.collaborative,
            "images": [{"url": "http://img/pl", "width": 640}],
            "external_urls": {"spotify": "http://open/pl"},
            "owner": {"display_name": "Test User", "id": self.owner_id},
            "items": {"total": 3},
        }

    def _get_id(self, type_, id_):
        return id_

    def _get(self, path, limit=50, offset=0, fields=None, additional_types=None):
        # The 2026 API serves playlist contents from /items; /tracks is gone and
        # answers 403, so a fake that still accepted it would hide a real break.
        assert path == f"playlists/{PLAYLIST_ID}/items", path
        self.track_page_calls += 1
        if offset > 0:
            return {"items": [], "next": None}

        def item(track_id, artists, popularity):
            return {
                "added_at": "2024-01-01T00:00:00Z",
                "item": {
                    "id": track_id,
                    "name": f"Song {track_id}",
                    "popularity": popularity,
                    "duration_ms": 200_000,
                    "explicit": False,
                    "preview_url": None,
                    "external_urls": {"spotify": f"http://open/{track_id}"},
                    "artists": [{"id": a, "name": a.upper()} for a in artists],
                    "album": {
                        "name": "Album",
                        "release_date": "2021-05-01",
                        "images": [{"url": f"http://img/{track_id}", "width": 64}],
                    },
                },
            }

        return {
            "items": [
                item("t1", ["a1", "a2"], 80),
                item("t2", ["a1", "a3"], 60),
                item("t3", ["a1"], 40),
                {"item": None},                      # local file -> skipped
                {"item": {"id": None, "name": "x"}},  # unavailable -> skipped
            ],
            "next": None,
        }

    def artists(self, ids):
        # One call per batch of 50. `append` records the shape of each request,
        # not just the ids, so a regression back to per-artist lookups fails the
        # assertion rather than merely slowing the app down.
        self.artist_calls.append(list(ids))
        return {
            "artists": [
                {
                    "id": artist_id,
                    "name": artist_id.upper(),
                    "popularity": 70,
                    "followers": {"total": 1234},
                    "genres": ["hip hop"],
                    "images": [{"url": f"http://img/{artist_id}", "width": 160}],
                    "external_urls": {"spotify": f"http://open/{artist_id}"},
                }
                for artist_id in ids
            ]
        }

    def current_user_saved_tracks(self, limit=50, offset=0):
        return {"total": 0, "items": [], "next": None}

    def current_user_playlists(self, limit=50, offset=0):
        return {"items": [self.playlist(PLAYLIST_ID)], "total": 1}

    def start_playback(self, uris=None):
        return None


@pytest.fixture
def fake_spotify():
    return FakeSpotify()


@pytest.fixture
def app(tmp_path, fake_spotify, monkeypatch):
    application = create_app("testing")
    application.config["CACHE_DIR"] = tmp_path / "graphs"
    application.config["CACHE_DIR"].mkdir(parents=True, exist_ok=True)

    # The API blueprint imported require_client by name, so patch it there.
    monkeypatch.setattr("app.api.routes.require_client", lambda: fake_spotify)
    monkeypatch.setattr("app.views.main.require_client", lambda: fake_spotify, raising=False)

    return application


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def logged_in(client):
    """Populate the session the way a completed OAuth callback would."""
    with client.session_transaction() as session:
        session[TOKEN_KEY] = {"access_token": "fake", "expires_at": 9_999_999_999}
        session[PROFILE_KEY] = {"id": "u1", "display_name": "Test User"}
    return client


# ---------------------------------------------------------------- pages

def test_landing_renders_for_anonymous_visitor(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"Sign in with Spotify" in response.data


def test_protected_page_redirects_to_login(client):
    response = client.get("/playlists")
    assert response.status_code == 302
    assert "/auth/login" in response.headers["Location"]


def test_landing_redirects_when_signed_in(logged_in):
    response = logged_in.get("/")
    assert response.status_code == 302
    assert "/playlists" in response.headers["Location"]


def test_playlists_page_renders(logged_in):
    response = logged_in.get("/playlists")
    assert response.status_code == 200
    assert b"playlist-grid" in response.data
    # The hooks playlistsPage.js writes into for unreadable playlists. Without
    # them the locked-card branch silently does nothing.
    assert b"playlist-notice" in response.data
    assert b"playlist-card__note" in response.data


def test_graph_page_renders_with_mode_switcher(logged_in):
    response = logged_in.get(f"/playlists/{PLAYLIST_ID}/graph")
    assert response.status_code == 200
    assert b'data-mode="artist"' in response.data
    assert b'data-mode="genre"' in response.data
    # Both builders are available, so neither button renders disabled.
    assert b"disabled" not in response.data


def test_healthz(client):
    assert client.get("/healthz").get_json() == {"status": "ok"}


# ------------------------------------------------------------------ api

def test_api_requires_auth(client):
    response = client.get("/api/playlists")
    assert response.status_code == 401
    assert response.get_json()["error"] == "not_authenticated"


def test_modes_endpoint_reports_availability(client):
    payload = client.get("/api/modes").get_json()
    modes = {m["mode"]: m["available"] for m in payload["modes"]}

    assert payload["default"] == "artist"
    assert modes == {"artist": True, "genre": True}


def test_graph_build_then_cache_hit(logged_in, fake_spotify):
    first = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")
    assert first.status_code == 200
    assert first.headers["X-FN-Cache"] == "miss"

    graph = first.get_json()
    assert graph["mode"] == "artist"
    assert {n["id"] for n in graph["nodes"]} == {"a1", "a2", "a3"}
    # a1+a2 on t1, a1+a3 on t2; t3 is solo so contributes no link.
    assert {(l["source"], l["target"]) for l in graph["links"]} == {
        ("a1", "a2"),
        ("a1", "a3"),
    }
    assert set(graph["tracks"]) == {"t1", "t2", "t3"}

    calls_after_build = fake_spotify.track_page_calls

    second = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")
    assert second.headers["X-FN-Cache"] == "hit"
    assert second.get_json() == graph
    # The cache hit must not re-fetch tracks.
    assert fake_spotify.track_page_calls == calls_after_build


def test_node_carries_its_playlist_tracks(logged_in):
    graph = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph").get_json()
    nodes = {n["id"]: n for n in graph["nodes"]}

    assert sorted(nodes["a1"]["track_ids"]) == ["t1", "t2", "t3"]
    assert nodes["a1"]["is_primary"] is True
    assert nodes["a2"]["track_ids"] == ["t1"]


def test_link_carries_shared_tracks(logged_in):
    graph = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph").get_json()
    link = next(l for l in graph["links"] if l["target"] == "a2")

    assert link["track_ids"] == ["t1"]
    assert link["collab_count"] == 1


def test_enrichment_fields_present_without_a_second_pass(logged_in, fake_spotify):
    """release_date/duration/album art arrive with the track fetch itself."""
    graph = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph").get_json()
    track = graph["tracks"]["t1"]

    assert track["release_date"] == "2021-05-01"
    assert track["release_year"] == 2021
    assert track["duration_ms"] == 200_000
    assert track["album_art_url"] == "http://img/t1"
    # Every distinct artist in a single batched request, and none resolved twice.
    # Issuing one request per artist is what exhausted the rate limit and left
    # every node without an image or a genre, so the request count is the thing
    # under test here, not just the ids.
    # Order within a batch comes from upstream set iteration and means nothing.
    assert len(fake_spotify.artist_calls) == 1
    assert sorted(fake_spotify.artist_calls[0]) == ["a1", "a2", "a3"]


def test_snapshot_change_invalidates_cache(logged_in, fake_spotify):
    logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")

    fake_spotify.snapshot_id = "snap2"  # simulate an edited playlist

    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")
    assert response.headers["X-FN-Cache"] == "miss"


def test_refresh_flag_forces_rebuild(logged_in):
    logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")

    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph?refresh=1")
    assert response.headers["X-FN-Cache"] == "miss"


def test_graph_status_reports_cache_state(logged_in):
    before = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph/status").get_json()
    assert before["cached"] is False

    logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")

    after = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph/status").get_json()
    assert after["cached"] is True


def test_invalidate_endpoint_clears_cache(logged_in):
    logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")

    result = logged_in.delete(f"/api/playlists/{PLAYLIST_ID}/graph").get_json()
    assert result["invalidated"] == 1

    status = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph/status").get_json()
    assert status["cached"] is False


def test_unavailable_mode_is_rejected(logged_in, monkeypatch):
    """A registered but switched-off mode answers 409, not 400 or a graph.

    Both shipped modes are available now, so this stands a builder down to
    exercise the path. It stays covered because the next mode to be added
    lands here first, and a 400 would tell the front end the mode does not
    exist rather than that it is not ready.
    """
    monkeypatch.setattr(GenreNetworkBuilder, "available", False)

    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph?mode=genre")
    assert response.status_code == 409
    assert response.get_json()["error"] == "mode_unavailable"


def test_genre_mode_builds_a_graph(logged_in):
    """Every artist in the fixture is "hip hop", so they collapse to one node."""
    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph?mode=genre")
    assert response.status_code == 200

    graph = response.get_json()
    assert graph["mode"] == "genre"
    assert [n["id"] for n in graph["nodes"]] == ["hip hop"]
    assert sorted(graph["nodes"][0]["track_ids"]) == ["t1", "t2", "t3"]
    # The mosaic needs faces; without members the node renders as a blank circle.
    assert [m["id"] for m in graph["nodes"][0]["members"]] == ["a1", "a2", "a3"]


def test_unknown_mode_is_rejected(logged_in):
    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph?mode=nonsense")
    assert response.status_code == 400
    assert response.get_json()["error"] == "unknown_mode"


def test_playlists_listing_includes_liked_songs_first(logged_in):
    payload = logged_in.get("/api/playlists").get_json()

    assert payload["items"][0]["is_liked_songs"] is True
    assert payload["items"][0]["name"] == "Liked Songs"
    assert payload["items"][1]["id"] == PLAYLIST_ID


def test_listing_flags_playlists_spotify_will_not_serve(logged_in, fake_spotify):
    """The grid needs to know before the user clicks, not after a 403."""
    owned = logged_in.get("/api/playlists").get_json()["items"][1]
    assert owned["readable"] is True

    fake_spotify.owner_id = "someone_else"
    followed = logged_in.get("/api/playlists").get_json()["items"][1]
    assert followed["readable"] is False

    # Collaborators count as owners, so this one stays openable.
    fake_spotify.collaborative = True
    shared = logged_in.get("/api/playlists").get_json()["items"][1]
    assert shared["readable"] is True


def test_graph_refuses_a_playlist_the_user_cannot_read(logged_in, fake_spotify):
    fake_spotify.owner_id = "someone_else"

    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph")
    assert response.status_code == 403
    assert response.get_json()["error"] == "playlist_not_readable"
    # The point of the check: the request Spotify would reject is never made.
    assert fake_spotify.track_page_calls == 0


def test_playback_endpoint(logged_in):
    response = logged_in.put("/api/playback/track/abc123")
    assert response.get_json() == {"status": "playing", "track_id": "abc123"}


def test_logout_clears_session(logged_in):
    logged_in.get("/auth/logout")
    assert logged_in.get("/api/playlists").status_code == 401
