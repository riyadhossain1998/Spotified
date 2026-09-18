/** Graph page controller: wires the API, the D3 view and the detail panel. */

import { trackVisit } from "../analytics.js";
import { fetchGraph, fetchGraphStatus, playTrack } from "../api.js";
import { formatNumber, pluralise } from "../format.js";
import { ArtistNetworkView } from "../graph/artistNetworkView.js";
import { initGraphChrome } from "../graph/chrome.js";
import { DetailPanel } from "../graph/detailPanel.js";

export function initGraphPage({ playlistId, defaultMode }) {
  trackVisit();

  const canvas = document.getElementById("graph-canvas");
  const loader = document.getElementById("graph-loader");
  const loaderText = document.getElementById("graph-loader-text");
  const nameEl = document.getElementById("graph-playlist-name");
  const statsEl = document.getElementById("graph-playlist-stats");
  const artEl = document.getElementById("graph-playlist-art");
  const soloToggle = document.getElementById("toggle-solo");
  const nodeSearch = document.getElementById("node-search");
  const rebuildBtn = document.getElementById("btn-rebuild");

  const mode = defaultMode;
  let view = null;
  let chrome = null;

  const panel = new DetailPanel(document.getElementById("detail-panel"), {
    onPlayTrack: (track) => playTrack(track.id),
    onClose: () => view?.clearSelection(),
  });

  function showLoader(message) {
    loaderText.textContent = message;
    loader.hidden = false;
  }

  function hideLoader() {
    loader.hidden = true;
  }

  function showError(message) {
    loader.hidden = false;
    loader.innerHTML = "";
    const heading = document.createElement("p");
    heading.className = "loader__text";
    heading.textContent = "Could not build this graph";
    const detail = document.createElement("p");
    detail.className = "loader__hint";
    detail.textContent = message;
    loader.append(heading, detail);
  }

  function renderHeader(graph, cached, buildSeconds) {
    const { playlist, stats } = graph;

    document.title = `${playlist.name} — Feature Network`;
    nameEl.textContent = playlist.name;

    if (playlist.image_url) {
      artEl.src = playlist.image_url;
      artEl.hidden = false;
    }

    const parts = [
      pluralise(stats.artist_count, "artist"),
      pluralise(stats.connection_count, "connection"),
      `${formatNumber(stats.track_count)} tracks`,
    ];
    if (stats.collaboration_track_count) {
      parts.push(`${formatNumber(stats.collaboration_track_count)} collabs`);
    }
    parts.push(cached ? "cached" : `built in ${buildSeconds}s`);

    statsEl.textContent = parts.join(" · ");
  }

  async function load({ refresh = false } = {}) {
    // Tell the user up front when a slow first build is coming, rather than
    // leaving them on a spinner with no explanation.
    if (!refresh) {
      showLoader("Checking for a cached graph…");
      try {
        const status = await fetchGraphStatus(playlistId, mode);
        showLoader(
          status.cached
            ? "Loading cached graph…"
            : "Building for the first time — fetching tracks and artists from Spotify…"
        );
      } catch {
        showLoader("Loading graph…");
      }
    } else {
      showLoader("Rebuilding from Spotify…");
    }

    rebuildBtn.disabled = true;

    try {
      const { graph, cached, buildSeconds } = await fetchGraph(playlistId, mode, { refresh });

      renderHeader(graph, cached, buildSeconds);
      panel.setGraph(graph);
      panel.reset();

      // Both are torn down together: the chrome's controls close over the view
      // they were given, and its button is a child of the canvas, so leaving it
      // behind would stack a second one on every rebuild.
      chrome?.destroy();
      view?.destroy();
      view = new ArtistNetworkView(canvas, {
        onSelectNode: (node) => panel.showNode(node),
        onSelectLink: (link) => panel.showLink(link),
        onClearSelection: () => panel.reset(),
      });
      view.render(graph);
      chrome = initGraphChrome(view);

      // Re-apply controls that survive a reload.
      view.setHideUnconnected(soloToggle.checked);
      if (nodeSearch.value) view.highlightSearch(nodeSearch.value);

      hideLoader();
    } catch (error) {
      showError(error.message);
    } finally {
      rebuildBtn.disabled = false;
    }
  }

  // --- controls -------------------------------------------------------

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

  rebuildBtn.addEventListener("click", () => load({ refresh: true }));

  // Escape clears the selection, matching the click-empty-canvas behaviour.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") view?.clearSelection();
  });

  load();
}
