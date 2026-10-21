// Builds the live shop catalog from the Printify + Printful APIs.
// Shared by the Worker (runtime) and local test scripts (node >= 20).
import { BLOCKED_ART, TITLE_OVERRIDES } from './review.js';

export const PRINTFUL_STORE_ID = '18926641';
export const PRINTIFY_SHOP_ID = '29406700';
// Flat shipping (CAD cents) used when a provider doesn't publish a cost, and as the minimum.
export const FLAT = { printful: { CA: 1095, US: 795 }, printify: { CA: 1095, US: 695 } };
const FX_USD_CAD = 1.40;            // conversion for Printify's USD shipping costs
const COUNTRIES = ['CA', 'US'];
const blocked = new Set(BLOCKED_ART);

const enc = new TextEncoder();
export async function sha(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...h].map(b => b.toString(16).padStart(2, '0')).join('');
}
const toCadRate = usdCents => Math.ceil(usdCents * FX_USD_CAD / 100) * 100 - 5; // e.g. 14.55 -> 14.95

// ---------- text cleaning ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', period: '.', comma: ',', colon: ':', semi: ';',
  mdash: '—', ndash: '–', percnt: '%', excl: '!', quest: '?', lpar: '(', rpar: ')', hyphen: '-', sol: '/', num: '#',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', times: '×', reg: '®', trade: '™', copy: '©', bull: '•', middot: '·', plus: '+', equals: '=', ast: '*' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
function termsRegex(terms) {
  if (!terms.length) return null;
  const alt = terms.map(t => t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
  return new RegExp(`(?:\\bthe\\s+)?(?:${alt})\\w*(?:['’]s)?`, 'gi');
}
const SELLER_JUNK = /(creating this product|print provider|mockups do not|visit the link|design guidelines|printify|printful)/i;

export function makeCleaner(termList) {
  const terms = termList.split(',').map(s => s.trim()).filter(Boolean);
  const anyTerm = terms.length ? new RegExp(terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')).join('|'), 'i') : null;
  const strip = termsRegex(terms);
  const dirty = s => !!(anyTerm && anyTerm.test(s));
  function title(raw) {
    let t = decode(raw).replace(/^\s*copy of\s+/i, '');
    if (strip) t = t.replace(strip, ' ');
    t = t.replace(/\b(edition)\b/gi, m => m).replace(/\s+/g, ' ')
      .replace(/\s*([,|–—:-]\s*)+$/g, '').replace(/^\s*([,|–—:-]\s*)+/g, '').replace(/\s*,\s*,/g, ',').trim();
    if (t.length > 44 && t.includes(',')) {                                  // drop SEO tails
      const seg = t.split(',').map(x => x.trim()).filter(Boolean); t = seg.shift();
      while (t.length < 20 && seg.length) t += ', ' + seg.shift();
    }
    t = t.replace(/^["“](.+?)["”]\s*/, '$1 ')
      .replace(/(\w)["”](?=\w)/g, '$1 ')                    // stray closing quote glued to a word
      .replace(/^\s*M\s*[.,]\s*S\b\.?\s*/i, '')               // leading initials prefix ("M.S", "M,S")
      .replace(/\s+/g, ' ').trim();
    if ((t.match(/["“”]/g) || []).length % 2) t = t.replace(/["“”]/g, '').trim();
    return t;
  }
  function description(html) {
    const text = decode(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, ''));
    return text.split(/\n+/).map(l => l.replace(/^[\s.:•\-–]+/, '').replace(/\s+/g, ' ').trim())
      .filter(l => l.length > 1 && !SELLER_JUNK.test(l))
      .map(l => dirty(l) ? l.split(/(?<=[.!?])\s+/).filter(s => !dirty(s)).join(' ') : l)
      .filter(l => l.length > 1 && !dirty(l) && !/^please note:?$/i.test(l)).slice(0, 12);
  }
  return { title, description, dirty };
}

// ---------- providers ----------
async function getJSON(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': 'motm-shop', ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

export async function fetchPrintify(env, clean) {
  const H = { Authorization: 'Bearer ' + env.PRINTIFY_API_TOKEN };
  const all = [];
  for (let page = 1; page < 20; page++) {
    const d = await getJSON(`https://api.printify.com/v1/shops/${PRINTIFY_SHOP_ID}/products.json?limit=50&page=${page}`, H);
    all.push(...d.data);
    if (!d.next_page_url || page >= d.last_page) break;
  }
  const shipCache = {};
  const shipping = async (bp, pp) => {
    const k = bp + '/' + pp;
    if (!(k in shipCache)) shipCache[k] = getJSON(`https://api.printify.com/v1/catalog/blueprints/${bp}/print_providers/${pp}/shipping.json`, H).catch(() => null);
    return shipCache[k];
  };
  const out = [];
  for (const p of all) {
    if (p.is_deleted || p.visible === false) continue;
    const ev = p.variants.filter(v => v.is_enabled && v.is_available !== false);
    if (!ev.length) continue;
    const art = [...new Set(p.print_areas.flatMap(pa => pa.placeholders.flatMap(ph => ph.images.map(i => i.id).filter(Boolean))))].sort();
    const ver = (await sha(art.join('|'))).slice(0, 10);
    const ids = new Set(ev.map(v => v.id));
    const nice = n => ({ Types: 'Finish', Finish: p.blueprint_id === 1626 ? 'Weave' : 'Finish' }[n]) ||
      (/frame/i.test(n) && /colou?r/i.test(n) ? 'Frame' : /size/i.test(n) ? 'Size' : /colou?r/i.test(n) ? 'Color' : /depth/i.test(n) ? 'Depth' : n);
    const optNames = p.options.map(o => nice(o.name)).map((n, i, a) => a.indexOf(n) === i ? n : p.options[i].name);
    const vals = p.options.map(o => Object.fromEntries(o.values.map(v => [v.id, String(v.title).replace(/''/g, '"')])));
    const key = v => `pfy.${p.id}.${v}`;
    const images = [], imageVariants = [], vimg = {};
    for (const im of p.images) {
      if (im.is_selected_for_publishing === false) continue;
      const vs = im.variant_ids.filter(x => ids.has(x)); if (!vs.length) continue;
      const idx = images.length;
      images.push(im.src + (im.src.includes('?') ? '&' : '?') + 'v=' + ver);
      imageVariants.push(vs.map(key));
      for (const x of vs) if (im.is_default || !(x in vimg)) vimg[x] = idx;
      if (images.length >= 24) break;
    }
    if (!images.length) continue;
    // option value id -> option index (variant.options is not always in the same order as product.options)
    const owner = {}; vals.forEach((m, i) => { for (const id of Object.keys(m)) owner[id] = i; });
    const variants = ev.map(v => {
      const picked = []; for (const oid of v.options) if (oid in owner) picked[owner[oid]] = vals[owner[oid]][oid];
      const options = {}; optNames.forEach((n, i) => { if (picked[i] !== undefined) options[n] = picked[i]; });
      return { key: key(v.id), label: Object.values(options).join(' / '), options, price: v.price, image: vimg[v.id] ?? 0, id: v.id };
    });
    // Shipping: countries + cost from Printify's published profiles for this blueprint/provider.
    const prof = await shipping(p.blueprint_id, p.print_provider_id);
    // Per variant: cheapest published profile for the country (= standard shipping), else the rest-of-world one.
    const shipsTo = [];
    for (const c of COUNTRIES) {
      let all = true;
      for (const v of variants) {
        let cost = null;
        if (prof) {
          const mine = prof.profiles.filter(pr => pr.variant_ids.includes(v.id));
          let costs = mine.filter(pr => pr.countries.includes(c)).map(pr => pr.first_item.cost);
          if (!costs.length) costs = mine.filter(pr => pr.countries.includes('REST_OF_THE_WORLD')).map(pr => pr.first_item.cost);
          if (!costs.length) { all = false; break; }
          cost = Math.min(...costs);
        }
        (v.ship ||= {})[c] = cost === null ? FLAT.printify[c] : Math.max(FLAT.printify[c], toCadRate(cost));
      }
      if (all) shipsTo.push(c);
    }
    for (const v of variants) { for (const c of COUNTRIES) if (!shipsTo.includes(c)) delete v.ship[c]; delete v.id; }
    const ship = {}; for (const c of shipsTo) ship[c] = Math.min(...variants.map(v => v.ship[c]));
    if (!shipsTo.length) continue;
    out.push({ id: 'pfy-' + p.id, provider: 'printify', sourceId: p.id, rawTitle: p.title,
      title: TITLE_OVERRIDES[(await sha(p.title)).slice(0, 16)] || clean.title(p.title),
      description: clean.description(p.description), options: optNames, images, imageVariants, variants,
      shipsTo, ship, shipGroup: 'printify-' + p.print_provider_id, art: art.map(a => 'pfy:' + a),
      dedupe: `pfy|${p.blueprint_id}|${p.print_provider_id}|${art.join(',')}`, created: p.created_at, copy: /^\s*copy of/i.test(p.title) });
  }
  return out;
}

export async function fetchPrintful(env, clean) {
  const H = { Authorization: 'Bearer ' + env.PRINTFUL_API_TOKEN, 'X-PF-Store-Id': PRINTFUL_STORE_ID };
  const list = [];
  for (let off = 0; off < 1000; off += 100) {
    const d = await getJSON(`https://api.printful.com/store/products?limit=100&offset=${off}`, H);
    list.push(...d.result); if (list.length >= d.paging.total || !d.result.length) break;
  }
  const descCache = {};
  const out = [];
  for (const sp of list) {
    if (sp.is_ignored) continue;
    const r = (await getJSON(`https://api.printful.com/store/products/${sp.id}`, H)).result;
    const ev = r.sync_variants.filter(v => !v.is_ignored && v.synced !== false && v.availability_status === 'active');
    if (!ev.length) continue;
    const bad = ev.find(v => v.currency !== 'CAD'); if (bad) continue;
    const art = new Set(); const previews = [];
    for (const v of ev) for (const f of v.files) {
      if (f.hash) art.add('pf:' + f.hash); else if (f.id) art.add('pf:id' + f.id);
      if (f.type === 'preview' && f.preview_url && !previews.includes(f.preview_url)) previews.push(f.preview_url);
    }
    const images = previews.length ? previews : [r.sync_product.thumbnail_url].filter(Boolean);
    if (!images.length) continue;
    const colors = [...new Set(ev.map(v => v.color).filter(Boolean))], sizes = [...new Set(ev.map(v => v.size).filter(Boolean))];
    const options = [...(colors.length > 1 ? ['Color'] : []), ...(sizes.length > 1 ? ['Size'] : [])];
    const variants = ev.map(v => {
      const o = {}; if (options.includes('Color')) o.Color = v.color; if (options.includes('Size')) o.Size = v.size;
      const pv = v.files.find(f => f.type === 'preview');
      return { key: 'pf.' + v.id, label: Object.values(o).join(' / ') || 'One size', options: o,
        price: Math.round(parseFloat(v.retail_price) * 100), image: Math.max(0, pv ? images.indexOf(pv.preview_url) : 0) };
    });
    const cp = ev[0].product.product_id;
    if (!(cp in descCache)) descCache[cp] = getJSON(`https://api.printful.com/products/${cp}`, {}).then(d => d.result.product.description || '').catch(() => '');
    const desc = await descCache[cp];
    const previewHash = previews.map(u => u.split('/').pop()).sort().join(',');
    out.push({ id: 'pf-' + sp.id, provider: 'printful', sourceId: String(sp.id), rawTitle: sp.name,
      title: TITLE_OVERRIDES[(await sha(sp.name)).slice(0, 16)] || clean.title(sp.name),
      description: clean.description(desc.replace(/\n/g, '<br>')), options, images, imageVariants: null, variants,
      shipsTo: ['CA', 'US'], ship: { ...FLAT.printful }, shipGroup: 'printful', art: [...art],
      dedupe: `pf|${cp}|${previewHash}`, created: String(sp.id), copy: /^\s*copy of/i.test(sp.name) });
  }
  return out;
}

// Merge provider lists -> public catalog (hide reviewed artwork, filter words, dedupe).
export function assemble(lists, clean) {
  const hidden = [], products = [];
  for (const p of lists.flat()) {
    if (p.art.some(a => blocked.has(a))) { hidden.push({ id: p.id, why: 'reviewed artwork shows blocked text' }); continue; }
    if (!p.title || clean.dirty(p.title) || p.variants.some(v => clean.dirty(v.label))) { hidden.push({ id: p.id, why: 'title still has blocked words' }); continue; }
    products.push(p);
  }
  const groups = {};
  for (const p of products) (groups[p.dedupe] ||= []).push(p);
  const keep = [];
  for (const g of Object.values(groups)) {
    g.sort((a, b) => (b.variants.length - a.variants.length) || (b.images.length - a.images.length) || (a.copy - b.copy) || String(a.created).localeCompare(String(b.created)));
    keep.push(g[0]); for (const d of g.slice(1)) hidden.push({ id: d.id, why: 'duplicate of ' + g[0].id });
  }
  keep.sort((a, b) => a.provider.localeCompare(b.provider) || a.title.localeCompare(b.title));
  const pub = keep.map(({ rawTitle, art, dedupe, created, copy, ...rest }) => rest);
  return { products: pub, hidden };
}
