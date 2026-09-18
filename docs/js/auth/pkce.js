/**
 * Authorization Code flow with PKCE (RFC 7636).
 *
 * Why PKCE rather than the classic Authorization Code flow the Flask app uses:
 * that flow proves the client's identity with a client_secret, which cannot
 * exist in a static site without publishing it. PKCE replaces the secret with
 * a one-time proof --
 *
 *   1. generate a random `code_verifier` and keep it on this device
 *   2. send only SHA-256(verifier) -- the `code_challenge` -- to Spotify
 *   3. redeem the returned code by presenting the original verifier
 *
 * An attacker who intercepts the redirect gets a code they cannot spend,
 * because the verifier never travelled over the network. That is what makes
 * browser-side login safe enough to run on GitHub Pages.
 */

import {
  AUTHORIZE_ENDPOINT,
  CLIENT_ID,
  SCOPES,
  TOKEN_ENDPOINT,
  redirectUri,
} from "../config.js";

const VERIFIER_KEY = "spotified.pkce_verifier";
const STATE_KEY = "spotified.oauth_state";

/** base64url: standard base64 with +/ swapped and padding removed. */
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBase64Url(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * RFC 7636 requires 43-128 characters from the unreserved set. 64 random
 * bytes base64url-encoded gives 86 characters, comfortably inside that.
 */
export function createVerifier() {
  return randomBase64Url(64);
}

export async function challengeFromVerifier(verifier) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(digest);
}

/**
 * Build the /authorize URL and hand it back.
 *
 * Note we point at /authorize directly. If the user has no Spotify session,
 * Spotify itself bounces them to accounts.spotify.com/en/login?continue=...
 * and returns here afterwards -- that wrapper URL is not something a client
 * constructs.
 */
export async function beginLogin() {
  const verifier = createVerifier();
  const challenge = await challengeFromVerifier(verifier);
  const state = randomBase64Url(16);

  // sessionStorage, not localStorage: these are single-use values for the
  // round trip that is about to happen, and they should not outlive the tab.
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  return `${AUTHORIZE_ENDPOINT}?${params}`;
}

export class OAuthError extends Error {}

/**
 * Handle the redirect back from Spotify: validate state, then trade the code
 * for tokens using the verifier we stashed before leaving.
 */
export async function completeLogin(search = window.location.search) {
  const params = new URLSearchParams(search);

  const denied = params.get("error");
  if (denied) {
    throw new OAuthError(
      denied === "access_denied"
        ? "You declined the permission request."
        : `Spotify returned an error: ${denied}`
    );
  }

  const code = params.get("code");
  const state = params.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);

  if (!code) throw new OAuthError("No authorization code in the callback URL.");

  // The CSRF check: a callback we did not initiate will not carry our state.
  if (!expectedState || state !== expectedState) {
    throw new OAuthError("State mismatch — this login did not start here.");
  }
  if (!verifier) {
    throw new OAuthError(
      "Missing PKCE verifier. It lives in sessionStorage, so finish the login in the tab that started it."
    );
  }

  // Single-use: clear before the exchange so a replayed callback cannot reuse
  // them even if the request below fails.
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  return exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
}

export async function refreshTokens(refreshToken) {
  return exchange({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

/** POST to the token endpoint. Public clients send no Authorization header. */
async function exchange(body) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload.error_description || payload.error || response.status;
    if (payload.error === "invalid_grant") {
      throw new OAuthError(`Spotify rejected the login: ${detail}`);
    }
    throw new OAuthError(`Token request failed: ${detail}`);
  }

  return payload;
}
