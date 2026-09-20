/**
 * Static demo controller for the GitHub Pages build.
 *
 * Identical to graphPage.js except for where the payload comes from: committed
 * JSON files instead of `/api/playlists/<id>/graph`. Everything downstream --
 * the force simulation, the node/link detail panels -- is the exact same code
 * the live app runs, which is the point of keeping this file in the source tree
 * rather than hand-writing a separate demo bundle.
 *
 * Payloads are built by scripts/build_graphs.py straight from Spotify, and
 * `graphs/index.json` lists them. One graph loads at a time, on selection:
 * bundling all of them would be ~800 KB gzipped to show one, and the visitor
 * who never touches the picker would pay for eight graphs they did not ask
 * for. Fetching per selection keeps first paint at the cost of a single
 * payload no matter how many are published.
 *
 * Playback is the one genuine difference: the demo has no Spotify session, so
 * both handlers reject and DetailPanel falls back to its "Open in Spotify
 * instead" link automatically.
 */

import { trackVisit } from "../analytics.js";
import { formatNumber, pluralise } from "../format.js";
import { ArtistNetworkView } from "../graph/artistNetworkView.js";
import { initGraphChrome } from "../graph/chrome.js";
import { DetailPanel } from "../graph/detailPanel.js";

export async function initDemoPage({ payload, manifest, graphDir = "./graphs/" }) {
  trackVisit();

  const canvas = document.getElementById("graph-canvas");
  const loader = document.getElementById("graph-loader");
  const loaderText = document.getElementById("graph-loader-text");
  const nameEl = document.getElementById("graph-playlist-name");
  const statsEl = document.getElementById("graph-playlist-stats");
  const soloToggle = document.getElementById("toggle-solo");
  const nodeSearch = document.getElementById("node-search");
  const pickerEl = document.getElementById("graph-picker");

  const panel = new DetailPanel(document.getElementById("detail-panel"), {
    onPlayTrack: () => {
      throw new Error("Log in to play this. The demo has no Spotify session.");
    },
    onQueueTrack: () => {
      throw new Error("Log in to queue this. The demo has no Spotify session.");
    },
    onClose: () => view?.clearSelection(),
  });

  let view = null;
  // Held so it can be torn down on the next selection: initGraphChrome appends
  // a Fullscreen button and registers document-level listeners, so calling it
  // per load without this leaves one stacked button per graph viewed.
  let chrome = null;

  /**
   * Graphs already downloaded this session, by URL.
   *
   * Toggling back to a previous artist is the single most likely thing a
   * visitor does, and re-fetching 50-180 KB to show something they have
   * already seen is the one cost the lazy-loading design would otherwise
   * introduce. Keyed by URL so the default payload and a manifest entry
   * pointing at the same file share an entry.
   */
  const cache = new Map();

  async function fetchJson(url, what) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Could not load ${what} (HTTP ${response.status}).`);
    }
    return response.json();
  }

  async function fetchPayload(url) {
    if (cache.has(url)) return cache.get(url);
    const graph = await fetchJson(url, "this graph");
    cache.set(url, graph);
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

  async function load(url, { label } = {}) {
    loaderText.textContent = label ? `Loading ${label}…` : "Loading sample graph…";
    loader.hidden = false;

    let graph;
    try {
      graph = await fetchPayload(url);
    } catch (error) {
      showError(error.message);
      return;
    }

    nameEl.textContent = graph.playlist.name;
    statsEl.textContent = [
      pluralise(graph.stats.artist_count, "artist"),
      pluralise(graph.stats.connection_count, "connection"),
      `${formatNumber(graph.stats.track_count)} tracks`,
    ].join(" · ");

    panel.setGraph(graph);
    panel.reset();

    // Tear the old view and chrome down before building the next. The view owns
    // a running force simulation and a resize listener; the chrome owns a button
    // inside the canvas and document-level listeners. Without this, a few
    // selections leave the page ticking graphs it no longer draws, behind a row
    // of stacked Fullscreen buttons.
    chrome?.destroy();
    view?.destroy();

    view = new ArtistNetworkView(canvas, {
      onSelectNode: (node) => panel.showNode(node),
      onSelectLink: (link) => panel.showLink(link),
      onClearSelection: () => panel.reset(),
    });
    view.render(graph);
    chrome = initGraphChrome(view);

    if (soloToggle?.checked) view.setHideUnconnected(true);
    if (nodeSearch?.value) view.highlightSearch(nodeSearch.value);

    loader.hidden = true;
  }

  /**
   * Render the picker and wire selection.
   *
   * The selected slug goes in the URL hash so a particular graph can be linked
   * to and survives a reload -- worth doing because "look at this one" is the
   * natural thing to want to send someone, and a picker without it makes every
   * link land on the default.
   */
  async function initPicker() {
    if (!pickerEl || !manifest) return null;

    let entries;
    try {
      entries = await fetchJson(manifest, "the graph list");
    } catch {
      // A missing manifest is not fatal: the default payload below still
      // renders, so the page degrades to exactly the single-graph demo it was
      // before rather than showing nothing at all.
      return null;
    }
    if (!Array.isArray(entries) || entries.length === 0) return null;

    const fromHash = decodeURIComponent(location.hash.replace(/^#/, ""));
    let current = entries.find((e) => e.slug === fromHash) || entries[0];

    const buttons = new Map();
    for (const entry of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "picker__item";
      button.dataset.slug = entry.slug;

      if (entry.image_url) {
        const img = document.createElement("img");
        img.className = "picker__art";
        img.src = entry.image_url;
        img.alt = "";
        img.loading = "lazy";
        button.appendChild(img);
      }

      const text = document.createElement("span");
      text.className = "picker__text";
      const name = document.createElement("span");
      name.className = "picker__name";
      name.textContent = entry.name;
      const meta = document.createElement("span");
      meta.className = "picker__meta";
      meta.textContent = `${formatNumber(entry.artist_count)} artists`;
      text.append(name, meta);
      button.appendChild(text);

      button.addEventListener("click", () => select(entry));
      buttons.set(entry.slug, button);
      pickerEl.appendChild(button);
    }

    function mark(slug) {
      for (const [key, button] of buttons) {
        const active = key === slug;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", String(active));
      }
    }

    async function select(entry) {
      if (entry.slug === current.slug && view) return;
      current = entry;
      mark(entry.slug);
      history.replaceState(null, "", `#${encodeURIComponent(entry.slug)}`);
      await load(graphDir + entry.file, { label: entry.name });
    }

    mark(current.slug);

    window.addEventListener("hashchange", () => {
      const slug = decodeURIComponent(location.hash.replace(/^#/, ""));
      const entry = entries.find((e) => e.slug === slug);
      if (entry) select(entry);
    });

    return { url: graphDir + current.file, label: current.name };
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

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") view?.clearSelection();
  });

  const initial = await initPicker();
  await load(initial?.url ?? payload, { label: initial?.label });
}
