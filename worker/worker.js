// motm-shop: live catalog + checkout + order routing for monarchofthemoon.shop
// Secrets (set via Cloudflare API, never in code): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   PRINTFUL_API_TOKEN, PRINTIFY_API_TOKEN, CATALOG_REFRESH_TOKEN, BLOCKED_TERMS (comma list of words never shown),
//   PRINTIFY_WEBHOOK_SECRET (HMAC key for Printify webhooks), PRINTFUL_WEBHOOK_TOKEN (URL token for Printful webhooks).
// Vars: MODE ("test" | "live").  Binding: ORDERS (private R2 bucket motm-shop-orders): order records + catalog snapshots.
import { fetchPrintify, fetchPrintful, makeCleaner, assemble, PRINTFUL_STORE_ID, PRINTIFY_SHOP_ID } from './catalog-build.js';

const SITE = 'https://monarchofthemoon.shop';
const SHOP = SITE + '/shop/';
const STRIPE_VERSION = '2024-06-20';
const MAX_QTY = 10, MAX_LINES = 20;
const FRESH_MS = 5 * 60 * 1000;        // rebuild the catalog when older than this
const SHIP_DAYS = { CA: [5, 14], US: [5, 14] };

// ---------- live catalog ----------
// Snapshots in R2: catalog/printify.json + catalog/printful.json (last good per provider), catalog/public.json (merged).
// A cron trigger rebuilds every 5 minutes; requests also rebuild in the background if the snapshot is stale.
// If a provider API fails, its last good snapshot is used, so the shop keeps working.
let mem = null, building = null;
async function readR2(env, k) { const o = await env.ORDERS.get(k); return o ? o.json() : null; }
async function writeR2(env, k, v) { await env.ORDERS.put(k, JSON.stringify(v), { httpMetadata: { contentType: 'application/json' } }); }

let again = false;
async function rebuild(env) {
  // If a change arrives while a rebuild is running, run one more afterwards so the change isn't missed.
  if (building) { again = true; return building.then(() => (again ? (again = false, rebuild(env)) : mem)); }
  building = (async () => {
    const clean = makeCleaner(env.BLOCKED_TERMS || '');
    const sources = {};
    const run = async (name, fn) => {
      try {
        const list = await fn(env, clean);
        await writeR2(env, `catalog/${name}.json`, { at: Date.now(), list });
        sources[name] = { ok: true, at: Date.now() };
        return list;
      } catch (e) {
        const last = await readR2(env, `catalog/${name}.json`);
        sources[name] = { ok: false, error: String(e.message || e).slice(0, 200), at: last ? last.at : null };
        return last ? last.list : [];
      }
    };
    const lists = await Promise.all([run('printify', fetchPrintify), run('printful', fetchPrintful)]);
    const { products, hidden } = assemble(lists, clean);
    const prev = await readR2(env, 'catalog/public.json');
    // Never replace a good catalog with an empty one because both providers failed.
    if (!products.length && prev && prev.products.length && !sources.printify.ok && !sources.printful.ok) return prev;
    const cat = { currency: 'CAD', builtAt: Date.now(), sources, products, hidden };
    await writeR2(env, 'catalog/public.json', cat);
    mem = cat;
    try { await caches.default.delete(new Request('https://api.monarchofthemoon.shop/catalog')); } catch {}
    return cat;
  })().finally(() => { building = null; });
  return building;
}

async function getCatalog(env, ctx) {
  if (mem && Date.now() - mem.builtAt < 30000) return mem;
  const cat = await readR2(env, 'catalog/public.json');
  if (!cat) return rebuild(env);
  mem = cat;
  if (Date.now() - cat.builtAt > FRESH_MS) ctx.waitUntil(rebuild(env).catch(() => {}));   // serve stale, refresh behind
  return cat;
}
const publicView = c => ({ currency: c.currency, builtAt: c.builtAt, products: c.products });
const lookup = (cat, key) => { for (const p of cat.products) for (const v of p.variants) if (v.key === key) return { p, v }; return null; };

async function catalogEndpoint(req, env, ctx) {
  const cache = caches.default, ck = new Request('https://api.monarchofthemoon.shop/catalog');
  let res = await cache.match(ck);
  if (!res) {
    const cat = await getCatalog(env, ctx);
    res = new Response(JSON.stringify(publicView(cat)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
    ctx.waitUntil(cache.put(ck, res.clone()));
  }
  const h = new Headers(res.headers); for (const [k, v] of Object.entries(cors(req))) h.set(k, v);
  return new Response(res.body, { headers: h });
}

// Owner-only: force a refresh now. POST with "Authorization: Bearer <token>" or GET ?key=<token> (bookmarkable).
async function refreshEndpoint(req, env, url) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key') || '';
  const okTok = env.CATALOG_REFRESH_TOKEN && tok.length === env.CATALOG_REFRESH_TOKEN.length &&
    crypto.subtle.timingSafeEqual(enc.encode(tok), enc.encode(env.CATALOG_REFRESH_TOKEN));
  if (!okTok) return json(req, { error: 'Forbidden' }, 403);
  const prev = await readR2(env, 'catalog/public.json');
  const cat = (prev && Date.now() - prev.builtAt < 15000) ? prev : await rebuild(env);
  return json(req, { refreshed: new Date(cat.builtAt).toISOString(), sources: cat.sources,
    showing: cat.products.map(p => ({ id: p.id, title: p.title, variants: p.variants.length })), hidden: cat.hidden });
}

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

// ---------- cart pricing (server side, from the live catalog; client prices are never used) ----------
function priceCart(cat, items, country) {
  if (!['CA', 'US'].includes(country)) throw new Error('Please choose Canada or the United States.');
  if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty.');
  const merged = {};
  for (const it of items) {
    const key = String(it && it.key || '');
    const qty = Number(it && it.qty);
    if (!lookup(cat, key)) throw new Error('An item in your cart is no longer available. Please remove it and try again.');
    if (!Number.isInteger(qty) || qty < 1) throw new Error('Invalid quantity.');
    merged[key] = (merged[key] || 0) + qty;
  }
  const keys = Object.keys(merged);
  if (keys.length > MAX_LINES) throw new Error('Too many different items in one order.');
  const lines = [], groups = {};
  for (const key of keys) {
    const { p, v } = lookup(cat, key);
    if (merged[key] > MAX_QTY) throw new Error(`Maximum ${MAX_QTY} of each item per order.`);
    if (!p.shipsTo.includes(country)) throw new Error(`${p.title} does not ship to ${country === 'CA' ? 'Canada' : 'the United States'} yet.`);
    lines.push({ key, qty: merged[key], p, v });
    // one flat charge per shipment (production partner); the highest item rate in that shipment applies
    groups[p.shipGroup] = Math.max(groups[p.shipGroup] || 0, (v.ship && v.ship[country]) ?? p.ship[country]);
  }
  const shipping = Object.values(groups).reduce((a, b) => a + b, 0);
  return { lines, shipping };
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

// The order details travel with the Stripe session (key:qty:unitPriceCents, chunked into 480-char fields),
// so fulfilment never depends on the catalog still listing the item.
function cartMetadata(lines, country, shipping) {
  const md = { country, shipping: String(shipping) }; let chunk = '', n = 0;
  for (const l of lines) {
    const e = `${l.key}:${l.qty}:${l.v.price}`;
    if (chunk && (chunk + ',' + e).length > 480) { md['cart' + n++] = chunk; chunk = ''; }
    chunk = chunk ? chunk + ',' + e : e;
  }
  md['cart' + n] = chunk;
  return md;
}
function cartFromMetadata(md) {
  const all = Object.keys(md).filter(k => /^cart\d+$/.test(k)).sort((a, b) => a.slice(4) - b.slice(4)).map(k => md[k]).join(',');
  return all.split(',').filter(Boolean).map(x => { const [key, q, price] = x.split(':'); return { key, qty: Number(q), price: Number(price) }; });
}

async function checkout(req, env, ctx) {
  if (req.headers.get('Origin') !== SITE) return json(req, { error: 'Forbidden' }, 403);
  if (!keyModeOk(env)) return json(req, { error: 'Checkout is not configured yet.' }, 503);
  let body; try { body = await req.json(); } catch { return json(req, { error: 'Bad request' }, 400); }
  const cat = await getCatalog(env, ctx);
  let cart; try { cart = priceCart(cat, body.items, body.country); } catch (e) { return json(req, { error: e.message }, 400); }
  const c = body.country;
  const line_items = {};
  cart.lines.forEach((l, i) => {
    const img = l.p.images[l.v.image] || l.p.images[0];
    line_items[i] = { quantity: l.qty, price_data: { currency: 'cad', unit_amount: l.v.price,
      product_data: { name: l.p.title + (l.p.variants.length > 1 ? ' (' + l.v.label + ')' : ''),
        images: { 0: img }, metadata: { key: l.key } } } };
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
    metadata: cartMetadata(cart.lines, c, cart.shipping),
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
  const lines = cartFromMetadata(s.metadata).map(l => {
    const [prov, a, b] = l.key.split('.');
    return { ...l, provider: prov === 'pf' ? 'printful' : 'printify', fulfil: prov === 'pf' ? { sync_variant_id: Number(a) } : { product_id: a, variant_id: Number(b) } };
  });
  if (!lines.length || lines.some(l => !l.qty || (l.provider === 'printify' && !l.fulfil.variant_id))) throw new Error('Unreadable cart metadata');
  const sd = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || {};
  const a = sd.address || {}; const cd = s.customer_details || {};
  const name = sd.name || cd.name || '';
  const ship = { name, address1: a.line1, address2: a.line2 || '', city: a.city, state: a.state, country: a.country, zip: a.postal_code,
    phone: cd.phone || '', email: cd.email || '' };
  rec.error = null;
  const pf = lines.filter(l => l.provider === 'printful');
  const py = lines.filter(l => l.provider === 'printify');
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
    items: lines.map(l => ({ sync_variant_id: l.fulfil.sync_variant_id, quantity: l.qty, retail_price: (l.price / 100).toFixed(2) })),
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
    line_items: lines.map(l => ({ product_id: l.fulfil.product_id, variant_id: l.fulfil.variant_id, quantity: l.qty })),
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

// ---------- provider webhooks (instant catalog refresh + Printify publish handshake) ----------
const productUrl = id => `${SHOP}product.html?p=${encodeURIComponent(id)}`;
function hexEq(a, b) { return a.length === b.length && crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b)); }
async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function printify(env, method, path, body) {
  const r = await fetch(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/${path}`, { method,
    headers: { Authorization: 'Bearer ' + env.PRINTIFY_API_TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'motm-shop' },
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`Printify ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}
// Tell Printify the product is now live on our shop (unlocks it in Printify). Hidden products are
// still marked published; the shop simply keeps them hidden until their artwork changes.
async function markPublished(env, productId) {
  return printify(env, 'POST', `products/${productId}/publishing_succeeded.json`,
    { external: { id: productId, handle: productUrl('pfy-' + productId) } });
}
async function printifyWebhook(req, env, ctx) {
  const body = await req.text();
  const sig = (req.headers.get('X-Pfy-Signature') || '').replace(/^sha256=/i, '').toLowerCase();
  if (!env.PRINTIFY_WEBHOOK_SECRET || !sig || !hexEq(sig, await hmacHex(env.PRINTIFY_WEBHOOK_SECRET, body))) return new Response('bad signature', { status: 401 });
  const ev = JSON.parse(body);
  const pid = ev.resource && ev.resource.id;
  const log = { at: new Date().toISOString(), type: ev.type, product: pid, action: ev.resource && ev.resource.data && ev.resource.data.action };
  if (ev.type === 'product:publish:started' && pid && /^[a-f0-9]{24}$/.test(pid)) {
    try {
      if (log.action === 'delete') await printify(env, 'POST', `products/${pid}/unpublish.json`).catch(() => {});
      else await markPublished(env, pid);
      log.result = 'publishing_succeeded';
    } catch (e) {
      log.result = 'error: ' + e.message;
      try { await printify(env, 'POST', `products/${pid}/publishing_failed.json`, { reason: 'Shop could not confirm the product. Please try Publish again.' }); } catch {}
    }
  }
  ctx.waitUntil(Promise.all([rebuild(env).catch(() => {}), writeR2(env, `webhooks/printify/${Date.now()}-${ev.id || 'x'}.json`, log)]));
  return new Response(JSON.stringify(log), { headers: { 'Content-Type': 'application/json' } });
}
async function printfulWebhook(req, env, ctx, url) {
  const tok = url.searchParams.get('token') || '';
  if (!env.PRINTFUL_WEBHOOK_TOKEN || !hexEq(tok, env.PRINTFUL_WEBHOOK_TOKEN)) return new Response('forbidden', { status: 403 });
  let ev = {}; try { ev = await req.json(); } catch {}
  if (ev.store && String(ev.store) !== PRINTFUL_STORE_ID) return new Response('other store, ignored');
  const log = { at: new Date().toISOString(), type: ev.type, product: ev.data && (ev.data.sync_product && ev.data.sync_product.id) };
  ctx.waitUntil(Promise.all([rebuild(env).catch(() => {}), writeR2(env, `webhooks/printful/${Date.now()}.json`, log)]));
  return new Response('ok');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    try {
      if (req.method === 'GET' && url.pathname === '/catalog') return await catalogEndpoint(req, env, ctx);
      if (url.pathname === '/catalog/refresh' && ['GET', 'POST'].includes(req.method)) return await refreshEndpoint(req, env, url);
      if (req.method === 'POST' && url.pathname === '/checkout') return await checkout(req, env, ctx);
      if (req.method === 'POST' && url.pathname === '/stripe-webhook') return await webhook(req, env);
      if (req.method === 'POST' && url.pathname === '/printify-webhook') return await printifyWebhook(req, env, ctx);
      if (req.method === 'POST' && url.pathname === '/printful-webhook') return await printfulWebhook(req, env, ctx, url);
      if (req.method === 'GET' && url.pathname === '/order') return await orderStatus(req, env, url);
      if (req.method === 'GET' && url.pathname === '/health') return json(req, { ok: true, mode: env.MODE, ready: keyModeOk(env) && !!env.STRIPE_WEBHOOK_SECRET });
      return json(req, { error: 'Not found' }, 404);
    } catch (e) {
      return json(req, { error: 'Something went wrong. Please try again.' }, 500);
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(rebuild(env)); },
};
