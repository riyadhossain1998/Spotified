/**
 * Playlist selection grid: fetch, render, filter, paginate.
 *
 * Mirrors app/static/js/pages/playlistsPage.js. The differences are that pages
 * come from Spotify directly instead of /api/playlists, and that card links
 * point at graph.html?playlist=<id> rather than a Flask route.
 */

import { pluralise } from "../../static/js/format.js";
import { listPlaylists } from "../spotify/playlists.js";
import { renderTopbarUser, requireLogin, startLogin } from "../ui/topbar.js";

const PAGE_SIZE = 50;

export function initPlaylistsPage() {
  const user = requireLogin();
  if (!user) return; // redirecting

  renderTopbarUser(user);

  const grid = document.getElementById("playlist-grid");
  const status = document.getElementById("playlist-status");
  const search = document.getElementById("playlist-search");
  const loadMore = document.getElementById("load-more");
  const template = document.getElementById("playlist-card-template");

  let offset = 0;
  let loading = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("status--error", isError);
  }

  function renderCard(playlist) {
    const card = template.content.firstElementChild.cloneNode(true);

    card.href = `graph.html?playlist=${encodeURIComponent(playlist.id)}`;
    card.querySelector(".playlist-card__name").textContent = playlist.name;
    card.querySelector(".playlist-card__meta").textContent = pluralise(
      playlist.track_count,
      "track"
    );

    // Store a lowercase haystack once so filtering never re-reads the DOM text.
    card.dataset.search = `${playlist.name} ${playlist.owner_name || ""}`.toLowerCase();

    const img = card.querySelector("img");
    if (playlist.image_url) {
      img.src = playlist.image_url;
      img.alt = `${playlist.name} cover`;
    } else {
      img.remove();
    }

    return card;
  }

  function applyFilter() {
    const needle = search.value.trim().toLowerCase();
    let visible = 0;

    for (const card of grid.children) {
      const match = !needle || card.dataset.search.includes(needle);
      card.classList.toggle("is-hidden", !match);
      if (match) visible += 1;
    }

    setStatus(needle && visible === 0 ? "No playlists match that filter." : "");
  }

  async function loadPage() {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    setStatus(offset === 0 ? "Loading your playlists…" : "Loading more…");

    try {
      const page = await listPlaylists({ limit: PAGE_SIZE, offset });

      const fragment = document.createDocumentFragment();
      page.items.forEach((playlist) => fragment.appendChild(renderCard(playlist)));
      grid.appendChild(fragment);

      offset += page.items.length;
      loadMore.hidden = !page.hasMore;

      if (grid.children.length === 0) {
        setStatus("No playlists found on your account.");
      } else {
        setStatus("");
        applyFilter();
      }
    } catch (error) {
      if (error.needsLogin) {
        // The session died between the guard above and this request.
        startLogin("playlists.html").catch(() => setStatus(error.message, true));
        return;
      }
      setStatus(error.message, true);
    } finally {
      loading = false;
      loadMore.disabled = false;
    }
  }

  search.addEventListener("input", applyFilter);
  loadMore.addEventListener("click", loadPage);

  loadPage();
}
