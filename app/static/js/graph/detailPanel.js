/**
 * Detail panel renderer.
 *
 * Serves both required interactions off the same track-list primitive:
 *   showNode(node)  -> every song by that artist on this playlist
 *   showLink(link)  -> every song the two artists made together
 *
 * Both are pure lookups because `graph.tracks` is an id-keyed dict and nodes
 * and links carry `track_ids`. No scanning, no cross-referencing.
 */

import { trackArtistClick, trackSongClick, trackSpotifyOpen } from "../analytics.js";
import { formatCompact, formatDuration, formatYear, pluralise } from "../format.js";

/** How many raw Spotify labels an artist names before the rest become a count. */
const GENRES_SHOWN = 4;

export class DetailPanel {
  constructor(element, { onPlayTrack, onClose } = {}) {
    this.element = element;
    this.onPlayTrack = onPlayTrack || (() => {});
    this.onClose = onClose || (() => {});
    this.graph = null;
    this.emptyMarkup = element.innerHTML; // keep the initial hint to restore later

    // Dismissed by the user, as opposed to merely empty. The empty state is
    // the only instructions a first-time visitor gets, so it shows until they
    // say otherwise -- and once they do, clicking away must not bring it back.
    this.dismissed = false;

    this._addCloseButton();
  }

  /**
   * The button is created here rather than written into the three page shells
   * because every selection calls replaceChildren() on this element. Markup
   * would survive exactly until the first click.
   */
  _addCloseButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "detail-panel__close";
    button.setAttribute("aria-label", "Close panel");
    button.textContent = "✕";
    button.addEventListener("click", () => this.close());

    // Not part of the content, so it sits outside everything replaceChildren
    // touches: prepended after each render instead of living among the nodes.
    this.closeButton = button;
    this.element.prepend(button);
  }

  close() {
    this.dismissed = true;
    this.element.classList.add("is-closed");
    // Closing means "back to the graph", so the highlight that came with the
    // selection goes too -- otherwise the page is left dimmed around an artist
    // whose details are no longer on screen.
    this.onClose();
  }

  _open() {
    this.dismissed = false;
    this.element.classList.remove("is-closed");
  }

  /** Re-attach the close button after content has been swapped out. */
  _render(...children) {
    this.element.replaceChildren(this.closeButton, ...children);
  }

  setGraph(graph) {
    this.graph = graph;
    // Index nodes by id so link rendering can resolve endpoint labels.
    this.nodeIndex = new Map(graph.nodes.map((n) => [n.id, n]));
  }

  /**
   * Back to the instructions. Visibility is deliberately left alone: clicking
   * empty canvas clears a selection, which is not a request to re-open a panel
   * the user has already dismissed.
   */
  reset() {
    this.element.innerHTML = this.emptyMarkup;
    this.element.prepend(this.closeButton);
  }

  // ------------------------------------------------------------------
  // Node selection: an artist's songs on this playlist
  // ------------------------------------------------------------------

  showNode(node) {
    const tracks = this._resolveTracks(node.track_ids);
    tracks.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    // Every route to an artist ends here -- clicking the node, hitting Enter in
    // the search box -- so this is the one place that sees all of them.
    trackArtistClick(node.label);

    this._open();
    this._render(
      this._nodeHeader(node),
      this._trackSection(
        `${pluralise(tracks.length, "song")} on this playlist`,
        tracks,
        node.id
      )
    );
  }

  _nodeHeader(node) {
    const head = el("div", "detail-head");

    if (node.image_url) {
      head.appendChild(
        Object.assign(document.createElement("img"), {
          className: "detail-head__avatar",
          src: node.image_url,
          alt: "",
        })
      );
    }

    const text = el("div");
    text.appendChild(el("h2", "detail-head__title", node.label));
    text.appendChild(el("p", "detail-head__meta", this._nodeMeta(node)));

    if (node.genres?.length) {
      const chips = el("div", "detail-head__genres");
      node.genres.slice(0, GENRES_SHOWN).forEach((g) =>
        chips.appendChild(el("span", "genre-chip", g))
      );
      // Spotify occasionally hangs a dozen labels off one artist, and the tail
      // of that list is noise next to the songs the panel exists to show.
      const hidden = node.genres.length - GENRES_SHOWN;
      if (hidden > 0) chips.appendChild(el("span", "genre-chip genre-chip--more", `+${hidden}`));
      text.appendChild(chips);
    }

    head.appendChild(text);
    return head;
  }

  _nodeMeta(node) {
    const bits = [];

    if (node.followers) bits.push(`${formatCompact(node.followers)} followers`);
    if (node.degree) bits.push(pluralise(node.degree, "collaborator"));
    if (node.is_primary) bits.push("main artist");

    return bits.join(" · ") || "—";
  }

  // ------------------------------------------------------------------
  // Link selection: songs two artists share
  // ------------------------------------------------------------------

  showLink(link) {
    const source = this.nodeIndex.get(link.source);
    const target = this.nodeIndex.get(link.target);
    const tracks = this._resolveTracks(link.track_ids);
    tracks.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    this._open();
    this._render(
      this._linkHeader(source, target, tracks.length),
      this._trackSection(`${pluralise(tracks.length, "song")} together`, tracks)
    );
  }

  _linkHeader(source, target, count) {
    const head = el("div", "detail-head");

    const pair = el("div", "detail-head__pair");
    [source, target].forEach((node) => {
      if (node?.image_url) {
        pair.appendChild(
          Object.assign(document.createElement("img"), { src: node.image_url, alt: "" })
        );
      }
    });
    head.appendChild(pair);

    const text = el("div");
    text.appendChild(
      el(
        "h2",
        "detail-head__title",
        `${source?.label || "Unknown"} × ${target?.label || "Unknown"}`
      )
    );
    text.appendChild(
      el("p", "detail-head__meta", pluralise(count, "collaboration"))
    );
    head.appendChild(text);

    return head;
  }

  // ------------------------------------------------------------------
  // Shared track list
  // ------------------------------------------------------------------

  _trackSection(title, tracks, excludeArtistId = null) {
    const section = el("section", "detail-section");
    section.appendChild(el("h3", "detail-section__title", title));

    if (!tracks.length) {
      section.appendChild(el("p", "detail-panel__empty", "No tracks found."));
      return section;
    }

    const list = el("ul", "track-list");
    tracks.forEach((track) => list.appendChild(this._trackRow(track, excludeArtistId)));
    section.appendChild(list);
    return section;
  }

  _trackRow(track, excludeArtistId) {
    const row = el("li", "track-row");
    row.dataset.trackId = track.id;

    if (track.album_art_url) {
      row.appendChild(
        Object.assign(document.createElement("img"), {
          className: "track-row__art",
          src: track.album_art_url,
          alt: "",
          loading: "lazy",
        })
      );
    } else {
      row.appendChild(el("div", "track-row__art"));
    }

    const text = el("div", "track-row__text");
    text.appendChild(el("div", "track-row__name", track.name));

    // On an artist's own list, drop them from the credits line -- repeating
    // the name you just clicked is wasted space.
    const others = (track.artist_names || []).filter((_, index) => {
      if (!excludeArtistId) return true;
      return track.artist_ids[index] !== excludeArtistId;
    });

    const sub = [formatYear(track.release_date), others.join(", ")]
      .filter(Boolean)
      .join(" · ");
    text.appendChild(el("div", "track-row__sub", sub || "—"));
    row.appendChild(text);

    row.appendChild(el("span", "track-row__duration", formatDuration(track.duration_ms)));

    // A real button rather than a click on the whole row: the row is three
    // lines of information, and a list where reading and playing are the same
    // gesture has no way to be read. It is always in the DOM -- revealing it on
    // hover would reflow every row by 28px as the pointer crosses the list.
    const play = document.createElement("button");
    play.type = "button";
    play.className = "track-row__play";
    play.setAttribute("aria-label", `Play ${track.name}`);
    play.innerHTML = "<svg viewBox='0 0 24 24' aria-hidden='true'><path d='M8 5v14l11-7z'/></svg>";
    play.addEventListener("click", (event) => {
      event.stopPropagation();
      this._handlePlay(row, track);
    });
    row.appendChild(play);

    return row;
  }

  async _handlePlay(row, track) {
    trackSongClick(track.name);

    this.element
      .querySelectorAll(".track-row.is-playing")
      .forEach((node) => node.classList.remove("is-playing"));
    row.classList.add("is-playing");

    this.element.querySelector(".detail-toast")?.remove();

    try {
      await this.onPlayTrack(track);
    } catch (error) {
      row.classList.remove("is-playing");

      const toast = el("li", "detail-toast", error.message);
      // Offer the web player as a fallback when device playback is unavailable.
      if (track.spotify_url) {
        const link = document.createElement("a");
        link.href = track.spotify_url;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "detail-link";
        link.textContent = "Open in Spotify instead";
        link.addEventListener("click", () => trackSpotifyOpen());
        toast.appendChild(document.createElement("br"));
        toast.appendChild(link);
      }
      // Under the row, not at the foot of the panel. Playback needs Premium and
      // an active device, so on a hundred-track list the old placement put the
      // explanation several screens below the button that caused it.
      row.after(toast);
    }
  }

  _resolveTracks(trackIds) {
    return (trackIds || []).map((id) => this.graph.tracks[id]).filter(Boolean);
  }
}

function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}
