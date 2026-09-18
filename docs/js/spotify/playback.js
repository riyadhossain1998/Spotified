/**
 * Playback control.
 *
 * These are the only *writes* the site makes. They were built last because the
 * project's notes recorded that Development Mode blocks every write endpoint —
 * which turned out to be false for the player: measured 2026-09-19 against this
 * app with a user token, `PUT /me/player/play` answered 204 and
 * `POST /me/player/queue` answered 200.
 *
 * Spotify cannot wake a device from the API. It only ever redirects audio to
 * something already running, so "no active device" is the normal failure here,
 * not an edge case — hence the specific message rather than a generic one.
 */

import { apiSend, SpotifyError } from "./client.js";

/**
 * Restate player failures in terms of what the person can actually do.
 *
 * client.js explains 403 and 404 in terms of unreadable playlists, which is
 * right for every other call and wrong for these two.
 */
function asPlaybackError(error) {
  if (error.needsLogin) return error;

  switch (error.status) {
    case 404:
      return new SpotifyError(
        "No active Spotify device. Open Spotify on your phone or computer, play anything for a second, then try again.",
        { status: 404 }
      );
    case 403:
      return new SpotifyError(
        "Spotify refused playback control. It needs a Premium account.",
        { status: 403 }
      );
    default:
      return error;
  }
}

/** Start one track on whatever device is currently active. */
export async function playTrack(trackId) {
  try {
    return await apiSend("PUT", "/me/player/play", {
      body: { uris: [`spotify:track:${trackId}`] },
    });
  } catch (error) {
    throw asPlaybackError(error);
  }
}

/**
 * Add one track to the end of the queue.
 *
 * The uri goes in the query string, not the body: this endpoint reads it as a
 * parameter and ignores a JSON body entirely.
 */
export async function queueTrack(trackId) {
  try {
    return await apiSend("POST", "/me/player/queue", {
      params: { uri: `spotify:track:${trackId}` },
    });
  } catch (error) {
    throw asPlaybackError(error);
  }
}
