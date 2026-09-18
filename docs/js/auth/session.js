/**
 * Token storage and renewal.
 *
 * Tokens live in sessionStorage rather than localStorage. That means closing
 * the tab signs you out, which sounds worse than it is: Spotify remembers that
 * you already granted consent, so logging back in is a silent redirect with no
 * prompt. In exchange, a refresh token is never left sitting on disk for the
 * next person to use the machine -- or for any injected script to read later.
 */

import { refreshTokens } from "./pkce.js";

const TOKEN_KEY = "spotified.tokens";
const PROFILE_KEY = "spotified.profile";

/** Renew this many seconds before actual expiry to absorb clock skew. */
const EXPIRY_MARGIN_SECONDS = 60;

export function storeTokens(payload) {
  const existing = readTokens();

  const tokens = {
    access_token: payload.access_token,
    // A refresh grant does not always return a new refresh token; when it
    // does not, the previous one stays valid and must be carried forward.
    refresh_token: payload.refresh_token || existing?.refresh_token || null,
    expires_at: Math.floor(Date.now() / 1000) + (payload.expires_in || 3600),
    scope: payload.scope || existing?.scope || "",
  };

  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

function readTokens() {
  const raw = sessionStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

export function isAuthenticated() {
  return Boolean(readTokens()?.access_token);
}

function isExpired(tokens) {
  return Date.now() / 1000 >= tokens.expires_at - EXPIRY_MARGIN_SECONDS;
}

// Concurrent callers must not each fire their own refresh: the first response
// rotates the refresh token and invalidates the others. Share one promise.
let inFlightRefresh = null;

/**
 * The only way the rest of the app should obtain an access token. Returns a
 * valid one, refreshing transparently, or null when the user must log in.
 */
export async function getAccessToken() {
  const tokens = readTokens();
  if (!tokens) return null;

  if (!isExpired(tokens)) return tokens.access_token;

  if (!tokens.refresh_token) {
    clearSession();
    return null;
  }

  if (!inFlightRefresh) {
    inFlightRefresh = refreshTokens(tokens.refresh_token)
      .then((payload) => storeTokens(payload).access_token)
      .catch((error) => {
        // A refresh token that no longer works cannot be recovered from.
        clearSession();
        throw error;
      })
      .finally(() => {
        inFlightRefresh = null;
      });
  }

  return inFlightRefresh;
}

export function storeProfile(profile) {
  sessionStorage.setItem(
    PROFILE_KEY,
    JSON.stringify({
      id: profile.id,
      display_name: profile.display_name || profile.id,
      image_url: profile.images?.[0]?.url || null,
      product: profile.product || null,
    })
  );
}

export function currentUser() {
  const raw = sessionStorage.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(PROFILE_KEY);
}

/** Where to send the user after login; survives the trip to Spotify. */
const RETURN_KEY = "spotified.return_to";

export function rememberReturnTo(url) {
  sessionStorage.setItem(RETURN_KEY, url);
}

export function takeReturnTo() {
  const value = sessionStorage.getItem(RETURN_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return value;
}
