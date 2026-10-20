#!/usr/bin/env bash
# Point the shop at Stripe TEST or LIVE mode in one step.
#   worker/stripe-mode.sh test STRIPE_TEST_SECRET_KEY   # env var holding an sk_test_ key
#   worker/stripe-mode.sh live STRIPE_SECRET_KEY        # env var holding an sk_live_ key
# What it does (never prints keys):
#   1. creates (or replaces) the Stripe webhook endpoint https://api.monarchofthemoon.shop/stripe-webhook
#   2. stores the Stripe key + webhook signing secret as Worker secrets
#   3. redeploys the Worker with MODE=test|live
# In test mode Printful orders are drafts and Printify orders are never sent to production.
# In live mode orders are confirmed / sent to production automatically (real charges + shipping).
set -euo pipefail
cd "$(dirname "$0")"
MODE="$1"; VAR="$2"
case "$MODE" in test) WANT=sk_test_;; live) WANT=sk_live_;; *) echo "mode must be test or live"; exit 1;; esac
KEY="${!VAR:-}"
[[ "$KEY" == $WANT* ]] || { echo "env $VAR does not hold a ${WANT}... secret key"; exit 1; }
export _SK="$KEY"
WHSEC=$(python3 - <<'P'
import os, json, urllib.request, urllib.parse
sk = os.environ['_SK']; url = 'https://api.monarchofthemoon.shop/stripe-webhook'
def call(method, path, data=None):
    req = urllib.request.Request('https://api.stripe.com/v1/' + path, method=method,
        data=urllib.parse.urlencode(data).encode() if data else None,
        headers={'Authorization': 'Bearer ' + sk, 'Stripe-Version': '2024-06-20', 'User-Agent': 'Mozilla/5.0'})
    return json.load(urllib.request.urlopen(req))
for ep in call('GET', 'webhook_endpoints?limit=100')['data']:
    if ep['url'] == url: call('DELETE', 'webhook_endpoints/' + ep['id'])
ep = call('POST', 'webhook_endpoints', [('url', url), ('api_version', '2024-06-20'),
    ('enabled_events[]', 'checkout.session.completed'), ('enabled_events[]', 'checkout.session.async_payment_succeeded'),
    ('description', 'Monarch of the Moon shop orders')])
print(ep['secret'])
P
)
export _WH="$WHSEC"
./set-secret.sh STRIPE_SECRET_KEY _SK
./set-secret.sh STRIPE_WEBHOOK_SECRET _WH
unset _SK _WH WHSEC KEY
./deploy.sh "$MODE"
