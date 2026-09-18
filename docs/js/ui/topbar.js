/**
 * The signed-in half of the topbar, plus the guard that keeps signed-out users
 * off the pages behind it.
 *
 * In the Flask build both of these are server-side: Jinja renders the user
 * block and @login_required issues the redirect. On a static host the HTML is
 * already written by the time anyone is identified, so both jobs land here.
 */

import { beginLogin } from "../auth/pkce.js";
import { clearSession, isAuthenticated, rememberReturnTo } from "../auth/session.js";
import { IS_CONFIGURED } from "../config.js";

/**
 * Send the user to Spotify, remembering where they were headed.
 *
 * `returnTo` is stored rather than passed through the OAuth `state` parameter:
 * state has a job already (CSRF), and overloading it with a destination means
 * an attacker-supplied callback could choose where the user lands.
 */
export async function startLogin(returnTo) {
  if (!IS_CONFIGURED) {
    throw new Error(
      "This build has no Spotify client id yet. Set CLIENT_ID in js/config.js."
    );
  }
  if (returnTo) rememberReturnTo(returnTo);
  window.location.assign(await beginLogin());
}

/**
 * Guard a page. Returns false when it has started a redirect.
 *
 * This fires only on arrival, when there is no session at all. A request that
 * fails *after* the page has loaded must never redirect here: Spotify returns
 * from a re-login instantly when consent already exists, so any error that
 * outlives the login is an infinite loop rather than a recovery. Those are
 * reported in the page with a `loginAgainButton()` the user can choose to press.
 *
 * Callers must stop when this returns false -- assigning location does not
 * interrupt the running script.
 */
export function requireLogin() {
  if (isAuthenticated()) return true;

  rememberReturnTo(window.location.pathname + window.location.search);
  window.location.replace("./");
  return false;
}

/**
 * A button that clears the session and starts a fresh login.
 *
 * Deliberately a button rather than an automatic redirect: pressing it is a
 * decision, so it cannot run in a cycle. Clearing first matters -- otherwise a
 * token Spotify has rejected stays in sessionStorage and the destination page
 * fails exactly as before.
 */
export function loginAgainButton(returnTo) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn--primary btn--sm";
  button.textContent = "Log in again";

  button.addEventListener("click", async () => {
    button.disabled = true;
    clearSession();
    try {
      await startLogin(returnTo);
    } catch (error) {
      button.disabled = false;
      button.title = error.message;
    }
  });

  return button;
}

/**
 * Fill in the `data-topbar-user` slot.
 *
 * `user` may be null: the tokens are what authenticate, and the cached profile
 * is only a display convenience. Missing one should cost the avatar, not the
 * page.
 */
export function renderTopbarUser(user) {
  const slot = document.querySelector("[data-topbar-user]");
  if (!slot) return;

  slot.innerHTML = "";

  if (user) {
    const identity = document.createElement("div");
    identity.className = "topbar__user";

    if (user.image_url) {
      const avatar = document.createElement("img");
      avatar.className = "topbar__avatar";
      avatar.src = user.image_url;
      avatar.alt = "";
      identity.appendChild(avatar);
    }

    const name = document.createElement("span");
    name.textContent = user.display_name;
    identity.appendChild(name);
    slot.appendChild(identity);
  }

  const signOut = document.createElement("button");
  signOut.type = "button";
  signOut.className = "btn btn--ghost btn--sm";
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", () => {
    clearSession();
    window.location.replace("./");
  });

  slot.appendChild(signOut);
}
