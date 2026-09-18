/**
 * Event reporting, shared by the Flask app and the GitHub Pages build.
 *
 * Everything goes to the Worker in analytics/ -- see its README for the four
 * event kinds and for how to query them. Reporting is fire-and-forget by
 * design: a failed beacon must never surface to the user or break a click, so
 * every path here swallows its errors.
 */

/**
 * The deployed Worker URL, e.g.
 * "https://spotified-analytics.<subdomain>.workers.dev".
 *
 * Empty means analytics are off, which is how this ships and how local
 * development stays out of the numbers.
 */
const ENDPOINT = "";

function send(kind, name) {
  if (!ENDPOINT) return;

  const body = JSON.stringify({ kind, name: name ?? null, page: location.pathname });

  try {
    // text/plain keeps this a CORS "simple request", so there is no preflight
    // to pay for on every click. The Worker parses the body itself.
    const blob = new Blob([body], { type: "text/plain" });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;

    // keepalive so the request outlives the navigation to Spotify.
    fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    // Analytics are never worth an exception in a click handler.
  }
}

export function trackVisit() {
  send("visit");
}

export function trackArtistClick(name) {
  send("artist_click", name);
}

export function trackSongClick(name) {
  send("song_click", name);
}

/** Counted, not named: the song is already recorded by the click that led here. */
export function trackSpotifyOpen() {
  send("spotify_open");
}
