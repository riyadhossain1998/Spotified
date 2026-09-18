/**
 * Static-site configuration.
 *
 * Everything here ships to the browser. That is fine: under PKCE the client id
 * is a public identifier, not a credential -- the proof of possession is the
 * code_verifier, which is generated per-login and never leaves this device.
 * There is deliberately no client secret anywhere in this build.
 */

/**
 * Spotify application client id.
 *
 * Create an app at https://developer.spotify.com/dashboard, then paste its
 * Client ID here. This is the only value you need to change.
 */
export const CLIENT_ID = "8a55874c785844628613744f645ad0e0";

export const IS_CONFIGURED = /^[0-9a-f]{32}$/i.test(CLIENT_ID);

/**
 * Derived from the current location so the same build works on GitHub Pages
 * (https://<user>.github.io/Spotified/callback.html) and on a local server
 * (http://127.0.0.1:8099/callback.html) without a rebuild.
 *
 * Spotify matches this string exactly, so BOTH must be registered as Redirect
 * URIs in the dashboard. Spotify allows http only for loopback addresses --
 * use 127.0.0.1 locally, not localhost.
 */
export function redirectUri() {
  return new URL("callback.html", document.baseURI).href;
}

/**
 * Requested up front so a returning user is never sent through a second
 * consent screen when Liked Songs or playback ships later.
 */
export const SCOPES = [
  "user-read-private",
  "user-read-email",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  // Playback. `modify` covers both starting a track and adding one to the queue;
  // `read` is what lets us tell "no active device" apart from "refused", which
  // are the same 403/404 from the write endpoint alone.
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");

export const AUTHORIZE_ENDPOINT = "https://accounts.spotify.com/authorize";
export const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
export const API_BASE = "https://api.spotify.com/v1";

/**
 * Artist metadata comes from our own Worker, not from api.spotify.com.
 *
 * `GET /v1/artists` answers 403 for a PKCE user token -- for one id as readily
 * as for fifty, so it is not batch size and not the rate limit -- while the same
 * ids return 200 with images for a client-credentials token. That grant needs a
 * client secret, and a secret cannot ship to a browser, so the call is made
 * server-side instead. No token is attached from here; there is still no secret
 * in this build. See analytics/README.md.
 */
export const ARTIST_ENDPOINT =
  "https://spotified-analytics.riyad-hossain114.workers.dev/artists";

/** Safety ceiling on how many tracks we pull from a single playlist. */
export const MAX_PLAYLIST_TRACKS = 2000;
