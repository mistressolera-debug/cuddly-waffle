#!/usr/bin/env bash
# Deploy the motm-shop Worker. Needs CLOUDFLARE_API_TOKEN in the environment.
# Usage: worker/deploy.sh [test|live]   (default: keeps "test")
set -euo pipefail
cd "$(dirname "$0")"
MODE="${1:-test}"
ACCT=f7fcde645a5e2af201e38d57a8ed84d3
API="https://api.cloudflare.com/client/v4/accounts/$ACCT"
AUTH=(-A Mozilla -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
# Private R2 bucket for order records / idempotency (created once).
curl -s "${AUTH[@]}" -X POST "$API/r2/buckets" -H 'Content-Type: application/json' -d '{"name":"motm-shop-orders"}' >/dev/null || true
{ printf "export default "; cat ../shop/catalog.json; printf ";\n"; } > catalog.js
cat > metadata.json <<J
{"main_module":"worker.js","compatibility_date":"2025-01-01",
 "bindings":[{"type":"r2_bucket","name":"ORDERS","bucket_name":"motm-shop-orders"},
             {"type":"plain_text","name":"MODE","text":"$MODE"}],
 "keep_bindings":["secret_text"]}
J
curl -s "${AUTH[@]}" -X PUT "$API/workers/scripts/motm-shop" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" \
  -F "catalog.js=@catalog.js;type=application/javascript+module" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("deploy:",d["success"],d.get("errors"))'
# Served only at the custom domain api.monarchofthemoon.shop (workers.dev URL disabled).
curl -s "${AUTH[@]}" -X POST "$API/workers/scripts/motm-shop/subdomain" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null
rm -f metadata.json catalog.js
echo "MODE=$MODE  https://api.monarchofthemoon.shop/health"
