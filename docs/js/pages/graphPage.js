/**
 * Builds and renders one playlist's network entirely in the browser.
 *
 * This is the client-side counterpart to app/graph/service.py plus
 * app/static/js/pages/graphPage.js. The server version asks the API for a
 * finished payload; here the three steps that produce it -- fetch tracks,
 * resolve artists, run the builder -- happen in front of the user, so the
 * loader reports each one rather than spinning silently through what can be a
 * few seconds of requests on a large playlist.
 */

// ../../static/ is populated by scripts/build_pages.py from app/static/, so the
// renderer and formatters here are literally the app's own files, not copies.
import { trackVisit } from "../../static/js/analytics.js";
import { formatNumber, nodeNoun, pluralise } from "../../static/js/format.js";
import { ArtistNetworkView } from "../../static/js/graph/artistNetworkView.js";
import { applyModeLabels, initGraphChrome } from "../../static/js/graph/chrome.js";
import { DetailPanel } from "../../static/js/graph/detailPanel.js";
import { buildArtistNetwork } from "../graph/artistNetwork.js";
import { buildGenreNetwork } from "../graph/genreNetwork.js";
import { currentUser } from "../auth/session.js";
import { fetchArtists } from "../spotify/artists.js";
import {
  canReadContents,
  fetchPlaylistTracks,
  getPlaylist,
} from "../spotify/playlists.js";
import { loginAgainButton, renderTopbarUser, requireLogin } from "../ui/topbar.js";

export async function initGraphPage() {
  trackVisit();

  const playlistId = new URLSearchParams(window.location.search).get("playlist");

  if (!requireLogin()) return; // redirecting

  const user = currentUser();
  renderTopbarUser(user);

  const canvas = document.getElementById("graph-canvas");
  const loader = document.getElementById("graph-loader");
  const loaderText = document.getElementById("graph-loader-text");
  const nameEl = document.getElementById("graph-playlist-name");
  const statsEl = document.getElementById("graph-playlist-stats");
  const artEl = document.getElementById("graph-playlist-art");
  const soloToggle = document.getElementById("toggle-solo");
  const nodeSearch = document.getElementById("node-search");
  const modeButtons = [...document.querySelectorAll(".mode-switch__btn")];

  const panel = new DetailPanel(document.getElementById("detail-panel"), {
    onPlayTrack: () => {
      throw new Error("Playback needs the full app and a Spotify Premium device.");
    },
    onClose: () => view?.clearSelection(),
  });

  const BUILDERS = { artist: buildArtistNetwork, genre: buildGenreNetwork };

  let view = null;
  let chrome = null;
  let mode = "artist";
  // Kept so a mode switch is a rebuild, not another round of Spotify requests:
  // both builders read the same tracks and the same artist metadata.
  let source = null;

  function showError(error) {
    const message = typeof error === "string" ? error : error.message;

    loader.hidden = false;
    loader.innerHTML = "";

    const heading = document.createElement("p");
    heading.className = "loader__text";
    heading.textContent = "Could not build this graph";

    const detail = document.createElement("p");
    detail.className = "loader__hint";
    detail.textContent = message;

    const back = document.createElement("a");
    back.className = "btn btn--ghost btn--sm";
    back.href = "playlists.html";
    back.textContent = "Back to playlists";

    loader.append(heading, detail, back);

    // Offered, never performed automatically: Spotify returns from a re-login
    // instantly once consent exists, so redirecting on a failure that outlives
    // the login would just bring the user straight back here, forever.
    if (error?.needsLogin) {
      loader.appendChild(
        loginAgainButton(window.location.pathname + window.location.search)
      );
    }
  }

  /** Rebuild and re-render from data already in hand. */
  function renderMode() {
    const graph = BUILDERS[mode](source.playlist, source.tracks, source.metadata);

    const parts = [
      pluralise(graph.stats.artist_count, nodeNoun(graph.mode)),
      pluralise(graph.stats.connection_count, "connection"),
      `${formatNumber(graph.stats.track_count)} tracks`,
    ];
    if (mode === "artist") {
      parts.push(`${formatNumber(graph.stats.collaboration_track_count)} collabs`);
    }
    statsEl.textContent = parts.join(" · ");

    applyModeLabels(graph.mode);
    panel.setGraph(graph);
    panel.reset();

    // Torn down together: the chrome's controls close over the view they were
    // given, and its button is a child of the canvas, so leaving it behind
    // would stack a second one on every switch.
    chrome?.destroy();
    view?.destroy();
    view = new ArtistNetworkView(canvas, {
      onSelectNode: (node) => panel.showNode(node),
      onSelectLink: (link) => panel.showLink(link),
      onClearSelection: () => panel.reset(),
    });
    view.render(graph);
    view.setHideUnconnected(soloToggle.checked);
    if (nodeSearch.value) view.highlightSearch(nodeSearch.value);
    chrome = initGraphChrome(view);
  }

  if (!playlistId) {
    showError("No playlist in the URL. Pick one from your playlists.");
    return;
  }

  try {
    loaderText.textContent = "Reading the playlist…";
    const playlist = await getPlaylist(playlistId);

    document.title = `${playlist.name} — Spotified`;
    nameEl.textContent = playlist.name;
    if (playlist.image_url) {
      artEl.src = playlist.image_url;
      artEl.hidden = false;
    }

    // Metadata is readable for any playlist, contents are not. Checking here
    // turns the 403 that would follow into an explanation, and matters most on
    // this page: a bookmark or a shared link arrives without ever passing the
    // grid, where these playlists are already greyed out.
    if (!canReadContents(playlist, user?.id)) {
      showError(
        `"${playlist.name}" belongs to ${playlist.owner_name || "another Spotify user"}. ` +
          "Since February 2026 Spotify only lets apps read playlists you own or " +
          "collaborate on. To graph it, open it in Spotify, select every track, " +
          "and add them to a new playlist of your own — then build the graph from that copy."
      );
      return;
    }

    const tracks = await fetchPlaylistTracks(playlistId, {
      onProgress: (loaded, total) => {
        loaderText.textContent = total
          ? `Fetching tracks… ${loaded} of ${total}`
          : `Fetching tracks… ${loaded}`;
      },
    });

    if (tracks.length === 0) {
      showError("This playlist has no playable tracks — local files and podcast episodes cannot be graphed.");
      return;
    }

    // Every credited artist needs metadata, not just the collaborating ones:
    // solo artists still render as nodes and still need a name and an image.
    const artistIds = tracks.flatMap((track) => track.artist_ids);
    const metadata = await fetchArtists(artistIds, {
      onProgress: (done, total) => {
        loaderText.textContent = `Fetching artists… ${done} of ${total}`;
      },
    });

    loaderText.textContent = "Building the network…";
    source = { playlist, tracks, metadata };
    renderMode();

    loader.hidden = true;
  } catch (error) {
    showError(error);
    return;
  }

  soloToggle.addEventListener("change", () => {
    view?.setHideUnconnected(soloToggle.checked);
  });

  let searchTimer;
  nodeSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => view?.highlightSearch(nodeSearch.value), 150);
  });

  // Enter jumps to the first match rather than only highlighting it.
  nodeSearch.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !view) return;
    const needle = nodeSearch.value.trim().toLowerCase();
    const match = view.nodes.find((n) => n.label.toLowerCase().includes(needle));
    if (match) view.focusNode(match.id);
  });

  // No refetch: both builders read the tracks and metadata already fetched.
  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled || !source || button.dataset.mode === mode) return;
      mode = button.dataset.mode;
      modeButtons.forEach((b) => b.classList.toggle("is-active", b === button));
      renderMode();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") view?.clearSelection();
  });
}
