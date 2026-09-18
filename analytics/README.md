# Analytics

A single Cloudflare Worker writing to a D1 (SQLite) database. It records four
things and nothing else:

| kind | recorded when | `name` |
| --- | --- | --- |
| `visit` | a page is opened | — |
| `artist_click` | an artist is opened in the detail panel | artist name |
| `song_click` | a song row is clicked | song name |
| `spotify_open` | "Open in Spotify instead" is followed | — (count only) |

No session id, no visitor id, no IP address, no user agent. A row records that
*something happened*, never *who did it*, so there is nothing here to leak.

Both front ends use the same client module, `app/static/js/analytics.js`, and
both are silent until `ENDPOINT` in that file is filled in.

## Setup

Four commands, once. A free Cloudflare account covers all of it: 100k Worker
requests/day and 100k D1 row writes/day, with no expiry date on the data.

```bash
cd analytics
npx wrangler login
npx wrangler d1 create spotified-analytics   # paste the printed id into wrangler.toml
npx wrangler d1 execute spotified-analytics --remote --file=schema.sql
npx wrangler deploy                           # prints https://spotified-analytics.<you>.workers.dev
```

Then set that URL as `ENDPOINT` in `app/static/js/analytics.js`, run
`python scripts/build_pages.py`, and push.

If your Pages site lives anywhere other than
`https://riyadhossain1998.github.io`, add the origin to `ALLOWED_ORIGINS` in
`worker.js` and redeploy — requests from anywhere else are refused, which is
what keeps someone else's page from writing into your table.

## Reading the data

```bash
cd analytics
q() { npx wrangler d1 execute spotified-analytics --remote --command "$1"; }

# Visits per day
q "SELECT date(ts) AS day, COUNT(*) FROM events WHERE kind='visit' GROUP BY day ORDER BY day DESC;"

# Most clicked songs
q "SELECT name, COUNT(*) AS clicks FROM events WHERE kind='song_click' GROUP BY name ORDER BY clicks DESC LIMIT 20;"

# Most clicked artists
q "SELECT name, COUNT(*) AS clicks FROM events WHERE kind='artist_click' GROUP BY name ORDER BY clicks DESC LIMIT 20;"

# How often a song click turned into opening Spotify
q "SELECT kind, COUNT(*) FROM events WHERE kind IN ('song_click','spotify_open') GROUP BY kind;"
```

Add `--json` for machine-readable output, or `--remote` → `--local` to query a
local copy.
