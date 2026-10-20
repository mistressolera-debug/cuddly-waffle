// Monarch of the Moon shop: catalog, cart (localStorage) and checkout.
const API = 'https://api.monarchofthemoon.shop';
const CART_KEY = 'motm_cart_v1', COUNTRY_KEY = 'motm_country';
const money = c => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(c / 100);
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let CATALOG;
async function loadCatalog() {
  if (!CATALOG) CATALOG = await (await fetch('catalog.json', { cache: 'no-cache' })).json();
  return CATALOG;
}
function findVariant(key) {
  for (const p of CATALOG.products) for (const v of p.variants) if (v.key === key) return { p, v };
  return null;
}
function getCart() { try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; } }
function setCart(c) { localStorage.setItem(CART_KEY, JSON.stringify(c)); updateCount(); }
function addToCart(key, qty) {
  const c = getCart(); const it = c.find(x => x.key === key);
  if (it) it.qty = Math.min(10, it.qty + qty); else c.push({ key, qty: Math.min(10, qty) });
  setCart(c);
}
function updateCount() {
  const n = getCart().reduce((a, x) => a + x.qty, 0);
  document.querySelectorAll('[data-count]').forEach(el => { el.textContent = n; });
}
function toast(msg) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
const fromPrice = p => Math.min(...p.variants.map(v => v.price));
const shipsLabel = p => p.shipsTo.length === 2 ? 'Ships to Canada & USA' : 'Ships to USA only';

// ---------- grid ----------
async function renderGrid() {
  await loadCatalog();
  $('#grid').innerHTML = CATALOG.products.map(p => `
    <a class="card" href="product.html?p=${encodeURIComponent(p.slug)}">
      <div class="ph"><img src="${esc(p.images[p.variants[0].image] || p.images[0])}" alt="${esc(p.title)}" loading="lazy" width="400" height="400"></div>
      <div class="info"><h2 class="serif">${esc(p.title)}</h2>
        <div class="price">${p.variants.length > 1 && new Set(p.variants.map(v => v.price)).size > 1 ? 'From ' : ''}${money(fromPrice(p))}</div>
        <span class="tag">${shipsLabel(p)}</span></div>
    </a>`).join('');
}

// ---------- product ----------
async function renderProduct() {
  await loadCatalog();
  const slug = new URLSearchParams(location.search).get('p');
  const p = CATALOG.products.find(x => x.slug === slug);
  const root = $('#product');
  if (!p) { root.innerHTML = '<div class="center"><h1 class="serif">Item not found</h1><p><a class="gold" href="./">Back to the shop</a></p></div>'; return; }
  document.title = p.title + ' | Monarch of the Moon';
  const sel = {}; const first = p.variants[0];
  p.options.forEach(o => { sel[o] = first.options[o]; });
  let qty = 1, imgIdx = first.image;
  root.innerHTML = `
    <div><div class="main-img"><img id="mainimg" alt=""></div><div class="thumbs" id="thumbs"></div></div>
    <div><p class="eyebrow gold">Monarch of the Moon</p><h1 class="serif">${esc(p.title)}</h1>
      <p class="bigprice" id="price"></p>
      <div id="opts"></div>
      <div class="row"><div class="qty"><button type="button" id="minus" aria-label="Less">&minus;</button><input id="q" inputmode="numeric" value="1" aria-label="Quantity"><button type="button" id="plus" aria-label="More">+</button></div></div>
      <button class="btn" id="add" type="button">Add to cart</button>
      <div class="note">${shipsLabel(p)}. Made to order, usually ships in 2&ndash;7 business days. Flat-rate shipping is added at checkout.</div>
      <div class="desc">${p.description.map(d => `<p>${esc(d)}</p>`).join('')}</div>
    </div>`;
  const current = () => p.variants.find(v => p.options.every(o => v.options[o] === sel[o]));
  function drawImages() {
    const v = current();
    const list = p.images.map((src, i) => ({ src, i })).filter(x => !p.imageVariants || !v || p.imageVariants[x.i].includes(v.fulfil.variant_id));
    if (!list.some(x => x.i === imgIdx)) imgIdx = list[0].i;
    $('#mainimg').src = p.images[imgIdx]; $('#mainimg').alt = p.title + (v ? ' (' + v.label + ')' : '');
    $('#thumbs').innerHTML = list.length > 1 ? list.map(x => `<button type="button" data-i="${x.i}" aria-current="${x.i === imgIdx}" aria-label="Photo ${x.i + 1}"><img src="${esc(x.src)}" alt="" loading="lazy"></button>`).join('') : '';
  }
  function draw() {
    $('#opts').innerHTML = p.options.map(o => {
      const vals = [...new Set(p.variants.map(v => v.options[o]))];
      return `<fieldset class="opt"><legend>${esc(o)}: <span class="gold">${esc(sel[o])}</span></legend><div class="chips">${vals.map(val => {
        const ok = p.variants.some(v => v.options[o] === val && p.options.every(o2 => o2 === o || v.options[o2] === sel[o2]));
        const anyOk = p.variants.some(v => v.options[o] === val);
        return `<button type="button" class="chip" data-o="${esc(o)}" data-v="${esc(val)}" aria-pressed="${sel[o] === val}" ${anyOk ? '' : 'disabled'} ${ok ? '' : 'data-switch="1"'}>${esc(val)}</button>`;
      }).join('')}</div></fieldset>`;
    }).join('');
    const v = current();
    $('#price').textContent = v ? money(v.price) : 'Not available';
    $('#add').disabled = !v;
    $('#add').textContent = v ? 'Add to cart' : 'Choose another option';
    drawImages();
  }
  root.addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (c && !c.disabled) {
      sel[c.dataset.o] = c.dataset.v;
      if (!current()) { const v = p.variants.find(v => v.options[c.dataset.o] === c.dataset.v); Object.assign(sel, v.options); }
      imgIdx = current().image; draw(); return;
    }
    const t = e.target.closest('#thumbs button'); if (t) { imgIdx = Number(t.dataset.i); drawImages(); return; }
    if (e.target.id === 'minus') { qty = Math.max(1, qty - 1); $('#q').value = qty; }
    if (e.target.id === 'plus') { qty = Math.min(10, qty + 1); $('#q').value = qty; }
  });
  $('#q').addEventListener('change', e => { qty = Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)); e.target.value = qty; });
  $('#add').addEventListener('click', () => { const v = current(); if (!v) return; addToCart(v.key, qty); toast('Added to cart'); });
  draw();
}

// ---------- cart ----------
function shippingFor(lines, country) {
  const groups = new Set(lines.map(l => l.p.shipGroup)); let s = 0;
  for (const g of groups) { const r = CATALOG.shipping.rates[g][country]; if (r === undefined) return null; s += r; }
  return s;
}
async function renderCart() {
  await loadCatalog();
  const root = $('#cart');
  let cart = getCart().filter(x => findVariant(x.key));
  setCart(cart);
  const countrySel = localStorage.getItem(COUNTRY_KEY) || 'CA';
  if (!cart.length) { root.innerHTML = '<div class="center"><p class="muted">Your cart is empty.</p><p><a class="btn" style="max-width:280px" href="./">Browse the shop</a></p></div>'; return; }
  const lines = cart.map(x => ({ ...x, ...findVariant(x.key) }));
  const sub = lines.reduce((a, l) => a + l.v.price * l.qty, 0);
  const country = countrySel;
  const ship = shippingFor(lines, country);
  const blocked = lines.filter(l => !l.p.shipsTo.includes(country));
  root.innerHTML = `
    <div class="panel">${lines.map(l => `
      <div class="line"><img src="${esc(l.p.images[l.v.image] || l.p.images[0])}" alt="">
        <div><div class="t">${esc(l.p.title)}</div>${l.p.variants.length > 1 ? `<div class="v">${esc(l.v.label)}</div>` : ''}
          <div class="row" style="margin:6px 0 0"><div class="qty"><button type="button" data-d="-1" data-k="${esc(l.key)}" aria-label="Less">&minus;</button><input value="${l.qty}" readonly aria-label="Quantity"><button type="button" data-d="1" data-k="${esc(l.key)}" aria-label="More">+</button></div>
          <button class="rm" type="button" data-rm="${esc(l.key)}">Remove</button></div>
          ${l.p.shipsTo.includes(country) ? '' : '<div class="err">Ships to the USA only. Remove it or change the country.</div>'}</div>
        <div class="gold">${money(l.v.price * l.qty)}</div></div>`).join('')}</div>
    <div class="panel">
      <label for="country" class="eyebrow muted">Ship to</label>
      <select id="country" style="margin-top:8px"><option value="CA" ${country === 'CA' ? 'selected' : ''}>Canada</option><option value="US" ${country === 'US' ? 'selected' : ''}>United States</option></select>
      <div style="margin-top:14px">
        <div class="sum"><span>Subtotal</span><span>${money(sub)}</span></div>
        <div class="sum"><span>Shipping (flat rate)</span><span>${ship === null ? '&mdash;' : money(ship)}</span></div>
        <div class="sum total"><span>Total (CAD)</span><span>${ship === null ? '&mdash;' : money(sub + ship)}</span></div>
      </div>
      <button class="btn" id="checkout" type="button" style="margin-top:14px" ${blocked.length ? 'disabled' : ''}>Secure checkout</button>
      <p class="err" id="err" role="alert"></p>
      <p class="muted" style="font-size:.82rem;margin:6px 0 0">Payment is handled securely by Stripe. You'll enter your shipping address on the next page.</p>
    </div>`;
  root.onclick = e => {
    const b = e.target.closest('[data-d]'); const r = e.target.closest('[data-rm]');
    if (b) { const it = cart.find(x => x.key === b.dataset.k); it.qty = Math.max(1, Math.min(10, it.qty + Number(b.dataset.d))); setCart(cart); renderCart(); }
    if (r) { cart = cart.filter(x => x.key !== r.dataset.rm); setCart(cart); renderCart(); }
  };
  $('#country').onchange = e => { localStorage.setItem(COUNTRY_KEY, e.target.value); renderCart(); };
  $('#checkout').onclick = async () => {
    const btn = $('#checkout'); btn.disabled = true; btn.textContent = 'Opening secure checkout…'; $('#err').textContent = '';
    try {
      const r = await fetch(API + '/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country, items: cart.map(x => ({ key: x.key, qty: x.qty })) }) });
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.error || 'Checkout is unavailable right now.');
      location.href = d.url;
    } catch (err) {
      $('#err').textContent = err.message === 'Failed to fetch' ? 'Could not reach checkout. Check your connection and try again.' : err.message;
      btn.disabled = false; btn.textContent = 'Secure checkout';
    }
  };
}

// ---------- success ----------
async function renderSuccess() {
  const id = new URLSearchParams(location.search).get('session_id');
  const root = $('#done');
  if (!id) { root.innerHTML = '<p class="muted">No order found.</p>'; return; }
  try {
    const r = await fetch(API + '/order?session_id=' + encodeURIComponent(id)); const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    if (d.paid) {
      setCart([]);
      root.innerHTML = `<h1 class="serif gold">Thank you!</h1><p>Your payment of <strong>${money(d.total)}</strong> went through and your order is in.${d.email ? ` We have <strong>${esc(d.email)}</strong> on file for it.` : ''}</p>
        <p class="muted">Each item is made to order and usually ships within 2&ndash;7 business days. Questions? Email <a class="gold" href="mailto:sj@monarchofthemoon.shop">sj@monarchofthemoon.shop</a>.</p>`;
    } else root.innerHTML = '<h1 class="serif">Payment pending</h1><p class="muted">Your payment is still processing. You will get an email once it is confirmed.</p>';
  } catch { root.innerHTML = '<h1 class="serif">Thank you!</h1><p class="muted">We could not load your order details just now, but if you completed payment you will receive a receipt by email.</p>'; }
}

document.addEventListener('DOMContentLoaded', () => {
  updateCount();
  const page = document.body.dataset.page;
  ({ grid: renderGrid, product: renderProduct, cart: renderCart, success: renderSuccess }[page] || (() => {}))();
});
