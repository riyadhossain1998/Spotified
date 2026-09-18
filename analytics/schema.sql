-- Event store for the Spotified analytics Worker.
--
-- Deliberately four columns. There is no session id, no visitor id, no IP and
-- no user agent, so a row cannot be tied back to a person even in principle --
-- which is the right trade when the thing being recorded is what music someone
-- was looking at.

CREATE TABLE IF NOT EXISTS events (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL,   -- visit | artist_click | song_click | spotify_open
  name TEXT,            -- artist or song name; NULL for visit and spotify_open
  page TEXT             -- pathname the event came from
);

-- Every question worth asking is "this kind of event, over this period".
CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts);
