/**
 * Authorized fetch against the Spotify Web API.
 *
 * The Flask build leans on spotipy for retries, paging and error translation.
 * A static site has no such dependency, so this module is the browser-side
 * equivalent: it attaches a fresh bearer token to every call, backs off when
 * Spotify rate-limits us, and turns failures into messages a user can act on.
 */

import { API_BASE } from "../config.js";
import { clearSession, getAccessToken } from "../auth/session.js";

export class SpotifyError extends Error {
  constructor(message, { status = 0, needsLogin = false } = {}) {
    super(message);
    this.status = status;
    this.needsLogin = needsLogin;
  }
}

/** A 429 usually asks for a second or two; anything longer is not worth waiting out. */
const MAX_RETRY_AFTER_SECONDS = 20;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(path, params) {
  // `path` is either a bare endpoint ("/me") or an absolute `next` URL that
  // Spotify handed back, which already carries its own query string.
  const url = path.startsWith("http") ? new URL(path) : new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.href;
}

/**
 * GET a single resource.
 *
 * Every call re-reads the token instead of caching one in a closure: it may
 * have been refreshed by another request while this one was queued.
 */
export async function apiGet(path, params) {
  const url = buildUrl(path, params);

  for (let attempt = 1; ; attempt += 1) {
    const token = await getAccessToken();
    if (!token) {
      throw new SpotifyError("Your session has ended. Log in again.", {
        status: 401,
        needsLogin: true,
      });
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) return response.json();

    // 401 here means the token was rejected despite looking unexpired --
    // revoked in the account settings, or the app's scopes changed.
    if (response.status === 401) {
      clearSession();
      throw new SpotifyError("Spotify rejected the session. Log in again.", {
        status: 401,
        needsLogin: true,
      });
    }

    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      const wait = Number(response.headers.get("Retry-After") || 1);
      if (wait <= MAX_RETRY_AFTER_SECONDS) {
        await sleep((wait + 0.25) * 1000);
        continue;
      }
    }

    // 5xx is worth one blind retry; Spotify's edge occasionally blips.
    if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(attempt * 500);
      continue;
    }

    // Only 401 sets needsLogin, and it is set above. In particular a 403 must
    // not: it means this account may not read this resource, which signing in
    // again as the same account cannot change. Treating it as a login problem
    // is an infinite redirect -- Spotify bounces straight back because consent
    // was already granted, and the page fails the same way again.
    throw new SpotifyError(await describeFailure(response), {
      status: response.status,
    });
  }
}

async function describeFailure(response) {
  const payload = await response.json().catch(() => null);
  const detail = payload?.error?.message;

  switch (response.status) {
    // 403 and 404 are both worth spelling out, because the most common cause is
    // the same and is not obvious: since late 2024 Spotify blocks apps from
    // reading its own editorial and algorithmic playlists (Discover Weekly,
    // Release Radar, the Top 50 charts, anything under the Spotify account).
    // The raw responses -- a bare 404, or "Check settings on
    // developer.spotify.com/dashboard" -- give no hint that the playlist itself
    // is the problem rather than the sign-in.
    case 403:
      return detail
        ? `Spotify refused the request: ${detail}`
        : "Spotify refused this request. Playlists made by Spotify itself cannot be read by apps, and while this app is in development mode your account must be on its allowlist.";
    case 404:
      return "Spotify could not find that. Playlists made by Spotify itself (Discover Weekly, Release Radar, the charts) are not readable by apps — try one of your own.";
    case 429:
      return "Spotify is rate-limiting this app. Try again in a moment.";
    default:
      return detail || `Spotify request failed (HTTP ${response.status}).`;
  }
}

/**
 * Follow a paginated endpoint to the end.
 *
 * Paging tracks Spotify's own `next` URL rather than incrementing an offset
 * against a total. A playlist edited mid-fetch changes that total, and offset
 * arithmetic against a moving target is how the previous generation managed
 * to loop forever.
 *
 * `onPage` receives each page's items so callers can report progress.
 */
export async function apiGetAll(path, params, { limit = Infinity, onPage } = {}) {
  const collected = [];
  let url = buildUrl(path, params);

  while (url) {
    const page = await apiGet(url);
    const items = page.items || [];
    if (items.length === 0) break;

    collected.push(...items);
    onPage?.(collected.length, page.total ?? null);

    if (collected.length >= limit) return collected.slice(0, limit);
    url = page.next;
  }

  return collected;
}

export function fetchProfile() {
  return apiGet("/me");
}
