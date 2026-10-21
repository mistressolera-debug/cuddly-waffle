# cuddly-waffle

Static site for [monarchofthemoon.shop](https://monarchofthemoon.shop), the Monarch of the Moon family-friendly shop, hosted on GitHub Pages (no build step).

- `index.html`: the public "Shop launching soon" page (still the homepage)
- `shop/`: the working store, at the unlinked, `noindex` preview URL https://monarchofthemoon.shop/shop/
  - `product.html?p=<id>`, `cart.html`, `success.html`, `cancel.html`, `shop.js`, `shop.css`
  - Products, prices, photos and options come live from `https://api.monarchofthemoon.shop/catalog` (no product files to edit).
- `worker/`: Cloudflare Worker `motm-shop` at https://api.monarchofthemoon.shop
  - `GET /catalog`: live catalog built from Printify shop 29406700 + Printful store 18926641 (published, enabled, available variants only; duplicates collapsed). Rebuilt by a cron every 5 minutes and kept in private R2 (`motm-shop-orders/catalog/`). If a provider API is down, its last good copy is used.
  - `POST /printify-webhook`: Printify shop webhooks (publish started, product created/updated/deleted), verified with the `X-Pfy-Signature` HMAC. On "publish started" it confirms the publish to Printify (`publishing_succeeded`, handle = the product's page on this shop) so the product unlocks, then refreshes the catalog.
  - `POST /printful-webhook?token=...`: Printful store webhooks (product synced/updated/deleted) -> catalog refresh.
  - `GET|POST /catalog/refresh`: owner-only instant rebuild (`Authorization: Bearer <CATALOG_REFRESH_TOKEN>` or `?key=<token>`); returns what is showing and what is hidden.
  - `POST /checkout`: re-prices the cart from the live catalog (client prices are ignored) and opens a Stripe Checkout Session (CAD, CA or US shipping address, phone, flat-rate shipping)
  - `POST /stripe-webhook`: verifies the Stripe signature; on `checkout.session.completed` creates the Printful and Printify orders. Idempotent per Checkout Session (records in R2 `orders/`).
  - `GET /order?session_id=...`: payment status for the thank-you page; `GET /health`
  - `catalog-build.js`: provider fetch + cleanup. `review.js`: reviewed artwork that stays hidden (file ids only) and display-title tweaks.
- `legal/`: shipping, returns, privacy, terms (to be added once the business details are filled in)
- `CNAME`: custom domain (do not change)

## Shipping

The shopper picks Canada or USA in the cart; Stripe then only accepts an address in that country. Each production partner
shipment is charged once, at the highest rate of the items in it:
- Printful items: flat CA $10.95 / US $7.95.
- Printify items: Printify's published first-item cost for that product (USD x 1.40, rounded up to .95), never below CA $10.95 / US $6.95.
  Countries also come from Printify's shipping profiles (e.g. the woven blanket ships to the US only).

## Hidden artwork

`worker/review.js` lists design files that were reviewed and must not be shown. Any product using one of them is hidden.
Uploading new artwork in Printify/Printful creates a new file, so the product appears automatically within ~5 minutes.
`APPROVED_ART` in the same file lists products the owner approved to show anyway (only while their artwork is unchanged).
Titles and descriptions are also filtered against a private word list (Worker secret `BLOCKED_TERMS`).

## Test mode vs live

The Worker has `MODE=test` or `MODE=live`.

- **test**: Stripe test key; Printful orders are created as drafts (`confirm=false`) and Printify orders are never sent to production. Nothing is charged by the suppliers and nothing ships.
- **live**: Printful orders are confirmed and Printify orders are sent to production automatically.

Switch with one command (needs `CLOUDFLARE_API_TOKEN` and the Stripe key in an environment variable; nothing is printed):

```bash
worker/stripe-mode.sh test STRIPE_TEST_SECRET_KEY   # sk_test_ key
worker/stripe-mode.sh live STRIPE_SECRET_KEY        # sk_live_ key: real payments + real orders
```

This (re)creates the Stripe webhook endpoint for that mode, stores the Stripe key and webhook signing secret as Worker secrets, and redeploys the Worker.

## Going live checklist

1. Approve the products, prices, shipping rates and wording on the preview.
2. Fill in the legal pages and add them to `legal/` + footer links.
3. Decide on sales tax (Stripe Tax or manual) and turn on Stripe email receipts.
4. Run `worker/stripe-mode.sh live STRIPE_SECRET_KEY`.
5. Replace the homepage (or link it) to `/shop/` and remove the `noindex` tags in `shop/*.html`.
