/**
 * Completes the OAuth round trip and gets the user off this page.
 *
 * The one subtlety is the history entry: the URL currently contains a live
 * authorization code. It is single-use and already spent by the time we
 * redirect, but leaving it in the back-stack means a Back navigation re-runs
 * this page against a dead code and shows an error for no reason. Replacing
 * the entry removes the page from history entirely.
 */

import { completeLogin } from "../auth/pkce.js";
import { storeProfile, storeTokens, takeReturnTo } from "../auth/session.js";
import { fetchProfile } from "../spotify/client.js";

export async function initCallbackPage() {
  const status = document.getElementById("callback-status");
  const search = window.location.search;

  // Strip the code from the visible URL before doing anything else, so it is
  // not sitting in the address bar for a screen-share or a bookmark.
  history.replaceState(null, "", window.location.pathname);

  try {
    storeTokens(await completeLogin(search));

    // Fetching the profile now doubles as a check that the token actually
    // works, rather than discovering it on the next page.
    storeProfile(await fetchProfile());

    const destination = takeReturnTo() || "playlists.html";
    window.location.replace(destination);
  } catch (error) {
    status.innerHTML = "";

    const heading = document.createElement("p");
    heading.className = "loader__text";
    heading.textContent = "Sign-in did not complete";

    const detail = document.createElement("p");
    detail.className = "loader__hint";
    detail.textContent = error.message;

    const retry = document.createElement("a");
    retry.className = "btn btn--primary btn--sm";
    retry.href = "./";
    retry.textContent = "Back to the start";

    status.append(heading, detail, retry);
  }
}
