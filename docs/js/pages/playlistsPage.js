/**
 * Playlist selection grid: fetch, render, filter, paginate.
 *
 * Mirrors app/static/js/pages/playlistsPage.js. The differences are that pages
 * come from Spotify directly instead of /api/playlists, and that card links
 * point at graph.html?playlist=<id> rather than a Flask route.
 */

import { pluralise } from "../../static/js/format.js";
import { currentUser } from "../auth/session.js";
import { canReadContents, listPlaylists } from "../spotify/playlists.js";
import { loginAgainButton, renderTopbarUser, requireLogin } from "../ui/topbar.js";

const PAGE_SIZE = 50;

export function initPlaylistsPage() {
  if (!requireLogin()) return; // redirecting

  const user = currentUser();
  renderTopbarUser(user);

  const grid = document.getElementById("playlist-grid");
  const status = document.getElementById("playlist-status");
  const notice = document.getElementById("playlist-notice");
  const search = document.getElementById("playlist-search");
  const loadMore = document.getElementById("load-more");
  const template = document.getElementById("playlist-card-template");

  let offset = 0;
  let loading = false;
  let lockedCount = 0;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("status--error", isError);
  }

  function setFailure(error) {
    setStatus(error.message, true);
    // Offer the fix rather than performing it, so a session Spotify keeps
    // rejecting cannot put the page in a redirect cycle.
    if (error.needsLogin) status.appendChild(loginAgainButton("playlists.html"));
  }

  /**
   * Explain the restriction once, above the grid, instead of repeating the
   * workaround on every card -- at 180px a card has room for the fact, not the
   * instructions. Rendered only after a locked playlist is actually seen.
   */
  function renderNotice() {
    if (lockedCount === 0) return;

    notice.hidden = false;
    notice.innerHTML = "";

    const heading = document.createElement("p");
    heading.className = "playlist-notice__title";
    heading.textContent = `${lockedCount} ${
      lockedCount === 1 ? "playlist is" : "playlists are"
    } greyed out`;

    const body = document.createElement("p");
    body.textContent =
      "Since February 2026 Spotify only lets apps read playlists you own or " +
      "collaborate on. Ones you merely follow still show up here, but their " +
      "tracks cannot be fetched, so there is nothing to graph.";

    const how = document.createElement("p");
    how.className = "playlist-notice__how";
    how.textContent = "To graph one anyway, make your own copy of it:";

    const steps = document.createElement("ol");
    for (const text of [
      "Open the playlist in the Spotify app.",
      "Select every track (Ctrl+A, or Cmd+A on a Mac).",
      "Right-click → Add to playlist → New playlist.",
      "Reload this page — your copy appears, and you own it.",
    ]) {
      const step = document.createElement("li");
      step.textContent = text;
      steps.appendChild(step);
    }

    const alt = document.createElement("p");
    alt.className = "playlist-notice__alt";
    alt.textContent =
      "For a friend's playlist, asking them to make it collaborative and " +
      "joining it works too — collaborators count as owners here.";

    notice.append(heading, body, how, steps, alt);
  }

  function renderCard(playlist) {
    const card = template.content.firstElementChild.cloneNode(true);
    const readable = canReadContents(playlist, user?.id);

    card.querySelector(".playlist-card__name").textContent = playlist.name;
    card.querySelector(".playlist-card__meta").textContent = pluralise(
      playlist.track_count,
      "track"
    );

    if (readable) {
      card.href = `graph.html?playlist=${encodeURIComponent(playlist.id)}`;
    } else {
      lockedCount += 1;

      // Dropping href is what makes it non-clickable: an anchor without one is
      // not a link, is skipped by tab order, and takes no pointer events from
      // the browser's default styling.
      card.removeAttribute("href");
      card.classList.add("playlist-card--locked");
      card.setAttribute("aria-disabled", "true");

      const badge = card.querySelector(".playlist-card__badge");
      badge.textContent = "Can't open";
      badge.classList.add("playlist-card__badge--locked");
      badge.hidden = false;

      const note = card.querySelector(".playlist-card__note");
      note.textContent = `Owned by ${playlist.owner_name || "another Spotify user"}`;
      note.hidden = false;

      card.title =
        "Spotify only lets apps read playlists you own or collaborate on. " +
        "See the note above the grid for how to graph this one.";
    }

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
      renderNotice();

      if (grid.children.length === 0) {
        setStatus("No playlists found on your account.");
      } else {
        setStatus("");
        applyFilter();
      }
    } catch (error) {
      setFailure(error);
    } finally {
      loading = false;
      loadMore.disabled = false;
    }
  }

  search.addEventListener("input", applyFilter);
  loadMore.addEventListener("click", loadPage);

  loadPage();
}
