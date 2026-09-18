/**
 * Static demo controller for the GitHub Pages build.
 *
 * Identical to graphPage.js except for where the payload comes from: committed
 * JSON files instead of `/api/playlists/<id>/graph`. Everything downstream --
 * the force simulation, the node/link detail panels -- is the exact same code
 * the live app runs, which is the point of keeping this file in the source tree
 * rather than hand-writing a separate demo bundle.
 *
 * One file per mode, built by scripts/make_demo_graph.py from the same recovered
 * tracks. The alternative -- porting the genre builder to the browser so the
 * demo could derive it -- would put a second implementation of the bucketing
 * rules in the repo for the sake of saving one 80 KB download.
 *
 * Playback is the one genuine difference: there is no server to proxy the
 * Spotify call, so onPlayTrack rejects and DetailPanel falls back to its
 * "Open in Spotify instead" link automatically.
 */

import { trackVisit } from "../analytics.js";
import { formatNumber, nodeNoun, pluralise } from "../format.js";
import { ArtistNetworkView } from "../graph/artistNetworkView.js";
import { applyModeLabels, initGraphChrome } from "../graph/chrome.js";
import { DetailPanel } from "../graph/detailPanel.js";

export async function initDemoPage({ payloads }) {
  trackVisit();

  const canvas = document.getElementById("graph-canvas");
  const loader = document.getElementById("graph-loader");
  const loaderText = document.getElementById("graph-loader-text");
  const nameEl = document.getElementById("graph-playlist-name");
  const statsEl = document.getElementById("graph-playlist-stats");
  const soloToggle = document.getElementById("toggle-solo");
  const nodeSearch = document.getElementById("node-search");
  const modeButtons = [...document.querySelectorAll(".mode-switch__btn")];

  const panel = new DetailPanel(document.getElementById("detail-panel"), {
    onPlayTrack: () => {
      throw new Error("Playback needs the live app and a Spotify Premium device.");
    },
    onClose: () => view?.clearSelection(),
  });

  let view = null;
  let chrome = null;
  let mode = "artist";
  // Switching back and forth is one click, so the second visit to a mode should
  // not go to the network again. Both payloads are static files.
  const cache = new Map();

  async function fetchPayload(target) {
    if (cache.has(target)) return cache.get(target);

    const response = await fetch(payloads[target], { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Could not load the sample graph (HTTP ${response.status}).`);
    }
    const graph = await response.json();
    cache.set(target, graph);
    return graph;
  }

  function showError(message) {
    loader.hidden = false;
    loader.innerHTML = "";
    const heading = document.createElement("p");
    heading.className = "loader__text";
    heading.textContent = "Could not load the demo";
    const detail = document.createElement("p");
    detail.className = "loader__hint";
    detail.textContent = message;
    loader.append(heading, detail);
  }

  async function load() {
    loaderText.textContent = "Loading sample graph…";
    loader.hidden = false;

    let graph;
    try {
      graph = await fetchPayload(mode);
    } catch (error) {
      showError(error.message);
      return;
    }

    nameEl.textContent = graph.playlist.name;
    statsEl.textContent = [
      pluralise(graph.stats.artist_count, nodeNoun(graph.mode)),
      pluralise(graph.stats.connection_count, "connection"),
      `${formatNumber(graph.stats.track_count)} tracks`,
      "sample data",
    ].join(" · ");

    applyModeLabels(graph.mode);
    panel.setGraph(graph);
    panel.reset();

    // Torn down together: the chrome's controls close over the view they were
    // given, and its fullscreen button is a child of the canvas, so leaving it
    // behind would stack a second one on every switch.
    chrome?.destroy();
    view?.destroy();
    view = new ArtistNetworkView(canvas, {
      onSelectNode: (node) => panel.showNode(node),
      onSelectLink: (link) => panel.showLink(link),
      onClearSelection: () => panel.reset(),
    });
    view.render(graph);
    chrome = initGraphChrome(view);

    // Controls that survive a switch.
    if (soloToggle?.checked) view.setHideUnconnected(true);
    if (nodeSearch?.value) view.highlightSearch(nodeSearch.value);

    loader.hidden = true;
  }

  soloToggle?.addEventListener("change", () => {
    view?.setHideUnconnected(soloToggle.checked);
  });

  let searchTimer;
  nodeSearch?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => view?.highlightSearch(nodeSearch.value), 150);
  });

  nodeSearch?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !view) return;
    const needle = nodeSearch.value.trim().toLowerCase();
    const match = view.nodes.find((n) => n.label.toLowerCase().includes(needle));
    if (match) view.focusNode(match.id);
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled || button.dataset.mode === mode) return;
      mode = button.dataset.mode;
      modeButtons.forEach((b) => b.classList.toggle("is-active", b === button));
      load();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") view?.clearSelection();
  });

  await load();
}
