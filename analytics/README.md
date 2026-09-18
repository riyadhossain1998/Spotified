# Worker

One Cloudflare Worker serving two routes, both of which exist because GitHub
Pages has no server of its own:

| route | purpose |
| --- | --- |
| `POST /` | record an event (below) |
| `GET /artists?ids=` | resolve artist names, pictures and genres |

## Why the artist route exists

`GET /v1/artists` returns **403** for the browser app's PKCE *user* token — for a
single id as readily as for fifty, so it is neither batch size nor the rate limit
— while the identical ids return **200 with images** for a *client-credentials*
token. Client credentials needs a client secret, a secret cannot ship to a
browser, so the lookup has to happen somewhere with a server.

Without this, every artist lookup failed, each artist fell back to the bare name
on its track credit, and every node in the graph rendered as a placeholder `?`.

The route answers in Spotify's own JSON shape, so the browser parses one format
whatever served it. It takes 1–50 ids, rejects anything that is not a 22-character
Spotify id, and caches for a day — keyed on the *sorted* id list, so two playlists
sharing artists share one cache entry and a reload costs Spotify nothing.

Reads are also allowed from `http://127.0.0.1:<port>` so the graph has pictures
during local development. Writes stay locked to the published origin.

## Analytics

It records four things and nothing else:

| kind | recorded when | `name` |
| --- | --- | --- |
| `visit` | a page is opened | — |
| `artist_click` | an artist is opened in the detail panel | artist name |
| `song_click` | a song row is clicked | song name |
| `spotify_open` | "Open in Spotify instead" is followed | — (count only) |

No session id, no visitor id, no IP address, no user agent. A row records that
*something happened*, never *who did it*, so there is nothing here to leak.

Both front ends use the same client module, `app/static/js/analytics.js`.
Setting `ENDPOINT` there to `""` turns reporting off everywhere.

## What is deployed

| | |
| --- | --- |
| Worker | `https://spotified-analytics.riyad-hossain114.workers.dev` |
| D1 database | `spotified-analytics` · `91fdb76d-21d6-4121-b626-f629a1209a0c` |
| Free limits | 100k Worker requests/day, 100k D1 row writes/day, no expiry |

Neither id is a secret: they name resources, and reaching either still needs an
API token for the account that owns them.

Only `https://riyadhossain1998.github.io` may write. Everything else gets a 403,
which is what keeps someone else's page out of the table — and, incidentally,
what keeps local development out of the numbers without anyone having to
remember to blank `ENDPOINT` first. To measure a local run deliberately, add its
origin to `ALLOWED_ORIGINS` in `worker.js` and redeploy.

## Reading the data

```bash
cd analytics
./query.sh                                         # counts by event kind
./query.sh "SELECT date(ts) day, COUNT(*) n FROM events WHERE kind='visit' GROUP BY day ORDER BY day DESC"
./query.sh "SELECT name, COUNT(*) clicks FROM events WHERE kind='song_click' GROUP BY name ORDER BY clicks DESC LIMIT 20"
./query.sh "SELECT name, COUNT(*) clicks FROM events WHERE kind='artist_click' GROUP BY name ORDER BY clicks DESC LIMIT 20"
./query.sh "SELECT kind, COUNT(*) n FROM events WHERE kind IN ('song_click','spotify_open') GROUP BY kind"
```

That last one is the useful one: the gap between `song_click` and
`spotify_open` is how often someone looked at a track and then actually went to
listen to it.

## Redeploying

`wrangler` is the normal tool, but it needs Node 22 and this was set up on a
machine with Node 16, so both the deploy and `query.sh` use the same HTTP API
wrangler talks to. With a new enough Node, the usual commands work unchanged:

```bash
npx wrangler deploy
npx wrangler d1 execute spotified-analytics --remote --command "SELECT COUNT(*) FROM events"
```

Otherwise, to push a change to `worker.js`:

```bash
TOKEN=$(security find-generic-password -s "cloudflare-api-token" -w)
ACCOUNT=ade8e1a50d8bd4ea70b72c5d0e9f8e58
CID=$(security find-generic-password -s "spotify-client-id" -w)
SECRET=$(security find-generic-password -s "spotify-client-secret" -w)

METADATA=$(python3 - <<PY
import json, os
print(json.dumps({
    "main_module": "worker.js",
    "compatibility_date": "2026-09-01",
    "bindings": [
        {"type": "d1", "name": "DB", "id": "91fdb76d-21d6-4121-b626-f629a1209a0c"},
        {"type": "secret_text", "name": "SPOTIFY_CLIENT_ID", "text": os.environ["CID"]},
        {"type": "secret_text", "name": "SPOTIFY_CLIENT_SECRET", "text": os.environ["SECRET"]},
    ],
}))
PY
)

curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -F "metadata=$METADATA;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/spotified-analytics"
```

**The secret bindings must be included on every upload.** This API call replaces
the script *and* its bindings, so a deploy that omits them leaves the Worker
running without credentials, and `/artists` answers 500 until the next full
deploy. (It says so in the response body rather than failing silently.)

The Cloudflare token needs only `D1:Edit` and `Workers Scripts:Edit`, scoped to
the account. `query.sh` explains how to put one in the keychain. The two Spotify
values go in the same place:

```bash
security add-generic-password -U -s "spotify-client-id" -a "$USER" -w
security add-generic-password -U -s "spotify-client-secret" -a "$USER" -w
```

These are the credentials of the older, non-PKCE Spotify app — the configuration
measured to return 200 on `/v1/artists`. They currently also sit in plaintext in a
comment in `EtherialNetwork/spotipy_connection.py` in the legacy project, so the
secret is worth rotating in the Spotify dashboard and re-uploading here.
