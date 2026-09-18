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

PLAYLIST_ID = "pl_test"


class FakeSpotify:
    """Minimal stand-in implementing only the methods our code calls."""

    def __init__(self, snapshot_id: str = "snap1"):
        self.snapshot_id = snapshot_id
        self.artist_batch_calls = 0
        self.track_page_calls = 0

    def current_user(self):
        return {"id": "u1", "display_name": "Test User", "images": [], "product": "premium"}

    def playlist(self, playlist_id, fields=None):
        return {
            "id": playlist_id,
            "name": "Test Playlist",
            "snapshot_id": self.snapshot_id,
            "description": "",
            "public": True,
            "collaborative": False,
            "images": [{"url": "http://img/pl", "width": 640}],
            "external_urls": {"spotify": "http://open/pl"},
            "owner": {"display_name": "Test User"},
            "tracks": {"total": 3},
        }

    def playlist_items(self, playlist_id, limit=100, offset=0, fields=None, additional_types=None):
        self.track_page_calls += 1
        if offset > 0:
            return {"items": [], "next": None}

        def item(track_id, artists, popularity):
            return {
                "added_at": "2024-01-01T00:00:00Z",
                "track": {
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
                {"track": None},                     # local file -> skipped
                {"track": {"id": None, "name": "x"}},  # unavailable -> skipped
            ],
            "next": None,
        }

    def artists(self, artist_ids):
        self.artist_batch_calls += 1
        return {
            "artists": [
                {
                    "id": aid,
                    "name": aid.upper(),
                    "popularity": 70,
                    "followers": {"total": 1234},
                    "genres": ["hip hop"],
                    "images": [{"url": f"http://img/{aid}", "width": 160}],
                    "external_urls": {"spotify": f"http://open/{aid}"},
                }
                for aid in artist_ids
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


def test_graph_page_renders_with_mode_switcher(logged_in):
    response = logged_in.get(f"/playlists/{PLAYLIST_ID}/graph")
    assert response.status_code == 200
    assert b'data-mode="artist"' in response.data
    # Genre mode is present but disabled until its builder is enabled.
    assert b'data-mode="genre"' in response.data


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
    assert modes == {"artist": True, "genre": False}


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
    # One batched artist call, not one per artist.
    assert fake_spotify.artist_batch_calls == 1


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


def test_unavailable_mode_is_rejected(logged_in):
    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph?mode=genre")
    assert response.status_code == 409
    assert response.get_json()["error"] == "mode_unavailable"


def test_unknown_mode_is_rejected(logged_in):
    response = logged_in.get(f"/api/playlists/{PLAYLIST_ID}/graph?mode=nonsense")
    assert response.status_code == 400
    assert response.get_json()["error"] == "unknown_mode"


def test_playlists_listing_includes_liked_songs_first(logged_in):
    payload = logged_in.get("/api/playlists").get_json()

    assert payload["items"][0]["is_liked_songs"] is True
    assert payload["items"][0]["name"] == "Liked Songs"
    assert payload["items"][1]["id"] == PLAYLIST_ID


def test_playback_endpoint(logged_in):
    response = logged_in.put("/api/playback/track/abc123")
    assert response.get_json() == {"status": "playing", "track_id": "abc123"}


def test_logout_clears_session(logged_in):
    logged_in.get("/auth/logout")
    assert logged_in.get("/api/playlists").status_code == 401
