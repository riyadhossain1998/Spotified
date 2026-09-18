/**
 * Thin wrapper around the JSON API.
 *
 * Centralises two things every caller would otherwise repeat: turning a
 * non-2xx response into a real Error carrying the server's message, and
 * handling 401 by sending the user to the login page.
 */

export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(options.headers || {}) },
    ...options,
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body (proxy error page, empty 204). Fall through to status check.
  }

  if (!response.ok) {
    // The session died mid-visit; bounce rather than showing a broken page.
    if (response.status === 401) {
      window.location.href = body?.login_url || "/auth/login";
      throw new ApiError("Redirecting to login…", { status: 401 });
    }
    throw new ApiError(body?.message || `Request failed (${response.status})`, {
      status: response.status,
      code: body?.error,
    });
  }

  return { body, response };
}

export async function fetchPlaylists({ limit = 50, offset = 0 } = {}) {
  const { body } = await request(`/api/playlists?limit=${limit}&offset=${offset}`);
  return body;
}

export async function fetchGraphStatus(playlistId, mode) {
  const { body } = await request(
    `/api/playlists/${encodeURIComponent(playlistId)}/graph/status?mode=${mode}`
  );
  return body;
}

/**
 * Fetch a graph. The server builds and caches it when absent.
 * Returns the payload plus whether it came from cache.
 */
export async function fetchGraph(playlistId, mode, { refresh = false } = {}) {
  const params = new URLSearchParams({ mode });
  if (refresh) params.set("refresh", "1");

  const { body, response } = await request(
    `/api/playlists/${encodeURIComponent(playlistId)}/graph?${params}`
  );

  return {
    graph: body,
    cached: response.headers.get("X-FN-Cache") === "hit",
    buildSeconds: response.headers.get("X-FN-Build-Seconds"),
  };
}

export async function playTrack(trackId) {
  const { body } = await request(`/api/playback/track/${encodeURIComponent(trackId)}`, {
    method: "PUT",
  });
  return body;
}

export async function queueTrack(trackId) {
  const { body } = await request(`/api/playback/queue/${encodeURIComponent(trackId)}`, {
    method: "POST",
  });
  return body;
}
