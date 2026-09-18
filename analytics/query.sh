#!/usr/bin/env bash
#
# Run a read-only query against the deployed analytics database.
#
#   ./query.sh "SELECT COUNT(*) FROM events"
#   ./query.sh                                  # no argument: the standard summary
#
# This exists because `wrangler d1 execute` needs Node 22 and the machine this
# was set up on has Node 16. It talks to the same D1 HTTP API wrangler does, so
# it is a shortcut rather than a second way of doing things.
#
# The token is read from the login keychain and never appears in a command line
# or in shell history. Create it once with:
#
#   security add-generic-password -s "cloudflare-api-token" -a "$USER" -W
#
set -euo pipefail

ACCOUNT_ID="ade8e1a50d8bd4ea70b72c5d0e9f8e58"
DATABASE_ID="91fdb76d-21d6-4121-b626-f629a1209a0c"

TOKEN=$(security find-generic-password -s "cloudflare-api-token" -w) || {
  echo "No cloudflare-api-token in the keychain. See the comment at the top of this file." >&2
  exit 1
}

SQL="${1:-}"
if [[ -z "$SQL" ]]; then
  SQL="SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC"
fi

python3 -c "import json,sys; print(json.dumps({'sql': sys.argv[1]}))" "$SQL" \
  | curl -s -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      --data @- \
      "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database/$DATABASE_ID/query" \
  | python3 -c '
import json, sys

response = json.load(sys.stdin)
if not response.get("success"):
    print("Query failed:", response.get("errors"), file=sys.stderr)
    raise SystemExit(1)

for statement in response["result"]:
    rows = statement.get("results") or []
    if not rows:
        print("(no rows)")
        continue
    columns = list(rows[0])
    widths = [
        max(len(c), max(len(str(r.get(c, ""))) for r in rows)) for c in columns
    ]
    print("  ".join(c.ljust(w) for c, w in zip(columns, widths)))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(row.get(c, "")).ljust(w) for c, w in zip(columns, widths)))
'
