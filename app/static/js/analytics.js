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

/**
 * Set once the endpoint is known to be unreachable from this browser, which in
 * practice means a content blocker: the hostname carries the word "analytics"
 * and sits on the usual filter lists.
 *
 * Worth the bookkeeping because a blocked request is logged by the browser
 * itself, and page code cannot suppress that. Reporting four events across a
 * session therefore printed a wall of identical ERR_BLOCKED_BY_CLIENT errors
 * that had to be re-diagnosed every time the console was opened -- and noise
 * like that is what a real error hides behind. One attempt per session is
 * enough to learn the answer; the rest are silent.
 *
 * sessionStorage rather than a module variable because every page here is a
 * real navigation, which would otherwise re-learn it each time.
 */
const BLOCKED_KEY = "spotified.analytics.blocked";

function isBlocked() {
  try {
    return sessionStorage.getItem(BLOCKED_KEY) === "1";
  } catch {
    return false; // storage unavailable: just carry on reporting
  }
}

function markBlocked() {
  try {
    sessionStorage.setItem(BLOCKED_KEY, "1");
  } catch {
    // Nothing to do. Reporting stays best-effort either way.
  }
}

/** Whether this page load has already learned whether the endpoint answers. */
let probed = false;

function send(kind, name) {
  if (!ENDPOINT || isBlocked()) return;

  const body = JSON.stringify({ kind, name: name ?? null, page: location.pathname });

  try {
    // The first event of a page load goes by fetch even though sendBeacon is
    // otherwise preferable, because a beacon reports only whether it was
    // *queued* -- a blocked one still returns true, so the failure is
    // unobservable and every later event repeats it. fetch rejects, which is
    // what makes the circuit breaker possible at all. Safe here: the first
    // event is the page-load visit, which is not racing a navigation.
    // A string body sends text/plain, keeping this a CORS "simple request".
    if (!probed) {
      probed = true;
      fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(markBlocked);
      return;
    }

    // text/plain keeps this a CORS "simple request", so there is no preflight
    // to pay for on every click. The Worker parses the body itself.
    const blob = new Blob([body], { type: "text/plain" });
    if (navigator.sendBeacon?.(ENDPOINT, blob)) return;

    // keepalive so the request outlives the navigation to Spotify.
    fetch(ENDPOINT, { method: "POST", body, keepalive: true }).catch(markBlocked);
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
