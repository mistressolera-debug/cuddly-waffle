// motm-shop: checkout + order routing for monarchofthemoon.shop
// Secrets (set via Cloudflare API, never in code): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   PRINTFUL_API_TOKEN, PRINTIFY_API_TOKEN.  Vars: MODE ("test" | "live").
// Binding: ORDERS (R2 bucket motm-shop-orders) for idempotency + order log.
import CATALOG from './catalog.js';

const SITE = 'https://monarchofthemoon.shop';
const SHOP = SITE + '/shop/';
const PRINTFUL_STORE_ID = '18926641';
const PRINTIFY_SHOP_ID = '29406700';
const STRIPE_VERSION = '2024-06-20';
const MAX_QTY = 10, MAX_LINES = 20;

// Flat shipping (CAD cents) per production group, from the catalog; each group ships separately.
const SHIPPING = CATALOG.shipping.rates;
const SHIP_DAYS = CATALOG.shipping.days;

// Build lookup: variant key -> { product, variant }
const VARIANTS = {};
for (const p of CATALOG.products) for (const v of p.variants) VARIANTS[v.key] = { p, v };
const groupOf = (p) => p.shipGroup;

function cors(req) {
  const o = req.headers.get('Origin');
  const h = { 'Vary': 'Origin' };
  if (o === SITE) Object.assign(h, {
    'Access-Control-Allow-Origin': SITE,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  return h;
}
const json = (req, data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(req) } });

// ---------- cart pricing (server side; client prices are never used) ----------
function priceCart(items, country) {
  if (!['CA', 'US'].includes(country)) throw new Error('Please choose Canada or the United States.');
  if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty.');
  const merged = {};
  for (const it of items) {
    const key = String(it && it.key || '');
    const qty = Number(it && it.qty);
    if (!VARIANTS[key]) throw new Error('An item in your cart is no longer available. Please remove it and try again.');
    if (!Number.isInteger(qty) || qty < 1) throw new Error('Invalid quantity.');
    merged[key] = (merged[key] || 0) + qty;
  }
  const keys = Object.keys(merged);
  if (keys.length > MAX_LINES) throw new Error('Too many different items in one order.');
  const lines = [], groups = new Set();
  for (const key of keys) {
    const { p, v } = VARIANTS[key];
    if (merged[key] > MAX_QTY) throw new Error(`Maximum ${MAX_QTY} of each item per order.`);
    if (!p.shipsTo.includes(country)) throw new Error(`${p.title} does not ship to ${country === 'CA' ? 'Canada' : 'the United States'} yet.`);
    lines.push({ key, qty: merged[key], p, v });
    groups.add(groupOf(p, v));
  }
  let shipping = 0;
  for (const g of groups) shipping += SHIPPING[g][country];
  return { lines, shipping, groups: [...groups] };
}

// ---------- Stripe helpers ----------
function form(obj, prefix = '', out = []) {
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof val === 'object') form(val, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
  }
  return out.join('&');
}
async function stripe(env, method, path, body) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method, body: body ? form(body) : undefined,
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Stripe-Version': STRIPE_VERSION,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Stripe: ' + (d.error && d.error.message || r.status));
  return d;
}
function keyModeOk(env) {
  const k = env.STRIPE_SECRET_KEY || '';
  return env.MODE === 'live' ? k.startsWith('sk_live_') || k.startsWith('rk_live_') : k.startsWith('sk_test_') || k.startsWith('rk_test_');
}

async function checkout(req, env) {
  if (req.headers.get('Origin') !== SITE) return json(req, { error: 'Forbidden' }, 403);
  if (!keyModeOk(env)) return json(req, { error: 'Checkout is not configured yet.' }, 503);
  let body; try { body = await req.json(); } catch { return json(req, { error: 'Bad request' }, 400); }
  let cart; try { cart = priceCart(body.items, body.country); } catch (e) { return json(req, { error: e.message }, 400); }
  const c = body.country;
  const line_items = {};
  cart.lines.forEach((l, i) => {
    const img = l.p.images[l.v.image] || l.p.images[0];
    line_items[i] = { quantity: l.qty, price_data: { currency: 'cad', unit_amount: l.v.price,
      product_data: { name: l.p.title + (l.p.variants.length > 1 ? ' (' + l.v.label + ')' : ''),
        images: { 0: SHOP + img }, metadata: { key: l.key } } } };
  });
  const session = await stripe(env, 'POST', 'checkout/sessions', {
    mode: 'payment', currency: 'cad', line_items,
    shipping_address_collection: { allowed_countries: { 0: c } },
    phone_number_collection: { enabled: 'true' },
    billing_address_collection: 'auto',
    shipping_options: { 0: { shipping_rate_data: { type: 'fixed_amount', display_name: 'Standard shipping',
      fixed_amount: { amount: cart.shipping, currency: 'cad' },
      delivery_estimate: { minimum: { unit: 'business_day', value: SHIP_DAYS[c][0] }, maximum: { unit: 'business_day', value: SHIP_DAYS[c][1] } } } } },
    success_url: SHOP + 'success.html?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: SHOP + 'cancel.html',
    metadata: { cart: cart.lines.map(l => l.key + ':' + l.qty).join(','), country: c, shipping: String(cart.shipping) },
    payment_intent_data: { description: 'Monarch of the Moon order' },
  });
  return json(req, { url: session.url });
}

// Public order status for the success page (session ids are unguessable).
async function orderStatus(req, env, url) {
  const id = url.searchParams.get('session_id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return json(req, { error: 'Bad session' }, 400);
  let s; try { s = await stripe(env, 'GET', 'checkout/sessions/' + id); } catch { return json(req, { error: 'Not found' }, 404); }
  const rec = await env.ORDERS.get('orders/' + id);
  const r = rec ? await rec.json() : null;
  return json(req, { paid: s.payment_status === 'paid', total: s.amount_total, currency: s.currency,
    email: s.customer_details && s.customer_details.email || null,
    fulfilment: r ? (r.error ? 'retrying' : 'sent') : 'pending' });
}

// ---------- Stripe webhook ----------
const enc = new TextEncoder();
async function verifyStripe(env, payload, header) {
  if (!header || !env.STRIPE_WEBHOOK_SECRET) return false;
  const parts = {}; const v1 = [];
  for (const kv of header.split(',')) { const [k, v] = kv.split('='); if (k === 'v1') v1.push(v); else parts[k] = v; }
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + payload)));
  const hex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  return v1.some(s => s.length === hex.length && crypto.subtle.timingSafeEqual(enc.encode(s), enc.encode(hex)));
}

async function webhook(req, env) {
  const payload = await req.text();
  if (!(await verifyStripe(env, payload, req.headers.get('Stripe-Signature')))) return new Response('bad signature', { status: 400 });
  const event = JSON.parse(payload);
  if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return new Response('ignored');
  if (event.livemode !== (env.MODE === 'live')) return new Response('mode mismatch, ignored');
  const s = event.data.object;
  if (s.payment_status !== 'paid') return new Response('not paid yet');
  try {
    const rec = await fulfil(env, s, event.livemode);
    return new Response(JSON.stringify(rec), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response('fulfilment error: ' + e.message, { status: 500 }); // Stripe retries
  }
}

async function fulfil(env, s, live) {
  const id = s.id, path = 'orders/' + id;
  const old = await env.ORDERS.get(path);
  const rec = old ? await old.json() : { session: id, created: new Date().toISOString(), live };
  if (rec.printful !== undefined && rec.printify !== undefined && !rec.error) return rec; // already done
  const country = s.metadata.country;
  const items = (s.metadata.cart || '').split(',').filter(Boolean).map(x => { const [key, q] = x.split(':'); return { key, qty: Number(q) }; });
  const { lines } = priceCart(items, country);
  const sd = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
  const a = sd.address || {}; const cd = s.customer_details || {};
  const name = sd.name || cd.name || '';
  const ship = { name, address1: a.line1, address2: a.line2 || '', city: a.city, state: a.state, country: a.country, zip: a.postal_code,
    phone: cd.phone || '', email: cd.email || '' };
  rec.error = null;
  const pf = lines.filter(l => l.p.provider === 'printful');
  const py = lines.filter(l => l.p.provider === 'printify');
  try {
    if (rec.printful === undefined) rec.printful = pf.length ? await printfulOrder(env, id, ship, pf, Number(s.metadata.shipping || 0), live) : null;
    if (rec.printify === undefined) rec.printify = py.length ? await printifyOrder(env, id, ship, py, live) : null;
  } catch (e) { rec.error = e.message; }
  rec.updated = new Date().toISOString();
  await env.ORDERS.put(path, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
  if (rec.error) throw new Error(rec.error);
  return rec;
}

async function extId(id) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(id)));
  return 'motm' + [...h].slice(0, 14).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function printfulOrder(env, sessionId, ship, lines, shippingCents, live) {
  const external_id = await extId(sessionId);
  const headers = { Authorization: 'Bearer ' + env.PRINTFUL_API_TOKEN, 'X-PF-Store-Id': PRINTFUL_STORE_ID, 'Content-Type': 'application/json' };
  const body = {
    external_id, shipping: 'STANDARD',
    recipient: { name: ship.name, address1: ship.address1, address2: ship.address2, city: ship.city, state_code: ship.state,
      country_code: ship.country, zip: ship.zip, phone: ship.phone, email: ship.email },
    items: lines.map(l => ({ sync_variant_id: l.v.fulfil.sync_variant_id, quantity: l.qty, retail_price: (l.v.price / 100).toFixed(2) })),
    retail_costs: { currency: 'CAD' },
  };
  // Test mode: confirm=false leaves a DRAFT that is never produced or charged.
  const r = await fetch('https://api.printful.com/orders?confirm=' + (live ? 'true' : 'false'), { method: 'POST', headers, body: JSON.stringify(body) });
  const d = await r.json();
  if (r.ok) return { id: d.result.id, external_id, status: d.result.status };
  const existing = await fetch('https://api.printful.com/orders/@' + external_id, { headers });
  if (existing.ok) { const e = await existing.json(); return { id: e.result.id, external_id, status: e.result.status }; }
  throw new Error('Printful: ' + (d.error && d.error.message || d.result || r.status));
}

async function printifyOrder(env, sessionId, ship, lines, live) {
  const headers = { Authorization: 'Bearer ' + env.PRINTIFY_API_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'motm-shop' };
  const parts = (ship.name || '').trim().split(/\s+/);
  const first = parts.shift() || 'Customer', last = parts.join(' ') || '-';
  const body = {
    external_id: sessionId, label: 'MOTM ' + sessionId.slice(-8),
    line_items: lines.map(l => ({ product_id: l.v.fulfil.product_id, variant_id: l.v.fulfil.variant_id, quantity: l.qty })),
    shipping_method: 1, is_printify_express: false, is_economy_shipping: false, send_shipping_notification: false,
    address_to: { first_name: first, last_name: last, email: ship.email, phone: ship.phone, country: ship.country, region: ship.state,
      address1: ship.address1, address2: ship.address2, city: ship.city, zip: ship.zip },
  };
  const base = `https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/orders`;
  const r = await fetch(base + '.json', { method: 'POST', headers, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error('Printify: ' + JSON.stringify(d.errors || d.message || r.status).slice(0, 300));
  // Test mode: the order stays on hold and is never sent to production (no cost, nothing ships).
  if (live) {
    const p = await fetch(`${base}/${d.id}/send_to_production.json`, { method: 'POST', headers });
    if (!p.ok) throw new Error('Printify send_to_production failed for order ' + d.id);
  }
  return { id: d.id, sent_to_production: live };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    try {
      if (req.method === 'POST' && url.pathname === '/checkout') return await checkout(req, env);
      if (req.method === 'POST' && url.pathname === '/stripe-webhook') return await webhook(req, env);
      if (req.method === 'GET' && url.pathname === '/order') return await orderStatus(req, env, url);
      if (req.method === 'GET' && url.pathname === '/health') return json(req, { ok: true, mode: env.MODE, ready: keyModeOk(env) && !!env.STRIPE_WEBHOOK_SECRET });
      return json(req, { error: 'Not found' }, 404);
    } catch (e) {
      return json(req, { error: 'Something went wrong. Please try again.' }, 500);
    }
  },
};
