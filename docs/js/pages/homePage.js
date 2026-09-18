/**
 * The login button on the homepage.
 *
 * Kept apart from initDemoPage so that a broken or unconfigured login cannot
 * stop the sample graph from rendering -- the demo is the thing a first-time
 * visitor came for, and it needs no account at all.
 */

import { isAuthenticated } from "../auth/session.js";
import { IS_CONFIGURED } from "../config.js";
import { startLogin } from "../ui/topbar.js";

export function initHomeLogin() {
  const button = document.getElementById("btn-login");
  if (!button) return;

  // Already signed in: the button becomes the way back to your own playlists.
  if (isAuthenticated()) {
    button.textContent = "Your playlists";
    button.addEventListener("click", () => {
      window.location.assign("playlists.html");
    });
    return;
  }

  if (!IS_CONFIGURED) {
    button.disabled = true;
    button.title =
      "Login is not configured on this deployment: set CLIENT_ID in js/config.js.";
    return;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Redirecting…";
    try {
      await startLogin("playlists.html");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Log in with Spotify";
      button.title = error.message;
    }
  });
}
