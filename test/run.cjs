// Loads the unpacked extension into Chrome for Testing and drives it against
// invented Wirecutter-like pages in six layouts, served at
// https://www.nytimes.com/wirecutter/test/<layout>/, and an invented Amazon
// deals grid at amazon.com/blackfriday/3/ (--only amazon) and an invented
// copy of the Times' interactive gift guide (--only guide), then invented
// pages on other hosts for the generic detectors (--only shop, roundup,
// loadmore, infinite, jsonld, amazon-renamed, wirecutter-nocob, article,
// start). Pages come from request interception and every hostname resolves
// to nothing, so no request leaves the machine.
//
// The extension loaded is a temporary copy whose manifest runs pager.js on
// every http(s) page, so the generic detectors can be tried on other hosts;
// the rest of the manifest is copied as it stands.
//
//   node test/run.cjs [--shots DIR] [--only NAME]
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const SRC = path.resolve(__dirname, '..');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A copy of the extension with pager.js matched on every page. manifest.json
// may be mid-edit; wait for it to parse.
function widenedCopy() {
  let manifest;
  for (let t = 0; ; t++) {
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
      break;
    } catch (e) {
      if (t >= 30) throw new Error(`manifest.json stayed unreadable: ${e.message}`);
      sleepSync(1000);
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deal-flash-ext-'));
  fs.cpSync(SRC, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(SRC, src);
      return !rel || (!/^(\.git|node_modules|test|shots)(\/|$)/.test(rel) && !rel.endsWith('.zip'));
    },
  });
  const cs = (manifest.content_scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []);
  let entry = cs.find((c) => Array.isArray(c.js) && c.js.includes('pager.js'));
  if (!entry) cs.push((entry = { js: ['pager.js'], run_at: 'document_idle' }));
  entry.matches = ['http://*/*', 'https://*/*'];
  delete entry.exclude_matches;
  delete entry.include_globs;
  delete entry.exclude_globs;
  // An icon that isn't there (yet) would stop the copy from loading.
  const prune = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) if (typeof v === 'string' && !fs.existsSync(path.join(dir, v))) delete o[k];
  };
  prune(manifest.icons);
  if (manifest.action) prune(manifest.action.default_icon);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}
const EXT = widenedCopy();
process.on('exit', () => fs.rmSync(EXT, { recursive: true, force: true }));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const SHOTS = arg('--shots');
const ONLY = arg('--only');
const BASE = 'https://www.nytimes.com/wirecutter/test/';

// ---------- fixtures ----------

const COLORS = ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#a8c686', '#8e6c88', '#3d5a80', '#ee6c4d'];
const svg = (label, color, h) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="24" y="60" font-size="44" fill="#fff" font-family="sans-serif">${label}</text></svg>`,
  )}`;
const img = (k, h = 300) => `<img data-item="${k}" width="560" height="${h}" alt="" src="${svg(`Item ${k + 1}`, COLORS[k % COLORS.length], h)}">`;
const out = (k) => `/wirecutter/out/link/${1000 + k}/2/4/${3000 + k}/?merchant=Amazon`;
const blurb = 'An invented product blurb that runs long enough to wrap onto a second line in the column, like the real write-ups do.';

const wrap = (body, extra = '') => `<!doctype html><html><head><title>The Best Test Deals | Wirecutter</title>
<style>body{margin:0;font:18px/1.5 Georgia,serif;color:#222;background:#f9f9f9}
header.site{position:sticky;top:0;height:56px;background:#fff;border-bottom:1px solid #ddd;display:flex;align-items:center;padding:0 24px;font:700 20px sans-serif;z-index:10}
article{max-width:680px;margin:0 auto;padding:24px}
.card{border-top:1px solid #eee;padding:24px 0}.buy{display:inline-block;background:#111;color:#fff;padding:8px 14px;border-radius:4px;text-decoration:none;font:600 14px sans-serif}
img{max-width:100%;height:auto;display:block}</style></head>
<body><header class="site">Wirecutter <input placeholder="Search" style="margin-left:auto"></header>
<main><article><h1>The Best Test Deals</h1><p>${blurb} ${blurb}</p>${body}
<h2>Why you should trust us</h2><p>${blurb} <a href="https://example.org/study">A study</a>.</p>
<nav><h3>Related guides</h3><a href="https://www.amazon.com/not-an-item">Sponsored</a></nav>
</article></main><footer><h3>Footer</h3><a href="https://www.amazon.com/footer">x</a></footer>${extra}</body></html>`;

let k = 0;
const range = (n, f) => Array.from({ length: n }, f).join('');
const fixtures = {
  // Mirrors the real page (inspected 2026-11-21): category <section> with an
  // h2, then flat runs of h3 tagline, .global-cob card (h2 product name,
  // image, price buttons with screen-reader text), description, "Read more".
  wirecutter() {
    k = 0;
    const sr = (t) => `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)">${t}</span>`;
    const price = (i, m, j) => `<div class="product-pricebox-${j}"><span><a data-item="${i}" style="display:block;background:#000;color:#fff;padding:10px;margin:8px 0;font:700 15px sans-serif;text-decoration:none"
      href="https://www.nytimes.com/wirecutter/out/deals/${5000 + i * 10 + j}?merchant=${m}">${sr('Buying options:')}<span>$${144 + i} from <span><del>$${190 + i}${sr('DEAL, original price')}</del>${sr(', sale price')}</span> <span>${m}</span></span>${sr(', opens in a new tab')}</a></span>
      <div><p style="font:14px sans-serif;text-align:center">You save $46 (24%)</p></div></div>`;
    const product = (i, n, name, merchants) => `<div id="product-${i}-${n}"><div style="display:flex;gap:20px"><div style="flex:0 0 40%">
      <a href="https://www.nytimes.com/wirecutter/out/deals/${5000 + i * 10}?merchant=Amazon">${img(i, 240)}</a></div>
      <div style="flex:1"><div><div><h2 data-item="${i}" style="font:700 22px sans-serif"><a href="https://www.nytimes.com/wirecutter/out/deals/${5000 + i * 10}?merchant=Amazon">${name}</a></h2></div>
      <p style="font:500 16px sans-serif">Card blurb for ${name}, short and sweet.</p><div>${merchants.map((m, j) => price(i, m, j)).join('')}</div></div></div></div></div>`;
    const item = (double) => {
      const i = k++;
      const prods = product(i, 0, `Test Product ${i + 1}`, ['Amazon', 'Walmart']) + (double ? product(i, 1, `Test Product ${i + 1} Bundle`, ['Target']) : '');
      return `<h3 data-item="${i}" style="font:800 19px sans-serif">Tagline for item ${i + 1}</h3>
        <div class="ebb615ab global-cob" style="background:#fff;border:1px solid #121212;padding:16px">${prods}</div>
        <p data-item="${i}">${blurb} Description of item ${i + 1}.</p>
        <p>Read more: <a href="https://www.nytimes.com/wirecutter/reviews/test-${i}/">The Best Test Thing</a></p>`;
    };
    const section = (id, name, items) => `<section id="${id}"><h2>${name}</h2><div id="${id}-panel">
      <figure><img width="560" height="200" alt="" src="${svg('Section photo', '#999', 200)}"><figcaption>Photo credit</figcaption></figure>${items}</div></section>`;
    const extra = `<div class="browse" style="position:fixed;top:-50px;left:0;right:0;height:44px;background:#f1efe9;z-index:15;transition:top .15s;font:700 15px sans-serif;padding:12px 24px">BROWSE Sections in this article</div>
      <div class="nl" style="position:fixed;left:0;right:0;bottom:0;height:110px;background:#5bc0ff;z-index:20;font:700 28px sans-serif;padding:20px">One week to better sleep <a href="https://www.nytimes.com/newsletters/sleep">Sign Up</a></div>
      <script>addEventListener('scroll', () => { document.querySelector('.browse').style.top = scrollY > 400 ? '56px' : '-50px'; });</script>`;
    const html = wrap(section('tech', 'Tech deals', item() + item(true) + item() + item()) + section('home', 'Home deals', range(3, () => item())), extra);
    return { html, count: 7, buys: 2, titles: { 1: 'Test Product 2 + Test Product 2 Bundle' }, deck: true, category: 'Tech deals' };
  },
  // Each product wrapped in its own card, grouped under category h2 sections,
  // with a newsletter promo after the second card.
  cards() {
    k = 0;
    const card = () => {
      const i = k++;
      const promo = i === 1 ? `<div class="promo" style="background:#5bc0ff;padding:32px"><h4>One week to better sleep</h4><p>A newsletter crash course.</p><a href="https://www.nytimes.com/newsletters/sleep">Sign Up</a></div>` : '';
      return `<div class="card">${img(i)}<h3 data-item="${i}"><a href="${out(i)}">Test Product ${i + 1}</a></h3>
        <p><s>$${99 + i}</s> $${59 + i}</p><p>${blurb}</p><a class="buy" data-item="${i}" href="https://www.nytimes.com${out(i)}">$${59 + i} from Amazon</a></div>${promo}`;
    };
    const section = (name, n) => `<section><h2>${name}</h2>${range(n, card)}</section>`;
    return { html: wrap(section('Tech deals', 4) + section('Home deals', 3) + section('Kitchen deals', 3)), count: 10, buys: 1, category: 'Tech deals' };
  },
  // Flat siblings, image ABOVE each product name; some headings sit in a wrapper div; an ad mid-item.
  flatAbove() {
    k = 0;
    const item = () => {
      const i = k++;
      const h = `<h3 data-item="${i}">Test Product ${i + 1}</h3>`;
      const ad = i === 1 ? '<div class="ad" style="background:#eee;height:90px">Advertisement</div>' : '';
      return `<figure>${img(i, 260)}</figure>${i % 2 ? `<div class="hw">${h}</div>` : h}
        <p>${blurb}</p>${ad}<p><a data-item="${i}" href="https://www.amazon.com/dp/TEST${i}">Buy from Amazon</a> ($${20 + i})</p>`;
    };
    const cat = (name, n) => `<h2>${name}</h2>${range(n, item)}`;
    return { html: wrap(cat('Tech deals', 5) + cat('Home deals', 4)), count: 9, buys: 1, category: 'Tech deals' };
  },
  // Flat siblings, image BELOW each product name.
  flatBelow() {
    k = 0;
    const item = () => {
      const i = k++;
      return `<h3 data-item="${i}">Test Product ${i + 1}</h3><p>${blurb}</p>
        <p><a data-item="${i}" href="https://www.target.com/p/test-${i}">$${30 + i} from Target</a></p><figure>${img(i, 220)}</figure>`;
    };
    return { html: wrap(`<h2>Gifts</h2>${range(8, item)}`), count: 8, buys: 1, category: 'Gifts' };
  },
  // Cards with no headings at all: title in <strong>.
  noHeadings() {
    k = 0;
    const card = () => {
      const i = k++;
      return `<div class="card">${img(i, 200)}<p><strong data-item="${i}">Test Product ${i + 1}</strong></p><p>${blurb}</p>
        <a class="buy" data-item="${i}" href="https://www.nytimes.com${out(i)}">Buy from Walmart</a></div>`;
    };
    return { html: wrap(`<h2>All the deals</h2>${range(7, card)}`), count: 7, buys: 1 };
  },
  // Category headings over bullet lists of deals, no images.
  bullets() {
    k = 0;
    const li = () => {
      const i = k++;
      return `<li data-item="${i}"><a data-item="${i}" href="https://www.nytimes.com${out(i)}">Test Product ${i + 1}</a> for $${40 + i} (from $${60 + i}). ${blurb}</li>`;
    };
    const cat = (name, n) => `<h2>${name}</h2><ul>${range(n, li)}</ul>`;
    return { html: wrap(cat('Tech', 6) + cat('Home', 6)), count: 12, buys: 0, noImage: true };
  },
};

// Mirrors Amazon's deal grid (inspected 2026-11-22 on /events/devicedeals/):
// product cards with Amazon's test ids, screen-reader price and title text
// beside aria-hidden visual copies, a hidden "global ratings" line, a hero
// card outside the grid, and a virtualized list that only draws the rows
// near the screen and loads 16 more deals (of 40) when its end comes near.
const AMAZON_URL = 'https://www.amazon.com/blackfriday/3/';
const amazonTitle = (i) => `TestDeal ${i + 1} Wireless Gadget (newest model), a long product title that Amazon cuts short in the grid`;

// Runs in the page (serialized with toString), so it can't use anything above.
function amazonScript() {
  const TOTAL = 40, ROW = 380, COLS = 4;
  let loaded = 24, loading = false;
  // ?button: past the first 24, Amazon stops loading on scroll and shows its
  // "View more deals" button under the grid instead (as /blackfriday/3/ does
  // past about 200).
  let paused = new URLSearchParams(location.search).has('button');
  const swapped = new Set(); // deals Amazon has swapped for another colour
  const title = (i) => `TestDeal ${i + 1} Wireless Gadget (newest model), a long product title that Amazon cuts short in the grid` + (swapped.has(i) ? ' (Blue)' : '');
  const card = (i) => {
    const asin = (swapped.has(i) ? 'B0BLUE' : 'B0TEST') + String(i).padStart(4, '0');
    const price = `${20 + i}.99`, old = `${50 + 2 * i}.99`, kind = i % 3 === 1 ? 'List' : 'Typical';
    const pct = Math.round((1 - (20.99 + i) / (50.99 + 2 * i)) * 100);
    const href = `/Test-Gadget-${i}/dp/${asin}/ref=dlx_deals_dg_dcl_${asin}?pf_rd_r=XYZ`;
    const src = `https://m.media-amazon.com/images/I/test${i}._AC_SF226,226_QL85_.jpg?aicid=discounts-widgets-horizonte`;
    const t = title(i);
    return `<div data-testid="product-card" role="group" data-item="${i}">
      <div><a data-testid="product-card-link" href="${href}"><div><picture><img src="${src}" srcset="${src} 1x, ${src.replace('SF226,226_QL85', 'SF339,339_QL80')} 1.5x" alt=""></picture></div></a>
        <div><button data-testid="add-to-cart-button" aria-label="See options">+</button></div></div>
      <a data-testid="product-card-link" href="${href}">
        <div><span><div><div role="presentation"><span>${pct}% off</span></div><div role="presentation"><span>Black Friday Deal</span></div></div></span></div>
        <div data-testid="price-section"><div><span><span class="sr">Deal Price: $${price}</span><span aria-hidden="true"><span>$</span><span>${20 + i}<span>.</span></span><span>99</span></span></span></div>
          <div><span aria-hidden="true">${kind}:</span><span><span class="sr">${kind}: $${old}</span><span aria-hidden="true">$${old}</span></span></div></div>
        <p><span><span><span class="sr">${t}</span><span aria-hidden="true">${t.slice(0, 40)}…</span></span></span></p></a>
      <div data-testid="product-reviews"><div data-testid="review-stars"><span><span data-testid="review-value" aria-hidden="true">4.${i % 10}</span>
        <span><a data-testid="review-distribution-toggle" role="button" aria-label="4.${i % 10} out of 5 stars">★★★★</a></span></span>
        <div style="height:0;overflow:hidden"><div data-testid="review-distribution-popover"><span>4.${i % 10} out of 5</span><span>${(1000 + 37 * i).toLocaleString('en-US')} global ratings</span></div></div></div>
        <a data-testid="review-count-link" href="/product-reviews/${asin}">(1.2K)</a></div>
      <button>Shop gadget deals</button></div>`;
  };
  function draw() {
    const list = document.getElementById('list');
    const rows = Math.ceil(loaded / COLS);
    list.style.height = rows * ROW + 'px';
    const top = list.getBoundingClientRect().top + scrollY;
    const from = Math.max(0, Math.floor((scrollY - top - innerHeight * 0.5) / ROW));
    const to = Math.min(rows - 1, Math.floor((scrollY - top + innerHeight * 1.5) / ROW));
    for (const el of [...list.children]) if (+el.dataset.row < from || +el.dataset.row > to) el.remove();
    for (let r = from; r <= to; r++) {
      if (list.querySelector(`[data-row="${r}"]`)) continue;
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.row = r;
      row.style.top = r * ROW + 'px';
      let h = '';
      for (let i = r * COLS; i < Math.min(loaded, r * COLS + COLS); i++) h += card(i);
      row.innerHTML = h;
      list.append(row);
    }
    if (paused && !document.getElementById('more')) {
      list.insertAdjacentHTML('afterend', '<div id="more" data-testid="load-more-footer" style="padding:40px;text-align:center"><button data-testid="load-more-view-more-button" type="submit">View more deals</button></div>');
      document.querySelector('[data-testid="load-more-view-more-button"]').onclick = () => {
        paused = false;
        document.getElementById('more').remove();
        loading = true;
        setTimeout(() => { loaded = Math.min(TOTAL, loaded + 16); loading = false; draw(); }, 400);
      };
    }
    if (loaded < TOTAL && !loading && !paused && scrollY + innerHeight > top + rows * ROW - 100) {
      loading = true;
      setTimeout(() => { loaded = Math.min(TOTAL, loaded + 16); loading = false; draw(); }, 500);
    }
  }
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  });
  window.__draw = draw;
  // Swap deal i for another colour of the same product, in place.
  window.__swap = (i) => {
    swapped.add(i);
    const row = document.querySelector(`#list [data-row="${Math.floor(i / COLS)}"]`);
    if (row) row.remove();
    draw();
  };
  draw();
}

const amazonPage = () => `<!doctype html><html><head><meta charset="utf-8"><title>Device Deals | Amazon</title><style>
body{margin:0;font:14px Arial,sans-serif;color:#0f1111}
#nav{height:60px;background:#131921;display:flex;align-items:center;padding:0 16px}
.hero{height:420px;background:#ffd8a8;padding:20px;box-sizing:border-box}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.row{position:absolute;left:0;right:0;height:380px;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:8px;box-sizing:border-box}
[data-testid="product-card"]{border:1px solid #ddd;border-radius:8px;padding:10px;overflow:hidden;background:#fff}
[data-testid="product-card"] img{width:165px;height:165px;display:block}
footer{height:900px;background:#232f3e;color:#fff}
</style></head><body>
<div id="nav"><input id="search" placeholder="Search Amazon"></div>
<div class="hero"><div data-testid="product-card" style="width:220px"><a data-testid="product-card-link" href="/Hero/dp/B0HERO0000"><p>HERO CAROUSEL DEAL</p></a>
  <div data-testid="price-section"><span class="sr">Deal Price: $1.00</span></div></div></div>
<div data-testid="discount-asin-grid"><div><h2>Discounts grid</h2><div><div id="list" style="position:relative"></div></div></div></div>
<footer>Footer</footer>
<script>(${amazonScript.toString()})()</script></body></html>`;

// A product page: a "similar items" product card but no deals grid. It logs
// each key it sees and whether something had already prevented it.
const AMAZON_PRODUCT_URL = 'https://www.amazon.com/Some-Gadget/dp/B0GADGET00';
const amazonProductPage = () => `<!doctype html><html><head><meta charset="utf-8"><title>Some Gadget | Amazon</title></head><body>
<div id="ppd"><h1>Some Gadget</h1></div>
<div id="similar"><div data-testid="product-card" style="width:220px;height:300px"><a data-testid="product-card-link" href="/Other/dp/B0OTHER000"><p>SIMILAR ITEM</p></a></div></div>
<div style="height:2000px"></div>
<script>window.__keys = []; addEventListener('keydown', (e) => __keys.push(e.key + ':' + e.defaultPrevented));</script></body></html>`;

const amazonSvg = (url) => {
  const m = url.match(/\/I\/([^.]+)\.(_[^.]*_)\./);
  const label = m ? `${m[1]} ${m[2]}` : 'image';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="100%" height="100%" fill="#eaeded"/><circle cx="500" cy="460" r="300" fill="#ff9900"/><text x="60" y="920" font-size="56" fill="#0f1111" font-family="sans-serif">${label}</text></svg>`;
};

// ---------- the Times' interactive gift guide ----------

// Copied from the 2026 Holiday Gift Guide's structure (inspected 2026-11-24):
// each gift a div[data-category][data-featured] in one grid (photo, h2
// tagline inside the buy link, the product's name in bold in the first
// paragraph, a byline, "Read More" on some, one "Buy for $X at Store" link,
// icon buttons), an ad after every 8, "Showing N gifts" above the grid, and
// 8 more drawn each time the end of the grid scrolls into view.
const GUIDE_URL = 'https://www.nytimes.com/interactive/2026/us/wirecutter-holiday-gift-guide.html';
const OTHER_INTERACTIVE_URL = 'https://www.nytimes.com/interactive/2026/us/test-election-map.html';
const giftName = (i) => `TestGift ${i + 1} Thing`;
const giftOut = (i) => `https://www.nytimes.com/wirecutter/out/link/${7000 + i}/1/60/2`;

// Runs in the page too (serialized with toString), so it uses nothing above.
function guideCard(i) {
  const colors = ['#c0392b', '#2c3e50', '#16a085', '#8e44ad'];
  const pic = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="751"><rect width="100%" height="100%" fill="${colors[i % 4]}"/><text x="40" y="120" font-size="90" fill="#fff" font-family="sans-serif">Gift ${i + 1}</text></svg>`);
  const out = `https://www.nytimes.com/wirecutter/out/link/${7000 + i}/1/60/2`;
  const review = i % 2 === 0 ? `<p><strong>Read More</strong> <a target="_blank" href="https://www.nytimes.com/wirecutter/reviews/test-gift-${i}/">Our review of gift ${i + 1}</a></p>` : '';
  return `<div data-featured="${i + 1}" data-category="Tech,Trending" data-item="${i}" class="g-card"><div>
    <div><div role="img"><picture><source srcset="${pic}"><img loading="lazy" alt="" width="1024" height="751" src="${pic}"></picture></div></div>
    <div><a target="_blank" href="${out}"><h2>Tagline ${i + 1}</h2></a></div>
    <div><p>A gift blurb for anyone on the list: the <strong>TestGift ${i + 1} Thing</strong> is sturdy, small and fun to unwrap.</p>
      <p>— Test Writer ${i + 1}, Staff Writer, Wirecutter</p>${review}</div>
    <p><a target="_blank" href="${out}">Buy for $${101 + i} at Store ${i + 1}</a></p>
    <div><button aria-label="Save"><svg width="22" height="22"></svg></button><button aria-label="Share"><svg width="24" height="24"></svg></button></div>
  </div></div>`;
}

function guideScript(card) {
  const TOTAL = 20, BATCH = 8;
  const grid = document.getElementById('grid');
  let drawn = 0, loading = false;
  const batch = () => {
    let html = '';
    for (const end = Math.min(drawn + BATCH, TOTAL); drawn < end; drawn++) html += card(drawn);
    grid.insertAdjacentHTML('beforeend', html + '<div class="ad"><p>SKIP ADVERTISEMENT</p><div class="slot">Advertisement</div></div>');
  };
  batch();
  // Like the real page: only a change in whether the end is in view counts.
  new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting) || loading || drawn >= TOTAL) return;
    loading = true;
    setTimeout(() => { batch(); loading = false; }, 300);
  }).observe(document.getElementById('end'));
}

const guidePage = () => `<!doctype html><html><head><meta charset="utf-8"><title>The 2026 Holiday Gift Guide - The New York Times</title><style>
body{margin:0;font:18px/1.5 Georgia,serif;color:#222}
header.site{position:sticky;top:0;height:56px;background:#fff;border-bottom:1px solid #ddd;z-index:10;font:700 20px sans-serif;padding:14px 24px;box-sizing:border-box}
main{max-width:800px;margin:0 auto;padding:24px}
.filters{display:flex;gap:8px;margin:16px 0}
#grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.g-card img{width:100%;height:340px;object-fit:cover;display:block}
.g-card h2{font:700 24px sans-serif}
.g-card button{width:24px;height:24px}
.ad{grid-column:1/-1;height:420px;background:#f4f4f4;text-align:center;font:12px sans-serif}
footer{height:1200px;background:#eee}
</style></head><body>
<header class="site">The New York Times</header>
<main><h1>Holiday Gift Guide</h1>
<div class="filters"><button>Category</button><button>Show all</button><button>Tech</button><button>Price</button><button>Sort</button></div>
<p>These items were independently chosen by editors of The New York Times and Wirecutter.</p>
<h3>Showing 20 gifts</h3>
<div id="grid"></div><div id="end"></div>
<h2>Still looking for the perfect gift?</h2><p>Tell us who you’re shopping for.</p></main>
<footer>Footer</footer>
<script>const card = ${guideCard.toString()};
(${guideScript.toString()})(card);</script></body></html>`;

// Another interactive: no gifts. It logs each key it sees and whether
// something had already prevented it.
const otherInteractivePage = () => `<!doctype html><html><head><meta charset="utf-8"><title>Election Map - The New York Times</title></head><body>
<main><h1>Test election map</h1><p>Results by county. <a href="https://www.nytimes.com/2026/11/03/us/elections.html">Full results</a></p>
<div style="height:2000px;background:#eef"></div></main>
<script>window.__keys = []; addEventListener('keydown', (e) => __keys.push(e.key + ':' + e.defaultPrevented));</script></body></html>`;

// ---------- harness ----------

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function state(page) {
  return page.evaluate(() => {
    const host = document.querySelector('deal-flash');
    if (!host) return { hud: null };
    const r = host.shadowRoot;
    const q = (s) => r.querySelector(s);
    const hud = q('.hud');
    const toast = q('.toast');
    const panel = q('.panel');
    const cardOn = !panel.hidden;
    return {
      view: host.dataset.view,
      active: host.dataset.active === '1',
      hud: hud.hidden ? null : q('.count').textContent,
      tag: q('.tag').textContent,
      index: host.dataset.active === '1' ? +host.dataset.index : -1,
      adapter: host.dataset.adapter,
      title: host.dataset.title,
      busy: host.dataset.busy === '1',
      toast: toast.hidden ? null : toast.textContent,
      star: cardOn ? !q('.cardstar').hidden : !q('.badge').hidden,
      card: cardOn
        ? {
            title: (q('.title') || {}).textContent,
            cat: (q('.cat') || {}).textContent || '',
            deck: (q('.deck') || {}).textContent || '',
            img: !!q('.media img'),
            buys: [...r.querySelectorAll('.buy')].map((b) => b.textContent),
            lede: [...r.querySelectorAll('.lede')].map((p) => p.textContent).join(' | '),
            body: [...r.querySelectorAll('.body p')].map((p) => p.textContent).join(' | '),
            text: q('.content').textContent,
            panel: panel.getBoundingClientRect().toJSON(),
          }
        : null,
    };
  });
}

// Every [data-item=i] element sits inside the spotlight; no other item's does.
async function contained(page, i) {
  return page.evaluate((i) => {
    const spot = document.querySelector('deal-flash').shadowRoot.querySelector('.spot').getBoundingClientRect();
    const inside = (r) => r.top >= spot.top - 1 && r.bottom <= spot.bottom + 1 && r.left >= spot.left - 1 && r.right <= spot.right + 1;
    const centerIn = (r) => {
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      return x > spot.left && x < spot.right && y > spot.top && y < spot.bottom;
    };
    const mine = [...document.querySelectorAll(`[data-item="${i}"]`)].map((e) => e.getBoundingClientRect());
    const others = [...document.querySelectorAll('[data-item], .promo')].filter((e) => e.dataset.item !== String(i)).map((e) => e.getBoundingClientRect());
    // Fixed and sticky bars are hidden (or still off-screen) while page view is on.
    const gone = (sel) => {
      const e = document.querySelector(sel);
      return !e || getComputedStyle(e).visibility === 'hidden' || e.getBoundingClientRect().bottom <= 0;
    };
    const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    return {
      all: mine.length > 0 && mine.every(inside),
      leak: others.some(centerIn),
      barsHidden: gone('header.site') && gone('.browse') && gone('.nl'),
      nearTop: atBottom || (spot.top >= 0 && spot.top < 60),
    };
  }, i);
}

async function key(page, k, wait = 80) {
  await page.keyboard.press(k);
  await sleep(wait);
}

async function checkPage(page, i, n, label) {
  const s = await state(page);
  const c = await contained(page, i);
  ok(s.hud === `${i + 1} / ${n}`, `${label}: HUD reads ${i + 1} / ${n} (got ${s.hud})`);
  ok(c.all && !c.leak, `${label}: spotlight holds item ${i + 1} and nothing else (all=${c.all} leak=${c.leak})`);
  ok(c.barsHidden && c.nearTop, `${label}: page bars hidden, item at the top (hidden=${c.barsHidden} top=${c.nearTop})`);
}

async function checkCard(page, i, fx, label) {
  const s = await state(page);
  const c = s.card;
  ok(s.hud === `${i + 1} / ${fx.count}` && !!c, `${label}: card view shows ${i + 1} / ${fx.count} (got ${s.hud}, card=${!!c})`);
  if (!c) return;
  const title = (fx.titles && fx.titles[i]) || `Test Product ${i + 1}`;
  ok(c.title === title, `${label}: title "${c.title}"`);
  ok(c.img === !fx.noImage, `${label}: image ${c.img ? 'shown' : 'absent'}`);
  ok(c.buys.length >= fx.buys, `${label}: ${c.buys.length} buy button(s): ${c.buys.join(' / ')}`);
  ok(/invented product blurb|Card blurb/.test(c.text), `${label}: shows the write-up`);
  ok(!/Buying options|opens in a new tab|One week to better sleep|Advertisement|Sponsored|Photo credit/.test(c.text), `${label}: no screen-reader text, promos or ads`);
  ok(!c.text.includes(`Test Product ${i + 2} `) && !c.text.includes(`item ${i + 2}.`), `${label}: nothing from the next item`);
  const big = c.panel.width >= 1280 * 0.9 || c.panel.width >= 1240;
  ok(big, `${label}: panel spans the window (${Math.round(c.panel.width)}px wide)`);
  return s;
}

async function amazonTests(browser) {
  console.log('\namazon (virtualized grid: 24 deals, then 16 more)');
  await browser.defaultBrowserContext().overridePermissions('https://www.amazon.com', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (/^https:\/\/www\.amazon\.com\/(blackfriday|events)\//.test(u)) req.respond({ status: 200, contentType: 'text/html', body: amazonPage() });
    else if (u.startsWith(AMAZON_PRODUCT_URL)) req.respond({ status: 200, contentType: 'text/html', body: amazonProductPage() });
    else if (u.startsWith('https://m.media-amazon.com/images/I/')) req.respond({ status: 200, contentType: 'image/svg+xml', body: amazonSvg(u) });
    else req.abort();
  });
  await page.goto(AMAZON_URL, { waitUntil: 'load' });
  await sleep(400);

  // A key, then however long Amazon takes to draw or load the next rows.
  const press = async (k, wait = 110) => {
    await key(page, k, wait);
    for (let t = 0; t < 90 && (await state(page)).busy; t++) await sleep(100);
  };
  const pressN = async (k, n) => { for (let i = 0; i < n; i++) await press(k); };
  const drawn = (i) => page.evaluate((i) => !!document.querySelector(`[data-item="${i}"]`), i);
  const newTabUrls = async () => (await browser.targets()).filter((t) => t.type() === 'page').map((t) => t.url());
  const closeOthers = async () => {
    for (const p of await browser.pages()) if (p !== page && p.url() !== 'about:blank') await p.close();
    await page.bringToFront();
  };

  await page.click('#search');
  await press('j');
  ok((await state(page)).hud === null, 'j inside the search field is ignored');
  await page.evaluate(() => document.activeElement.blur());

  await press('j', 200);
  if ((await state(page)).view !== 'card') await press('v', 150);
  let s = await state(page);
  const c = s.card;
  ok(c && c.title === amazonTitle(0), `first j shows the first deal, full title (got "${c && c.title}")`);
  ok(/^1 \/ \d+\+$/.test(s.hud), `HUD counts the deals read so far, with + for more to load (got ${s.hud})`);
  if (c) {
    ok(c.deck === '59% off · Black Friday Deal', `badges as the kicker ("${c.deck}")`);
    ok(/\$50\.99\s*\$20\.99 on Amazon/.test(c.buys[0]) && c.buys[0].includes('You save $30'), `price button reads "${c.buys[0]}"`);
    ok(c.lede.replace(/r$/, '') === '★ 4.0 · 1,000 ratings', `rating line "${c.lede}" (the r is its key hint)`);
    ok(!/HERO|Shop gadget deals|See options|out of 5 stars|\$ 20 \. 99/.test(c.text), 'no hero card, buttons or visual price copies');
  }
  const imgSrc = await page.evaluate(() => document.querySelector('deal-flash').shadowRoot.querySelector('.media img').src);
  ok(/\/images\/I\/test0\._AC_SL1000_\.jpg$/.test(imgSrc), `asks Amazon for the big image (${imgSrc.replace(/^.*\/I\//, '')})`);
  ok(await page.evaluate(() => !!document.querySelector('deal-flash').shadowRoot.querySelector('.lede a + kbd.key')), 'rating line links to the reviews, marked r');
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'amazon-card.png') });
  }

  // The page above the grid grows (late images), shifting every card down.
  await page.evaluate(() => { document.querySelector('.hero').style.height = '560px'; window.__draw(); });
  await pressN('j', 5);
  s = await state(page);
  ok(s.index === 5 && s.card && s.card.title === amazonTitle(5), `five j later: deal 6 after the page shifted (got ${s.index + 1}, "${s.card && s.card.title.slice(0, 12)}")`);

  // Amazon swaps another colour into a slot: deal 8 (just ahead, already
  // read) and deal 6 (the one on screen). Paging carries on from there.
  await page.evaluate(() => { window.__swap(7); window.__swap(5); });
  await sleep(100);
  await press('j');
  s = await state(page);
  ok(s.index === 6 && s.card.title === amazonTitle(6), `a swap under the current deal doesn't lose the place (deal ${s.index + 1})`);
  await press('j');
  s = await state(page);
  ok(s.index === 7 && s.card.title === amazonTitle(7) + ' (Blue)', `the swapped-in colour replaces deal 8 ("…${s.card.title.slice(-14)}")`);
  await press('k');
  await press('k');
  s = await state(page);
  ok(s.index === 5 && s.card.title === amazonTitle(5) + ' (Blue)' && /^6 \/ \d+\+$/.test(s.hud), `nothing else forgotten: deal 6 is its new colour, HUD ${s.hud}`);
  await pressN('j', 2);

  // Past the 24 loaded at first: Amazon loads more as the end nears.
  await pressN('j', 23);
  s = await state(page);
  ok(s.index === 30 && s.card && s.card.title === amazonTitle(30), `j past the first 24 loads more (deal ${s.index + 1}: "${s.card && s.card.title.slice(0, 12)}")`);
  await pressN('j', 9);
  s = await state(page);
  ok(s.index === 39 && s.card.title === amazonTitle(39), `reaches deal 40 (got ${s.index + 1})`);

  // Past the last: Amazon has no more. k while it waits stops the wait.
  await key(page, 'j', 600);
  s = await state(page);
  ok(s.busy && s.toast === 'Loading more deals…', `j at the last deal waits on Amazon (toast "${s.toast}")`);
  const tk = Date.now();
  await key(page, 'k', 150);
  s = await state(page);
  ok(!s.busy && s.index === 38 && /\+$/.test(s.hud) && Date.now() - tk < 1000, `k during the wait goes back at once (deal ${s.index + 1}, HUD ${s.hud})`);
  await press('j');
  const tj = Date.now();
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 40 deals on this page' && s.hud === '40 / 40', `then it says that's all, no + (toast "${s.toast}", HUD ${s.hud})`);
  ok(Date.now() - tj < 4500, `in under 4.5s (${Date.now() - tj}ms)`);
  const tj2 = Date.now();
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 40 deals on this page' && Date.now() - tj2 < 600, 'and says so at once after that');

  // Deal 1's card is long gone from the page; g still shows it.
  ok(!(await drawn(0)), 'Amazon has dropped deal 1 from the page');
  await press('g', 150);
  s = await state(page);
  ok(s.index === 0 && s.card && s.card.title === amazonTitle(0) && s.card.img, 'g goes back to deal 1, photo and all');

  await press('1', 600);
  ok((await newTabUrls()).includes('https://www.amazon.com/dp/B0TEST0000'), '1 opens the product page (clean /dp/ link)');
  await closeOthers();
  await press('r', 600);
  ok((await newTabUrls()).includes('https://www.amazon.com/dp/B0TEST0000#customerReviews'), 'r opens the product reviews');
  await closeOthers();

  await press('s');
  await pressN('j', 2);
  await press('s');
  await press('c', 300);
  s = await state(page);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
  ok(s.toast === 'Copied 2 starred items' && clip.includes(`- [${amazonTitle(0)}](https://www.amazon.com/dp/B0TEST0000) ($20.99)`) && clip.includes(amazonTitle(2)), 'c copies the starred deals with links and prices');

  // Page view spotlights the card where it sits, drawn or not when asked.
  await press('g', 150);
  await press('v', 300);
  let k0 = await contained(page, 0);
  ok((await state(page)).view === 'page' && k0.all && !k0.leak && k0.nearTop, `page view spotlights deal 1 (all=${k0.all} leak=${k0.leak} top=${k0.nearTop})`);
  await pressN('j', 13);
  await sleep(300);
  k0 = await contained(page, 13);
  ok((await state(page)).index === 13 && k0.all && !k0.leak, `page view j x13 spotlights deal 14 (all=${k0.all} leak=${k0.leak})`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'amazon-page.png') });
  await press('v', 150);
  await press('Escape');

  // Start halfway down a fresh page: rows above get read on the way back.
  await page.reload({ waitUntil: 'load' });
  await sleep(400);
  await page.evaluate(() => {
    const list = document.getElementById('list');
    window.scrollTo(0, list.getBoundingClientRect().top + scrollY + 4 * 380 - 30);
  });
  await sleep(300);
  ok(!(await drawn(0)), 'halfway down, the first rows are not drawn');
  await press('j', 200);
  s = await state(page);
  ok(s.title === amazonTitle(16), `j halfway down starts at the deal on screen (got "${(s.title || '').slice(0, 12)}")`);
  await pressN('k', 10);
  s = await state(page);
  ok(s.title === amazonTitle(6), `k x10 walks back into rows that weren't drawn (got "${(s.title || '').slice(0, 12)}")`);
  await pressN('k', 6);
  s = await state(page);
  ok(s.index === 0 && s.title === amazonTitle(0) && /^1 \//.test(s.hud), `back to deal 1, counted from 1 (HUD ${s.hud})`);
  await press('k');
  ok((await state(page)).toast === 'First item', 'k before the first deal says so');

  // Past a couple of hundred deals Amazon wants its "View more deals" button
  // pressed; j at the last loaded deal presses it and carries on.
  await page.goto(AMAZON_URL + '?button', { waitUntil: 'load' });
  await sleep(400);
  await press('j', 200);
  await pressN('j', 23);
  s = await state(page);
  const btn = () => page.evaluate(() => !!document.querySelector('[data-testid="load-more-view-more-button"]'));
  ok(s.title === amazonTitle(23) && (await btn()), `deal 24 is the last loaded, with Amazon's View more deals button under it (got "${(s.title || '').slice(0, 12)}")`);
  await press('j');
  s = await state(page);
  ok(s.title === amazonTitle(24) && !(await btn()), `j there presses the button and goes on to deal 25 (got "${(s.title || '').slice(0, 12)}", HUD ${s.hud})`);
  await pressN('j', 15);
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 40 deals on this page' && s.hud === '40 / 40', `then pages to the real end (toast "${s.toast}", HUD ${s.hud})`);

  // The device deals page's path, the one this started on, still works.
  await page.goto('https://www.amazon.com/events/devicedeals/?bubble-id=deals-collection-under-50', { waitUntil: 'load' });
  await sleep(400);
  await press('j', 200);
  s = await state(page);
  ok(s.title === amazonTitle(0), `the /events/ path still pages (got "${(s.title || '').slice(0, 12)}")`);

  // Elsewhere on Amazon (no deals grid) j and k are left to the page: no
  // pager, no toast, not even preventDefault.
  await page.goto(AMAZON_PRODUCT_URL, { waitUntil: 'load' });
  await sleep(400);
  await key(page, 'j', 300);
  await key(page, 'k', 300);
  const quiet = await page.evaluate(() => ({ host: !!document.querySelector('deal-flash'), keys: window.__keys.join(' ') }));
  ok(!quiet.host && quiet.keys === 'j:false k:false', `a product page gets no pager or toast and keeps j/k (host=${quiet.host} keys="${quiet.keys}")`);
  // Positive control: the script is running on that page; a grid wakes it.
  await page.evaluate(() => {
    const g = document.createElement('div');
    g.setAttribute('data-testid', 'discount-asin-grid');
    g.appendChild(document.getElementById('similar'));
    document.body.prepend(g);
  });
  await key(page, 'j', 300);
  s = await state(page);
  ok(s.active && /SIMILAR ITEM/.test(s.title || ''), `...and the same page with a deals grid answers j (title "${s.title}")`);
  await page.close();
}

async function guideTests(browser) {
  console.log('\nguide (the Times’ gift guide: 8 gifts drawn, 20 in all)');
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith(GUIDE_URL)) req.respond({ status: 200, contentType: 'text/html', body: guidePage() });
    else if (u.startsWith(OTHER_INTERACTIVE_URL)) req.respond({ status: 200, contentType: 'text/html', body: otherInteractivePage() });
    else req.abort();
  });
  await page.goto(GUIDE_URL, { waitUntil: 'load' });
  await sleep(400);

  const press = async (k, wait = 110) => {
    await key(page, k, wait);
    for (let t = 0; t < 90 && (await state(page)).busy; t++) await sleep(100);
  };
  const pressN = async (k, n) => { for (let i = 0; i < n; i++) await press(k); };
  const drawn = () => page.evaluate(() => document.querySelectorAll('[data-category]').length);
  const newTabUrls = async () => (await browser.targets()).filter((t) => t.type() === 'page').map((t) => t.url());
  const closeOthers = async () => {
    for (const p of await browser.pages()) if (p !== page && p.url() !== 'about:blank') await p.close();
    await page.bringToFront();
  };

  await press('j', 200);
  if ((await state(page)).view !== 'card') await press('v', 150);
  let s = await state(page);
  const c = s.card;
  ok(c && c.title === giftName(0) && c.deck === 'Tagline 1', `first j: the product's name as the title, the tagline above it (got "${c && c.title}" / "${c && c.deck}")`);
  ok(s.hud === '1 / 20' && (await drawn()) === 8, `HUD counts the guide's 20 while 8 are drawn (got ${s.hud})`);
  if (c) {
    ok(c.img, 'shows the photo');
    ok(c.buys.length === 1 && c.buys[0] === '1$101 at Store 1', `one buy button, "Buy for $101 at Store 1" read as price and shop (got "${c.buys.join(' / ')}")`);
    ok(!c.lede && /A gift blurb/.test(c.body) && /— Test Writer 1/.test(c.body) && /Read More/.test(c.body), `write-up, byline and Read More under the button (body "${c.body.slice(0, 60)}…")`);
    ok(!/ADVERTISEMENT|Advertisement|Tagline 1.*Tagline 1|TestGift 2|Save|Share|Showing 20/.test(c.text), 'no ads, icon buttons, count or next gift in the card');
  }
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'guide-card.png') });
  }
  await press('1', 600);
  ok((await newTabUrls()).includes(giftOut(0)), '1 opens the buy link');
  await closeOthers();
  await press('r', 600);
  ok((await newTabUrls()).includes('https://www.nytimes.com/wirecutter/reviews/test-gift-0/'), 'r opens the Read More review');
  await closeOthers();
  await press('j');
  await press('r');
  ok((await state(page)).toast === 'No “Read more” link on this item', 'r on a gift without one says so');

  // The last drawn gift, then the page's next 8.
  await pressN('j', 6);
  s = await state(page);
  ok(s.title === giftName(7) && s.hud === '8 / 20' && (await drawn()) === 8, `gift 8 is the last drawn (got "${s.title}", HUD ${s.hud})`);
  await press('j');
  s = await state(page);
  ok(s.title === giftName(8) && s.hud === '9 / 20' && (await drawn()) === 16, `j there has the page draw 8 more and goes on to gift 9 (got "${s.title}", HUD ${s.hud}, ${await drawn()} drawn)`);
  await pressN('j', 11);
  s = await state(page);
  ok(s.title === giftName(19) && s.hud === '20 / 20' && (await drawn()) === 20, `and on through the last batch to gift 20 (got "${s.title}", HUD ${s.hud})`);
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 20 gifts' && s.title === giftName(19), `j at the end says "${s.toast}"`);
  await press('k');
  ok((await state(page)).title === giftName(18), 'k goes back');
  await press('g', 150);
  ok((await state(page)).title === giftName(0), 'g goes to the first gift');

  // Page view: the spotlight holds the whole gift and the sticky header goes.
  await press('v', 200);
  await sleep(300);
  await checkPage(page, 0, 20, 'page view');
  await press('j', 200);
  await sleep(300);
  await checkPage(page, 1, 20, 'page view j');
  await press('v', 150);

  // Stars and the copied list use the product's name, link and price.
  await press('g', 150);
  await press('s');
  await pressN('j', 2);
  await press('s');
  await press('c', 300);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
  ok(clip.includes(`- [${giftName(0)}](${giftOut(0)}) ($101)`) && clip.includes(`- [${giftName(2)}](${giftOut(2)}) ($103)`), `copies a Markdown list of both ("${clip.split('\n').slice(3).join(' ')}")`);
  await press('Escape');

  // Any other interactive keeps j and k: no pager, no toast, no preventDefault.
  await page.goto(OTHER_INTERACTIVE_URL, { waitUntil: 'load' });
  await sleep(400);
  await key(page, 'j', 300);
  await key(page, 'k', 300);
  const quiet = await page.evaluate(() => ({ host: !!document.querySelector('deal-flash'), keys: window.__keys.join(' ') }));
  ok(!quiet.host && quiet.keys === 'j:false k:false', `another interactive gets no pager or toast and keeps j/k (host=${quiet.host} keys="${quiet.keys}")`);
  // Positive control: the script is running there; a gift card wakes it.
  await page.evaluate((html) => document.querySelector('main').insertAdjacentHTML('afterbegin', html), guideCard(0));
  await key(page, 'j', 300);
  s = await state(page);
  ok(s.active && s.title === giftName(0), `...and the same page with a gift card answers j (title "${s.title}")`);
  await page.close();
}

// ---------- other hosts (the generic detectors) ----------

const KEYLOG = `<script>window.__keys = []; addEventListener('keydown', (e) => __keys.push(e.key + ':' + e.defaultPrevented));</script>`;
const pic = (label, w, h, color = '#7a8b99') =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/><text x="12" y="40" font-size="28" fill="#fff" font-family="sans-serif">${label}</text></svg>`)}`;
const shell = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}<style>
body{margin:0;font:16px/1.5 Helvetica,Arial,sans-serif;color:#222}
header.site{position:sticky;top:0;height:56px;background:#fff;border-bottom:1px solid #ddd;display:flex;gap:16px;align-items:center;padding:0 24px;z-index:10}
main{max-width:1180px;margin:0 auto;padding:24px}
img{display:block;max-width:100%}
footer{height:400px;background:#eee}
</style></head><body>${body}${KEYLOG}</body></html>`;

// A shop's own category grid (invented, in the shape most shop themes use):
// same-site product links, £ prices with some struck through, "Add to
// basket" buttons, index classes on each tile, plus things that must not be
// taken for the list: the header's menu, category tiles without prices and
// a "Recently viewed" carousel that scrolls sideways.
const SHOP_URL = 'https://www.teapot-emporium.co.uk/collections/teapots';
const teapot = (i) => `Brown Betty Teapot No. ${i + 1}`;
const shopPage = () => {
  const tile = (i) => {
    const sale = i % 3 === 0;
    const price = sale ? `<del>£${30 + i}.00</del> <span class="now">£${24 + i}.00</span>` : `<span class="now">£${19 + i}.50</span>`;
    return `<li class="product-tile product-tile--${i}" data-item="${i}">
      <a class="tile-media" href="/products/brown-betty-${i + 1}"><img width="260" height="260" alt="" src="${pic(`Pot ${i + 1}`, 260, 260, '#8d5b3e')}"></a>
      <h3 class="tile-name"><a href="/products/brown-betty-${i + 1}">${teapot(i)}</a></h3>
      <div class="tile-price">${price}</div>
      <p class="tile-blurb">A round, glazed earthenware pot that pours without dribbling, number ${i + 1} in the range.</p>
      <button type="button">Add to basket</button></li>`;
  };
  const cat = (n) => `<li class="cat"><a href="/collections/${n.toLowerCase()}"><img width="200" height="140" alt="" src="${pic(n, 200, 140)}"><span>${n}</span></a></li>`;
  const rail = (j) => `<div class="rail-card" style="flex:0 0 240px"><a href="/products/rail-${j}"><img width="200" height="200" alt="" src="${pic(`R${j}`, 200, 200)}"></a>
    <a href="/products/rail-${j}">Recently viewed thing ${j}</a><span>£${9 + j}.00</span></div>`;
  return shell(
    'Teapots | Teapot Emporium',
    `<header class="site"><a href="/">Teapot Emporium</a><nav><a href="/collections/teapots">Teapots</a> <a href="/collections/cups">Cups</a> <a href="/collections/sale">Sale</a></nav><input placeholder="Search"></header>
    <main><h1>Teapots</h1>
      <ul class="cats" style="display:flex;gap:12px;list-style:none;padding:0">${['Cups', 'Cosies', 'Strainers', 'Caddies', 'Trays', 'Sale'].map(cat).join('')}</ul>
      <ul class="product-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:20px;list-style:none;padding:0">${range(12, (_, i) => tile(i))}</ul>
      <section class="recent"><h2>Recently viewed</h2><div class="rail" style="display:flex;gap:16px;overflow-x:auto">${range(10, (_, j) => rail(j))}</div></section>
    </main><footer><a href="/about">About</a> <a href="/delivery">Delivery</a></footer>`,
    '<meta property="og:site_name" content="Teapot Emporium">',
  );
};

// An editorial roundup on another site: buy links through the site's own
// /go/ redirects and an outbound link marked rel="sponsored" (its host on no
// list), euro prices, share links and an ordinary outbound link in the
// write-up that mustn't count as a buy link.
const ROUNDUP_URL = 'https://www.kitchen-roundup.example/best-electric-kettles/';
const roundupPage = () => {
  const item = (i) => `<h2 data-item="${i}">Kettle ${i + 1}</h2>
    <img data-item="${i}" width="560" height="260" alt="" src="${pic(`Kettle ${i + 1}`, 560, 260, '#4a6b8a')}">
    <p>${blurb} See <a href="https://en.wikipedia.example/wiki/Kettle">the history of kettles</a>.</p>
    <p><a class="btn" data-item="${i}" href="/go/shopfront-kettle-${i}">€${49 + i} at Shopfront</a></p>
    <p>Also at <a rel="sponsored nofollow" href="https://www.acme-housewares.example/p/kettle-${i}">Acme Housewares</a></p>`;
  return shell(
    'The Best Electric Kettles | Kitchen Roundup',
    `<header class="site">Kitchen Roundup</header><main><article style="max-width:680px">
      <h1>The best electric kettles</h1><p>${blurb} <a href="https://twitter.com/intent/tweet?url=x">Share</a> <a href="https://www.facebook.com/sharer?u=x">Share</a></p>
      ${range(6, (_, i) => item(i))}
      <h2>How we tested</h2><p>${blurb} <a href="/2025/how-we-test/">How we test</a>.</p></article></main><footer></footer>`,
  );
};

// A grid that grows by "Load more", with the count above it ("Showing 1–8
// of 20 products") and prices written the continental way ("29,99 €").
const LOADMORE_URL = 'https://www.lampenladen.example/leuchten/';
function loadMoreScript() {
  const TOTAL = 20;
  let shown = 0;
  const card = (i) => `<div class="card" data-item="${i}"><a href="/p/lamp-${i}"><img width="240" height="200" alt="" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200"><rect width="100%" height="100%" fill="#c9a227"/></svg>`)}"></a>
    <a class="name" href="/p/lamp-${i}">Desk Lamp ${i + 1}</a><div class="price"><s>39,99 €</s> <b>29,99 €</b></div><button type="button">Add to bag</button></div>`;
  const grid = document.getElementById('grid');
  const add = () => {
    let h = '';
    for (const end = Math.min(TOTAL, shown + 8); shown < end; shown++) h += card(shown);
    grid.insertAdjacentHTML('beforeend', h);
    document.getElementById('count').textContent = `Showing 1–${shown} of ${TOTAL} products`;
    if (shown >= TOTAL) document.getElementById('more').remove();
  };
  add();
  document.querySelector('#more button').onclick = () => setTimeout(add, 300);
}
const loadMorePage = () =>
  shell(
    'Leuchten | Lampenladen',
    `<header class="site">Lampenladen</header><main><h1>Desk lamps</h1><p id="count"></p>
    <div id="grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:20px"></div>
    <div id="more" style="text-align:center;padding:30px"><button type="button">Load more</button></div></main><footer></footer>
    <script>(${loadMoreScript.toString()})()</script>`,
  );

// Search results that append 6 more each time the end scrolls into view,
// under "Showing 18 results", with "USD 120" prices.
const INFINITE_URL = 'https://www.gearfinder.example/search?q=tent';
function infiniteScript() {
  const TOTAL = 18;
  let shown = 0;
  let loading = false;
  const row = (i) => `<article class="result" data-item="${i}" style="display:flex;gap:20px;height:260px;border-bottom:1px solid #ddd;padding:12px 0">
    <a href="/item/tent-${i}"><img width="220" height="200" alt="" src="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="200"><rect width="100%" height="100%" fill="#3b7a57"/></svg>`)}"></a>
    <div><h2><a href="/item/tent-${i}">Trail Tent ${i + 1}</a></h2><span class="price">USD ${120 + i}</span><p>A two-person tent, number ${i + 1}.</p><button type="button">Add to cart</button></div></article>`;
  const add = () => {
    let h = '';
    for (const end = Math.min(TOTAL, shown + 6); shown < end; shown++) h += row(shown);
    document.getElementById('results').insertAdjacentHTML('beforeend', h);
  };
  add();
  new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting) || loading || shown >= TOTAL) return;
    loading = true;
    setTimeout(() => { add(); loading = false; }, 300);
  }).observe(document.getElementById('sentinel'));
}
const infinitePage = () =>
  shell(
    'tent - Gear Finder',
    `<header class="site">Gear Finder</header><main><h1>Results for “tent”</h1><p class="summary">Showing 18 results</p>
    <div id="results"></div><div id="sentinel"></div></main><footer></footer>
    <script>(${infiniteScript.toString()})()</script>`,
  );

// A grid with no visible prices or buttons, whose only commerce signal is
// the JSON-LD ItemList of Products the page carries (?plain: without it).
const BOOKS_URL = 'https://www.bookbarn.example/staff-picks/';
const booksPage = (plain) => {
  const book = (i) => `<div class="book" data-item="${i}"><a href="/books/${i + 1}"><img width="160" height="240" alt="" src="${pic(`Book ${i + 1}`, 160, 240, '#6b3e75')}"></a>
    <a class="t" href="/books/${i + 1}">Staff Pick Novel ${i + 1}</a><p>by Author ${i + 1}</p></div>`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: Array.from({ length: 6 }, (_, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'Product', name: `Staff Pick Novel ${i + 1}`, url: `https://www.bookbarn.example/books/${i + 1}`, offers: { '@type': 'Offer', price: `${15 + i}.00`, priceCurrency: 'CAD' } },
    })),
  };
  return shell(
    'Staff picks | Book Barn',
    `<header class="site">Book Barn</header><main><h1>Staff picks</h1><div class="shelf" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${range(6, (_, i) => book(i))}</div></main><footer></footer>`,
    plain ? '' : `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
  );
};

// An ordinary news article: menus, inline outbound links, a "More stories"
// list with photos. No commerce anywhere, so j and k stay the page's.
const ARTICLE_URL = 'https://www.dailynews.example/2026/11/24/city/park-reopens.html';
const articlePage = () =>
  shell(
    'The Old Park Reopens - Daily News',
    `<header class="site"><nav><a href="/">Home</a> <a href="/city">City</a> <a href="/sports">Sports</a></nav></header>
    <main><article style="max-width:680px"><h1>The old park reopens</h1>
    ${range(4, (_, i) => `<h2>Part ${i + 1}</h2><p>${blurb} <a href="https://www.cityparks.example/plan-${i}">the plan</a>. ${blurb}</p>`)}
    <aside class="more"><h2>More stories</h2><ul style="display:grid;grid-template-columns:1fr 1fr;gap:16px;list-style:none;padding:0">
    ${range(6, (_, i) => `<li><a href="/2026/11/2${i}/story-${i}.html"><img width="300" height="180" alt="" src="${pic(`Story ${i}`, 300, 180)}"><h3>Another story ${i + 1}</h3></a><p>A short summary of story ${i + 1}.</p></li>`)}
    </ul></aside></article></main><footer><a href="/about">About</a></footer>`,
  );

// Evaluate in the extension's isolated world (where window.__df lives), as
// the popup's chrome.scripting.executeScript would.
async function inExtension(page, expression) {
  const client = await page.target().createCDPSession();
  const contexts = [];
  client.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await client.send('Runtime.enable');
  await sleep(50);
  const { frameTree } = await client.send('Page.getFrameTree');
  const ctx = contexts.filter((c) => c.auxData && c.auxData.frameId === frameTree.frame.id && /^chrome-extension:\/\//.test(c.origin)).pop();
  try {
    if (!ctx) throw new Error('no extension context in the page');
    const r = await client.send('Runtime.evaluate', { expression, contextId: ctx.id, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await client.detach().catch(() => {});
  }
}

const ROUTES = {
  [SHOP_URL]: shopPage,
  [ROUNDUP_URL]: roundupPage,
  [LOADMORE_URL]: loadMorePage,
  [INFINITE_URL]: infinitePage,
  [BOOKS_URL + '?plain']: () => booksPage(true),
  [BOOKS_URL]: () => booksPage(false),
  [ARTICLE_URL]: articlePage,
  [AMAZON_URL]: () => amazonPage().replace(/data-testid="/g, 'data-testid="x-'),
  [`${BASE}nocob/`]: () => fixtures.wirecutter().html.replace(/global-cob/g, 'cob-3f9a'),
};

async function openAt(browser, url) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    const hit = Object.keys(ROUTES)
      .filter((p) => u.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) req.respond({ status: 200, contentType: 'text/html', body: ROUTES[hit]() });
    else if (u.startsWith('https://m.media-amazon.com/images/I/')) req.respond({ status: 200, contentType: 'image/svg+xml', body: amazonSvg(u) });
    else req.abort();
  });
  await page.goto(url, { waitUntil: 'load' });
  await sleep(400);
  const press = async (k, wait = 110) => {
    await key(page, k, wait);
    for (let t = 0; t < 90 && (await state(page)).busy; t++) await sleep(100);
  };
  const pressN = async (k, n) => { for (let i = 0; i < n; i++) await press(k); };
  return { page, press, pressN };
}

const newTabs = async (browser) => (await browser.targets()).filter((t) => t.type() === 'page').map((t) => t.url());
async function closeOthers(browser, page) {
  for (const p of await browser.pages()) if (p !== page && p.url() !== 'about:blank') await p.close();
  await page.bringToFront();
}
const keysOf = (page) => page.evaluate(() => ({ host: !!document.querySelector('deal-flash'), keys: window.__keys.join(' ') }));

async function shopTests(browser) {
  console.log('\nshop (a shop’s own grid on another host: same-site links, £ prices)');
  const { page, press, pressN } = await openAt(browser, SHOP_URL);
  await press('j', 200);
  if ((await state(page)).view !== 'card') await press('v', 150);
  let s = await state(page);
  const c = s.card;
  ok(s.adapter === 'generic' && s.hud === '1 / 12', `the product grid, not the menu, categories or carousel (adapter ${s.adapter}, HUD ${s.hud})`);
  ok(c && c.title === teapot(0) && c.img, `title from the tile's heading, with its photo (got "${c && c.title}")`);
  if (c) {
    ok(c.buys.length === 1 && /£30\.00\s*£24\.00 at Teapot Emporium/.test(c.buys[0]) && c.buys[0].includes('You save £6 (20%)'), `one button to the product page with both prices and the saving (got "${c.buys.join(' / ')}")`);
    ok(/round, glazed earthenware pot/.test(c.lede) && !/Add to basket|Recently viewed/.test(c.text), 'the blurb, no buttons or carousel');
  }
  await press('j');
  s = await state(page);
  ok(s.card && /£20\.50 at Teapot Emporium/.test(s.card.buys[0]) && !/You save/.test(s.card.buys[0]), `an unreduced tile: one price, no saving ("${s.card && s.card.buys[0]}")`);
  await press('1', 600);
  ok((await newTabs(browser)).includes('https://www.teapot-emporium.co.uk/products/brown-betty-2'), '1 opens the product page');
  await closeOthers(browser, page);
  await press('r');
  ok((await state(page)).toast === 'No “Read more” link on this item', 'r with no review link says so');
  await press('G', 150);
  s = await state(page);
  ok(s.index === 11 && s.title === teapot(11) && s.hud === '12 / 12', `G: the last tile (HUD ${s.hud})`);
  await press('j');
  ok((await state(page)).toast === 'Last item', 'j past the end: "Last item" (no sign of more)');
  const t0 = Date.now();
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 12 items' && s.index === 11 && Date.now() - t0 < 4000, `a second j looks for more, briefly, then says "${s.toast}" (${Date.now() - t0}ms)`);
  await press('v', 300);
  const k = await contained(page, 11);
  ok((await state(page)).view === 'page' && k.all && !k.leak, `page view spotlights the tile (all=${k.all} leak=${k.leak})`);
  await press('v', 150);
  await press('Escape');
  await page.close();
}

async function roundupTests(browser) {
  console.log('\nroundup (another site’s editorial list: /go/ redirects, rel=sponsored)');
  const { page, press } = await openAt(browser, ROUNDUP_URL);
  await press('j', 200);
  let s = await state(page);
  const c = s.card;
  ok(s.adapter === 'generic' && s.hud === '1 / 6', `six kettles (adapter ${s.adapter}, HUD ${s.hud})`);
  ok(c && c.title === 'Kettle 1' && c.img, `title "${c && c.title}" with its photo`);
  if (c) {
    ok(c.buys.length === 2 && /€49 at Shopfront/.test(c.buys[0]) && /Acme Housewares/.test(c.buys[1]), `the /go/ link and the sponsored link are the buy buttons, nothing else (got "${c.buys.join(' / ')}")`);
    ok(/history of kettles/.test(c.body + c.lede) && !/Share|How we test/.test(c.text), 'the write-up keeps its ordinary link; no share links or methodology');
  }
  await press('2', 600);
  ok((await newTabs(browser)).includes('https://www.acme-housewares.example/p/kettle-0'), '2 opens the sponsored shop link');
  await closeOthers(browser, page);
  await press('G', 150);
  await press('j');
  s = await state(page);
  ok(s.index === 5 && s.toast === 'Last item', `G then j: "Last item" on kettle 6 (toast "${s.toast}")`);
  await press('Escape');
  await page.close();
}

async function loadMoreTests(browser) {
  console.log('\nloadmore (a "Load more" button, "Showing 1–8 of 20 products", "29,99 €")');
  const { page, press, pressN } = await openAt(browser, LOADMORE_URL);
  await press('j', 200);
  let s = await state(page);
  ok(s.hud === '1 / 20' && s.card && s.card.title === 'Desk Lamp 1', `HUD counts the page's 20 while 8 are drawn (HUD ${s.hud}, "${s.card && s.card.title}")`);
  ok(s.card && /39,99 €\s*29,99 €/.test(s.card.buys[0]) && s.card.buys[0].includes('You save 10 € (25%)'), `continental prices and saving ("${s.card && s.card.buys[0]}")`);
  await pressN('j', 7);
  s = await state(page);
  ok(s.title === 'Desk Lamp 8', `lamp 8 is the last drawn (got "${s.title}")`);
  // j there presses Load more and waits; k during the wait goes back at once.
  await key(page, 'j', 60);
  const waiting = (await state(page)).busy;
  const tk = Date.now();
  await key(page, 'k', 150);
  s = await state(page);
  ok(waiting && !s.busy && s.title === 'Desk Lamp 7' && Date.now() - tk < 1000, `k during the wait for more goes back at once (waited=${waiting}, "${s.title}")`);
  await sleep(500);
  await press('j');
  await press('j');
  s = await state(page);
  const drawn = () => page.evaluate(() => document.querySelectorAll('.card').length);
  ok(s.title === 'Desk Lamp 9' && s.hud === '9 / 20' && (await drawn()) === 16, `j there presses Load more and goes on (got "${s.title}", HUD ${s.hud}, ${await drawn()} drawn)`);
  await pressN('j', 11);
  s = await state(page);
  ok(s.title === 'Desk Lamp 20' && s.hud === '20 / 20', `on to lamp 20 (HUD ${s.hud})`);
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 20 products', `then "${s.toast}"`);
  await press('Escape');
  await page.close();
}

async function infiniteTests(browser) {
  console.log('\ninfinite (results appended on scroll, "Showing 18 results", "USD 120")');
  const { page, press, pressN } = await openAt(browser, INFINITE_URL);
  await press('j', 200);
  let s = await state(page);
  ok(s.hud === '1 / 18' && s.card && s.card.title === 'Trail Tent 1', `HUD counts the page's 18 (HUD ${s.hud}, "${s.card && s.card.title}")`);
  ok(s.card && /USD 120 at gearfinder\.example/.test(s.card.buys[0]), `code-prefixed price ("${s.card && s.card.buys[0]}")`);
  await pressN('j', 17);
  s = await state(page);
  ok(s.title === 'Trail Tent 18' && s.hud === '18 / 18', `paging past what's drawn has the page append more, through to 18 (got "${s.title}", HUD ${s.hud})`);
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 18 results', `then "${s.toast}"`);
  await press('Escape');
  await page.close();
}

async function jsonLdTests(browser) {
  console.log('\njsonld (a grid whose only commerce signal is JSON-LD)');
  let { page, press } = await openAt(browser, BOOKS_URL);
  await press('j', 200);
  let s = await state(page);
  ok(s.hud === '1 / 6' && s.card && s.card.title === 'Staff Pick Novel 1', `found through the JSON-LD ItemList (HUD ${s.hud}, "${s.card && s.card.title}")`);
  ok(s.card && /CA\$15 at bookbarn\.example/.test(s.card.buys[0]), `the offer's price fills the button ("${s.card && s.card.buys[0]}")`);
  await page.close();
  ({ page, press } = await openAt(browser, BOOKS_URL + '?plain'));
  await key(page, 'j', 300);
  await key(page, 'k', 300);
  const q = await keysOf(page);
  ok(!q.host && q.keys === 'j:false k:false', `the same grid without it is left alone (host=${q.host} keys="${q.keys}")`);
  await page.close();
}

async function amazonRenamedTests(browser) {
  console.log('\namazon-renamed (Amazon’s grid with every data-testid renamed)');
  let { page, press, pressN } = await openAt(browser, AMAZON_URL);
  await press('j', 200);
  if ((await state(page)).view !== 'card') await press('v', 150);
  let s = await state(page);
  const c = s.card;
  ok(s.adapter === 'generic-virtual' && /^1 \/ \d+\+$/.test(s.hud), `pages as a generic virtualized grid (adapter ${s.adapter}, HUD ${s.hud})`);
  ok(c && c.title === amazonTitle(0) && c.img, `first deal, full title from the screen-reader text (got "${c && c.title}")`);
  if (c) {
    ok(/\$50\.99\s*\$20\.99 at amazon\.com/.test(c.buys[0]) && c.buys[0].includes('You save $30 (59%)'), `price button reads "${c.buys[0]}"`);
    ok(!/HERO|\$ 20 \. 99/.test(c.text), 'no hero card, no visual price copies');
  }
  await pressN('j', 39);
  s = await state(page);
  ok(s.index === 39 && s.title === amazonTitle(39), `on through Amazon's loads to deal 40 (got ${s.index + 1})`);
  await press('j');
  s = await state(page);
  ok(s.toast === 'That’s all 40 items' && s.hud === '40 / 40', `then that's all (toast "${s.toast}", HUD ${s.hud})`);
  const drawn0 = await page.evaluate(() => !!document.querySelector('[data-item="0"]'));
  await press('g', 150);
  s = await state(page);
  ok(!drawn0 && s.index === 0 && s.title === amazonTitle(0), 'g goes back to deal 1, which the page had dropped');
  await press('r', 600);
  ok((await newTabs(browser)).includes('https://www.amazon.com/product-reviews/B0TEST0000'), 'r opens the reviews link');
  await closeOthers(browser, page);
  await page.close();
  ({ page, press, pressN } = await openAt(browser, AMAZON_URL + '?button'));
  await press('j', 200);
  await pressN('j', 24);
  s = await state(page);
  const btn = await page.evaluate(() => !!document.querySelector('[data-testid="x-load-more-view-more-button"]'));
  ok(s.title === amazonTitle(24) && !btn, `the renamed "View more deals" button is found by its text and pressed (got "${(s.title || '').slice(0, 12)}")`);
  await page.close();
}

async function noCobTests(browser) {
  console.log('\nwirecutter-nocob (the Wirecutter layout with .global-cob renamed)');
  const { page, press } = await openAt(browser, `${BASE}nocob/`);
  await press('j', 200);
  if ((await state(page)).view !== 'card') await press('v', 150);
  let s = await state(page);
  const c = s.card;
  const n = +((s.hud || '').split(' / ')[1] || 0);
  ok(s.adapter === 'generic' && n >= 7, `falls through to the generic detectors (adapter ${s.adapter}, HUD ${s.hud})`);
  ok(c && c.title === 'Test Product 1' && c.img, `first product, with its photo (got "${c && c.title}")`);
  if (c) {
    ok(c.buys.length >= 2 && /\$190\s*\$144 from Amazon/.test(c.buys[0]), `its buy buttons (got "${c.buys.join(' / ')}")`);
    ok(/Card blurb|invented product blurb/.test(c.text) && !/Buying options|One week to better sleep/.test(c.text), 'the write-up, no screen-reader text or promos');
  }
  await press('j');
  s = await state(page);
  ok(s.title === 'Test Product 2', `j: the next product (got "${s.title}")`);
  await press('Escape');
  await page.close();
}

async function articleTests(browser) {
  console.log('\narticle (an ordinary news page)');
  const { page } = await openAt(browser, ARTICLE_URL);
  await key(page, 'j', 300);
  await key(page, 'k', 300);
  let q = await keysOf(page);
  ok(!q.host && q.keys === 'j:false k:false', `j and k reach the page untouched, no toast (host=${q.host} keys="${q.keys}")`);
  const quiet = await inExtension(page, 'window.__df.start()');
  q = await keysOf(page);
  ok(quiet === false && !q.host, `start() without explicit says nothing (returned ${quiet})`);
  const r = await inExtension(page, 'window.__df.start({ explicit: true })');
  const s = await state(page);
  ok(r === false && s.toast === 'Deal Flash: no items found on this page' && !s.active, `start({ explicit: true }) says no items were found (returned ${r}, toast "${s.toast}")`);
  await key(page, 'j', 300);
  q = await keysOf(page);
  ok(q.keys === 'j:false k:false j:false', `and j still reaches the page afterwards (keys "${q.keys}")`);
  await page.close();
}

async function startTests(browser) {
  console.log('\nstart (window.__df.start on a page with items, and re-injection)');
  const { page, press } = await openAt(browser, SHOP_URL);
  await page.evaluate(() => {
    const el = document.querySelector('[data-item="4"]');
    window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 100);
  });
  await sleep(300);
  const r = await inExtension(page, 'window.__df.start({ explicit: true })');
  await sleep(150);
  let s = await state(page);
  ok(r === true && s.active && s.index === 4 && s.title === teapot(4), `start({ explicit: true }) turns the pager on at the item in view (returned ${r}, item ${s.index + 1})`);
  const again = await inExtension(page, 'window.__df.start({ explicit: true })');
  s = await state(page);
  ok(again === true && s.index === 4, 'starting again while on keeps the place');
  await press('j');
  ok((await state(page)).index === 5, 'j goes on from there');
  // Injecting pager.js again (as the toolbar button does on a page without
  // it) replaces the old copy: one UI, one key listener.
  await inExtension(page, fs.readFileSync(path.join(SRC, 'pager.js'), 'utf8'));
  const hosts = await page.evaluate(() => document.querySelectorAll('deal-flash').length);
  ok(hosts === 0, `re-injection tears the old copy's UI down (${hosts} left)`);
  await press('j', 200);
  const i0 = (await state(page)).index;
  await press('j');
  s = await state(page);
  ok(s.active && s.index === i0 + 1 && (await page.evaluate(() => document.querySelectorAll('deal-flash').length)) === 1, `the new copy answers j once per press (${i0 + 1} -> ${s.index + 1})`);
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [EXT],
    args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });
  await browser.defaultBrowserContext().overridePermissions('https://www.nytimes.com', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

  for (const [name, make] of Object.entries(fixtures)) {
    if (ONLY && name !== ONLY) continue;
    const fx = make();
    const n = fx.count;
    console.log(`\n${name} (${n} items)`);
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith(BASE)) req.respond({ status: 200, contentType: 'text/html', body: fx.html });
      else req.abort();
    });
    await page.goto(`${BASE}${name}/`, { waitUntil: 'load' });
    await sleep(400);

    // Typing in a field must not trigger the pager.
    await page.click('header.site input');
    await key(page, 'j');
    ok((await state(page)).hud === null, 'j inside the search field is ignored');
    await page.evaluate(() => document.activeElement.blur());

    // ----- card view -----
    await key(page, 'j', 150);
    if ((await state(page)).view !== 'card') await key(page, 'v', 150);
    let s = await checkCard(page, 0, fx, 'first j');
    if (s && fx.category) ok(s.card.cat === fx.category, `category kicker "${s.card.cat}"`);
    if (s && fx.deck) ok(s.card.deck === 'Tagline for item 1', `tagline "${s.card.deck}"`);
    if (name === 'wirecutter' && s) {
      ok(/\$190\s*\$144 from Amazon/.test(s.card.buys[0]) && s.card.buys[0].includes('You save $46 (24%)'), `price button reads "${s.card.buys[0]}"`);
      ok(s.card.lede.includes('Card blurb') && !/You save/.test(s.card.lede + s.card.body), 'blurb above the buttons, "You save" only on them');
      ok(/Description of item 1/.test(s.card.body) && /Read more: The Best Test Thing/.test(s.card.body), 'description and Read more below the buttons');
    }
    if (SHOTS && name === 'wirecutter') {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, 'card-1280.png') });
    }
    await key(page, 'j', 150);
    s = await checkCard(page, 1, fx, 'second j');
    if (name === 'wirecutter' && s) ok(s.card.buys.length === 3 && s.card.buys[2].includes('Target'), `two-product card has all 3 buttons`);
    if (SHOTS && name === 'wirecutter') await page.screenshot({ path: path.join(SHOTS, 'card-1280-double.png') });

    const y0 = await page.evaluate(() => scrollY);
    await key(page, ' ', 300);
    ok((await page.evaluate(() => scrollY)) === y0, 'space scrolls the card, not the page behind');

    await key(page, 'G', 150);
    await checkCard(page, n - 1, fx, 'G');
    await key(page, 'g', 150);
    await checkCard(page, 0, fx, 'g');

    // 1 opens the first buy button in a new tab (it fails to load: no DNS).
    const expected = await page.evaluate(() => document.querySelector('a[data-item="0"]').href);
    const before = (await browser.targets()).length;
    await key(page, '1', 600);
    const opened = (await browser.targets()).filter((t) => t.type() === 'page').map((t) => t.url());
    ok((await browser.targets()).length > before && opened.some((u) => u.includes(new URL(expected).pathname)), `1 opens ${expected}`);
    for (const p of await browser.pages()) if (p !== page && p.url() !== 'about:blank') await p.close();
    await page.bringToFront();

    // r goes to the item's "Read more" review in a new tab.
    if (name === 'wirecutter') {
      ok(await page.evaluate(() => !!document.querySelector('deal-flash').shadowRoot.querySelector('.body a + kbd.key')), 'card marks the Read more link with an r hint');
      await key(page, 'r', 600);
      const urls = (await browser.targets()).filter((t) => t.type() === 'page').map((t) => t.url());
      ok(urls.some((u) => u.endsWith('/wirecutter/reviews/test-0/')), 'r opens the Read more review');
      for (const p of await browser.pages()) if (p !== page && p.url() !== 'about:blank') await p.close();
      await page.bringToFront();
    } else {
      await key(page, 'r');
      const t = (await state(page)).toast;
      ok(t === 'No “Read more” link on this item', `r without a Read more link says so (toast "${t}")`);
    }

    // Stars, starred-only paging, copy.
    await key(page, 's');
    s = await state(page);
    ok(s.star && s.toast === '★ Starred', 's stars the item');
    await key(page, 'j');
    await key(page, 'j');
    await key(page, 's');
    await key(page, 'f');
    s = await state(page);
    ok(s.tag.includes('★ only') && s.tag.includes('★ 2'), `f turns on starred-only (tag "${s.tag}")`);
    await key(page, 'k');
    ok((await state(page)).index === 0, 'k in starred-only skips back to item 1');
    await key(page, 'j');
    ok((await state(page)).index === 2, 'j in starred-only skips to item 3');
    await key(page, 'f');
    await key(page, 'c', 300);
    s = await state(page);
    ok(s.toast === 'Copied 2 starred items', `c copies (toast "${s.toast}")`);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e.message));
    ok(/- \[Test Product 1\]\(https?:\/\/[^)]+\)/.test(clip) && clip.includes('Test Product 3'), 'clipboard holds a Markdown list of both');

    // Clicking outside the card closes it.
    await page.mouse.click(8, 450);
    await sleep(100);
    ok((await state(page)).hud === null, 'clicking the backdrop turns the pager off');

    // ----- page view -----
    await page.evaluate(() => scrollTo(0, 0));
    await sleep(100);
    const settle = name === 'wirecutter' ? 700 : 120;
    await key(page, 'j', 150);
    await key(page, 'v', settle);
    ok((await state(page)).view === 'page', 'v switches to page view');
    await checkPage(page, 0, n, 'page view');
    await key(page, 'j', settle);
    await checkPage(page, 1, n, 'page j');
    if (SHOTS && (name === 'wirecutter' || name === 'cards' || name === 'flatAbove')) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `page-${name}.png`) });
    }
    await key(page, 'k', settle);
    await checkPage(page, 0, n, 'page k');
    await key(page, 'G', settle);
    await checkPage(page, n - 1, n, 'page G');
    await key(page, 'j');
    ok((await state(page)).toast === 'Last item', 'j past the end says "Last item"');
    await key(page, 'g', settle);
    await checkPage(page, 0, n, 'page g');

    await key(page, 'Escape');
    ok((await state(page)).hud === null, 'Esc turns the pager off');
    ok(await page.evaluate(() => getComputedStyle(document.querySelector('header.site')).visibility === 'visible'), 'Esc brings the page bars back');

    // Resume from wherever the reader scrolled to.
    const mid = Math.floor(n / 2);
    await page.evaluate((i) => {
      const el = document.querySelector(`[data-item="${i}"]`);
      window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 140);
    }, mid);
    await sleep(300);
    await key(page, 'j', 150);
    s = await state(page);
    ok(Math.abs(s.index - mid) <= 1, `j after scrolling resumes near item ${mid + 1} (got ${s.index + 1})`);
    await key(page, 'v', 150); // back to card view; the choice is remembered

    // Stars and the view choice survive a reload.
    await page.reload({ waitUntil: 'load' });
    await sleep(400);
    await key(page, 'j', 250);
    await key(page, 'g', 150);
    s = await state(page);
    ok(s.index === 0 && s.star && s.view === 'card', 'stars and view persist across reloads');
    await page.close();
  }

  // Narrow window: the card goes single-column and still fits.
  if (!ONLY || ONLY === 'wirecutter') {
    const fx = fixtures.wirecutter();
    const page = await browser.newPage();
    await page.setViewport({ width: 700, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', (req) => (req.url().startsWith(BASE) ? req.respond({ status: 200, contentType: 'text/html', body: fx.html }) : req.abort()));
    await page.goto(`${BASE}wirecutter/`, { waitUntil: 'load' });
    await sleep(400);
    await key(page, 'j', 200);
    const s = await state(page);
    console.log('\nnarrow window');
    ok(s.card && s.card.panel.width >= 650 && s.card.panel.width <= 700, `card fills a 700px window (${s.card && Math.round(s.card.panel.width)}px)`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'card-700.png') });
    await page.close();
  }

  if (!ONLY || ONLY === 'amazon') await amazonTests(browser);
  if (!ONLY || ONLY === 'guide') await guideTests(browser);
  const more = { shop: shopTests, roundup: roundupTests, loadmore: loadMoreTests, infinite: infiniteTests, jsonld: jsonLdTests, 'amazon-renamed': amazonRenamedTests, 'wirecutter-nocob': noCobTests, article: articleTests, start: startTests };
  for (const [name, run] of Object.entries(more)) if (!ONLY || ONLY === name) await run(browser);

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
