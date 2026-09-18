/** Playlist selection grid: fetch, render, filter, paginate. */

import { fetchPlaylists } from "../api.js";
import { pluralise } from "../format.js";

export function initPlaylistsPage({ likedSongsId }) {
  const grid = document.getElementById("playlist-grid");
  const status = document.getElementById("playlist-status");
  const search = document.getElementById("playlist-search");
  const loadMore = document.getElementById("load-more");
  const template = document.getElementById("playlist-card-template");

  const PAGE_SIZE = 50;
  let offset = 0;
  let loading = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("status--error", isError);
  }

  function renderCard(playlist) {
    const card = template.content.firstElementChild.cloneNode(true);
    const isLiked = playlist.id === likedSongsId;

    card.href = `/playlists/${encodeURIComponent(playlist.id)}/graph`;
    card.querySelector(".playlist-card__name").textContent = playlist.name;
    card.querySelector(".playlist-card__meta").textContent = pluralise(
      playlist.track_count,
      "track"
    );

    // Store a lowercase haystack once so filtering never re-reads the DOM text.
    card.dataset.search = `${playlist.name} ${playlist.owner_name || ""}`.toLowerCase();

    const img = card.querySelector("img");
    if (isLiked) {
      card.classList.add("playlist-card--liked");
      img.remove(); // CSS draws the heart gradient instead
    } else if (playlist.image_url) {
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

    if (needle && visible === 0) setStatus("No playlists match that filter.");
    else setStatus("");
  }

  async function loadPage() {
    if (loading) return;
    loading = true;
    loadMore.disabled = true;
    setStatus(offset === 0 ? "Loading your playlists…" : "Loading more…");

    try {
      const page = await fetchPlaylists({ limit: PAGE_SIZE, offset });

      const fragment = document.createDocumentFragment();
      page.items.forEach((playlist) => fragment.appendChild(renderCard(playlist)));
      grid.appendChild(fragment);

      offset += page.items.length;
      loadMore.hidden = !page.has_more;

      if (grid.children.length === 0) {
        setStatus("No playlists found on your account.");
      } else {
        setStatus("");
        applyFilter();
      }
    } catch (error) {
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
