# cuddly-waffle

Static site for [monarchofthemoon.shop](https://monarchofthemoon.shop), the Monarch of the Moon family-friendly shop, hosted on GitHub Pages (no build step).

- `index.html`: the public "Shop launching soon" page (still the homepage)
- `shop/`: the working store, at the unlinked, `noindex` preview URL https://monarchofthemoon.shop/shop/
  - `catalog.json`: the product list, display titles, prices (CAD cents), variants, images and flat shipping rates.
    The Worker uses this same file as its server-side price list, so redeploy the Worker after editing it.
  - `img/`: product mockups from Printful / Printify
  - `product.html?p=<slug>`, `cart.html`, `success.html`, `cancel.html`, `shop.js`, `shop.css`
- `worker/`: Cloudflare Worker `motm-shop` at https://api.monarchofthemoon.shop
  - `POST /checkout`: re-prices the cart from the catalog (client prices are ignored) and opens a Stripe Checkout Session (CAD, CA or US shipping address, phone, flat-rate shipping)
  - `POST /stripe-webhook`: verifies the Stripe signature; on `checkout.session.completed` creates the Printful order (tote) and the Printify order (sticker, blanket). Idempotent per Checkout Session (records in private R2 bucket `motm-shop-orders`).
  - `GET /order?session_id=...`: payment status for the thank-you page; `GET /health`
- `legal/`: shipping, returns, privacy, terms (to be added once the business details are filled in)
- `CNAME`: custom domain (do not change)

## Shipping

Flat rate per production partner shipment (see `shipping.rates` in `shop/catalog.json`):
tote (Printful) CA $10.95 / US $7.95, sticker CA $10.95 / US $6.95, blanket (US only) $14.95. A cart with items from
several partners pays each partner's rate once. The shopper picks Canada or USA in the cart; Stripe then only accepts an address in that country.

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
