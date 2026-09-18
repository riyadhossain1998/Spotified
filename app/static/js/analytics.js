/**
 * Event reporting, shared by the Flask app and the GitHub Pages build.
 *
 * Everything goes to the Worker in analytics/ -- see its README for the four
 * event kinds and for how to query them. Reporting is fire-and-forget by
 * design: a failed beacon must never surface to the user or break a click, so
 * every path here swallows its errors.
 */

/**
 * The deployed Worker URL. Set this to "" to turn reporting off entirely.
 *
 * Safe to commit: it is a write-only endpoint that accepts four fixed event
 * kinds from an allowlisted origin and returns nothing, so knowing the address
 * buys an attacker the ability to inflate counts and nothing else.
 *
 * Local development still stays out of the numbers: the Worker's origin
 * allowlist has no localhost entry, so a development run is rejected with a 403
 * that send() swallows like any other failure.
 */
const ENDPOINT = "https://spotified-analytics.riyad-hossain114.workers.dev";

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
