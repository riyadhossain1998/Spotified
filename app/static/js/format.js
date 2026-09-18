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

/** Spotify release dates arrive as YYYY, YYYY-MM or YYYY-MM-DD. */
export function formatYear(releaseDate) {
  return releaseDate ? releaseDate.slice(0, 4) : "—";
}
