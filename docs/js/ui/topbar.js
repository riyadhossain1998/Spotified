/**
 * The signed-in half of the topbar, plus the guard that keeps signed-out users
 * off the pages behind it.
 *
 * In the Flask build both of these are server-side: Jinja renders the user
 * block and @login_required issues the redirect. On a static host the HTML is
 * already written by the time anyone is identified, so both jobs land here.
 */

import { beginLogin } from "../auth/pkce.js";
import {
  clearSession,
  currentUser,
  isAuthenticated,
  rememberReturnTo,
} from "../auth/session.js";
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
 * Guard a page. Returns the profile, or redirects and returns null.
 *
 * Callers must stop when this returns null -- a redirect does not interrupt
 * the current script.
 */
export function requireLogin() {
  if (isAuthenticated()) return currentUser();

  const here = window.location.pathname + window.location.search;
  rememberReturnTo(here);
  window.location.replace("./");
  return null;
}

/** Fill in the `data-topbar-user` slot with the avatar, name and sign-out. */
export function renderTopbarUser(user) {
  const slot = document.querySelector("[data-topbar-user]");
  if (!slot || !user) return;

  slot.innerHTML = "";

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

  const signOut = document.createElement("button");
  signOut.type = "button";
  signOut.className = "btn btn--ghost btn--sm";
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", () => {
    clearSession();
    window.location.replace("./");
  });

  slot.append(identity, signOut);
}
