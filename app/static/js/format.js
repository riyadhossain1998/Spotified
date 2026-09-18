/** Display formatting helpers shared across pages. */

export function formatDuration(ms) {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

export function formatCompact(value) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value ?? 0);
}

export function pluralise(count, singular, plural = `${singular}s`) {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

/**
 * What one node stands for in a given mode.
 *
 * `stats.artist_count` is really a node count -- the summariser is deliberately
 * mode-agnostic -- so the label has to come from the mode rather than the key.
 */
export function nodeNoun(mode) {
  return mode === "genre" ? "genre" : "artist";
}

/** Spotify release dates arrive as YYYY, YYYY-MM or YYYY-MM-DD. */
export function formatYear(releaseDate) {
  return releaseDate ? releaseDate.slice(0, 4) : "—";
}
