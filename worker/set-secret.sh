#!/usr/bin/env bash
# Store a Worker secret from an environment variable without printing it.
# Usage: worker/set-secret.sh SECRET_NAME ENV_VAR_NAME
set -euo pipefail
NAME="$1"; VAR="$2"; VAL="${!VAR:-}"
[ -n "$VAL" ] || { echo "env $VAR is empty" >&2; exit 1; }
ACCT=f7fcde645a5e2af201e38d57a8ed84d3
python3 -c 'import json,sys,os;print(json.dumps({"name":sys.argv[1],"text":os.environ[sys.argv[2]],"type":"secret_text"}))' "$NAME" "$VAR" |
curl -s -A Mozilla -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/motm-shop/secrets" --data-binary @- |
python3 -c 'import json,sys;d=json.load(sys.stdin);print("secret",sys.argv[1],"set:",d["success"],d.get("errors"))' "$NAME"
