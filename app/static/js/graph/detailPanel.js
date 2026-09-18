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

import { formatCompact, formatDuration, formatYear, pluralise } from "../format.js";

export class DetailPanel {
  constructor(element, { onPlayTrack } = {}) {
    this.element = element;
    this.onPlayTrack = onPlayTrack || (() => {});
    this.graph = null;
    this.emptyMarkup = element.innerHTML; // keep the initial hint to restore later
  }

  setGraph(graph) {
    this.graph = graph;
    // Index nodes by id so link rendering can resolve endpoint labels.
    this.nodeIndex = new Map(graph.nodes.map((n) => [n.id, n]));
  }

  reset() {
    this.element.innerHTML = this.emptyMarkup;
  }

  // ------------------------------------------------------------------
  // Node selection: an artist's songs on this playlist
  // ------------------------------------------------------------------

  showNode(node) {
    const tracks = this._resolveTracks(node.track_ids);
    tracks.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    this.element.replaceChildren(
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

    const bits = [];
    if (node.followers) bits.push(`${formatCompact(node.followers)} followers`);
    if (node.degree) bits.push(pluralise(node.degree, "collaborator"));
    if (node.is_primary) bits.push("main artist");
    text.appendChild(el("p", "detail-head__meta", bits.join(" · ") || "—"));

    if (node.genres?.length) {
      const chips = el("div", "detail-head__genres");
      node.genres.slice(0, 4).forEach((g) => chips.appendChild(el("span", "genre-chip", g)));
      text.appendChild(chips);
    }

    head.appendChild(text);
    return head;
  }

  // ------------------------------------------------------------------
  // Link selection: songs two artists share
  // ------------------------------------------------------------------

  showLink(link) {
    const source = this.nodeIndex.get(link.source);
    const target = this.nodeIndex.get(link.target);
    const tracks = this._resolveTracks(link.track_ids);
    tracks.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    this.element.replaceChildren(
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
    text.appendChild(el("p", "detail-head__meta", pluralise(count, "collaboration")));
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

    row.addEventListener("click", () => this._handlePlay(row, track));
    return row;
  }

  async _handlePlay(row, track) {
    this.element
      .querySelectorAll(".track-row.is-playing")
      .forEach((node) => node.classList.remove("is-playing"));
    row.classList.add("is-playing");

    this.element.querySelector(".detail-toast")?.remove();

    try {
      await this.onPlayTrack(track);
    } catch (error) {
      row.classList.remove("is-playing");

      const toast = el("p", "detail-toast", error.message);
      // Offer the web player as a fallback when device playback is unavailable.
      if (track.spotify_url) {
        const link = document.createElement("a");
        link.href = track.spotify_url;
        link.target = "_blank";
        link.rel = "noopener";
        link.className = "detail-link";
        link.textContent = "Open in Spotify instead";
        toast.appendChild(document.createElement("br"));
        toast.appendChild(link);
      }
      this.element.appendChild(toast);
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
