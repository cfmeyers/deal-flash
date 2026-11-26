// Deal Flash: page through a long list of products (deal posts, gift guides,
// shop grids, search results) one item at a time.
//
// j / k        next / previous item (the first press turns the pager on)
// g / G        first / last item
// 1-9          open that buy button in a background tab (o = 1, O = 1 and switch)
// r / R        go to the item's full review in a new tab (R: background):
//              a "Read more" review link, or the product's reviews
// s            star the item (a gift idea); f shows starred items only
// c            copy the starred items as a Markdown list
// v            switch between card view and page view
// ?            show the keys;  Esc  turn the pager off
//
// Card view (where every page starts) lifts the item into a large panel with
// big type. Page view spotlights the item where it sits on the page, until
// the page is left.
//
// Finding items: a list of adapters (see ADAPTERS), asked in order. Each one
// that matches the page is asked for items, and the first that finds any
// wins; one that matches but finds nothing (say, a site renamed the markup it
// knows) hands over to the next, so the generic detectors at the end are the
// floor, not a separate mode:
//   1. amazon        Amazon's virtualized deals grid (data-testid attributes).
//   2. gift-guide    The Times' interactive gift guide (div[data-category][data-featured]).
//   3. wirecutter    Wirecutter's callout cards (.global-cob, a global class
//                    name, not a build-hashed one), each with the tagline
//                    heading just above it and the paragraphs just below it.
//   4. generic-virtual  A repeated-card grid (see findGrid) whose cards are
//                    absolutely positioned, read once each and kept, as Amazon's.
//   5. generic       The better of: the repeated-card grid; headings whose
//                    stretch of the page holds a buy link; the smallest block
//                    holding both a buy link and an image, or a list item
//                    holding a buy link.
// Without an explicit start (window.__df.start), j and k on a page where
// nothing is found are left to the page: no toast, no preventDefault.
(() => {
  if (window.__dfTeardown) window.__dfTeardown();

  // ---------- helpers ----------

  const RETAILERS = /(^|\.)(amazon|amzn|target|walmart|bestbuy|homedepot|lowes|wayfair|costco|rei|ebay|etsy|apple|nordstrom|macys|kohls|zappos|backcountry|dickssportinggoods|bhphotovideo|newegg|williams-sonoma|crateandbarrel|potterybarn|westelm|surlatable|uncommongoods|food52|samsclub|staples|chewy|sephora|ulta|anthropologie|llbean|patagonia|nike|adidas|bookshop|barnesandnoble|lego|kitchenaid|ikea|containerstore|madewell|jcrew|everlane|abt|adorama|dell|lenovo|samsung|sonos|argos|johnlewis|currys|boots|very|ao|tesco|sainsburys|marksandspencer|otto|zalando|mediamarkt|fnac|bol|cdiscount|rakuten|aliexpress|temu|shein|asos|uniqlo|hm|zara|gap|oldnavy|sweetwater|guitarcenter|bloomingdales|saksfifthavenue|neimanmarcus|ssense|mrporter|netaporter|farfetch|huckberry|bonobos|allbirds|warbyparker|brooklinen|parachutehome|article|burrow|castlery|westernmountaineering|moosejaw|campsaver|garagegrown|bnhphotovideo)\./i;
  // Links that never sell anything: sharing, social and search. "The site
  // itself" is worked out from location (SITE), not listed here.
  const NOT_SHOPS = ['facebook.com', 'fb.com', 'twitter.com', 'x.com', 't.co', 'pinterest.com', 'pin.it', 'instagram.com', 'threads.net', 'reddit.com', 'linkedin.com', 'youtube.com', 'youtu.be', 'google.com', 'tiktok.com', 'whatsapp.com', 'wa.me', 'bsky.app', 'tumblr.com', 'flipboard.com', 'mastodon.social', 'telegram.me', 't.me'];
  // Affiliate networks and link shorteners shops are reached through.
  const AFFILIATE_HOSTS = ['amzn.to', 'a.co', 'howl.me', 'howl.link', 'skimresources.com', 'redirectingat.com', 'viglink.com', 'linksynergy.com', 'shareasale.com', 'avantlink.com', 'awin1.com', 'anrdoezrs.net', 'jdoqocy.com', 'tkqlhce.com', 'dpbolvw.net', 'kqzyfj.com', 'emjcd.com', 'pjtra.com', 'pntra.com', 'pjatr.com', 'gopjn.com', 'sjv.io', 'pxf.io', 'ojrq.net', 'evyy.net', '7eer.net', 'ztk5.net', 'prf.hn', 'tradedoubler.com', 'webgains.com', 'rstyle.me', 'shopstyle.it', 'liketk.it', 'shop-links.co', 'bam-x.com', 'fave.co', 'geni.us', 'ebay.us', 'go2cloud.org', 'narrativ.com', 'dealspotr.com'];
  // An affiliate or tracking redirect on the site itself: "/wirecutter/out/…",
  // "/go/acme", "/link/…", or a redirect parameter carrying the shop's URL.
  const REDIRECT_PATH = /\/(?:out|go|goto|link|links|redirect|redir|click|clk|outbound|exit|visit|recommends|aff|affiliate|track)(?:\/|$)/i;
  const REDIRECT_PARAM = /[?&](?:url|u|murl|dest|destination|target|to|redirect|redirect_?url|out|link)=(?:https?%3A|https?:)/i;
  const EXCLUDED = 'nav, footer, [role="navigation"], [role="contentinfo"], [aria-hidden="true"], deal-flash';
  const HEADINGS = 'h2, h3, h4, h5';
  const ANY_HEADING = 'h1, h2, h3, h4, h5, h6';
  const TRANSPARENT = /^(transparent|rgba\([^)]*,\s*0\))$/;

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => el.getClientRects().length > 0;
  const levelOf = (h) => +h.tagName[1];
  const uniq = (arr) => [...new Set(arr)];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // The registrable part of a host name ("nytimes.com", "teapots.co.uk"),
  // close enough without a public-suffix list.
  function siteOf(host) {
    const p = String(host).toLowerCase().replace(/^www\d*\./, '').split('.');
    if (p.length <= 2) return p.join('.');
    const sld = p[p.length - 2];
    const tld = p[p.length - 1];
    const n = tld.length === 2 && /^(co|com|net|org|gov|edu|ac|ne|or|go|gob|nic|ltd|plc)$/.test(sld) ? 3 : 2;
    return p.slice(-n).join('.');
  }
  const SITE = siteOf(location.hostname);
  const hostIn = (host, list) => list.some((s) => host === s || host.endsWith('.' + s));

  // ---------- prices ----------
  //
  // $12, £12.50, €12, ¥1,280, ₹999, code-prefixed (CA$12, A$12, US$12,
  // "USD 12") and suffixed ("12,99 €", "12 EUR"). A whole-number suffix
  // only counts when no number follows it, so "No. 1 €49" is €49, not "1 €".
  const CODES = 'USD|CAD|AUD|NZD|GBP|EUR|JPY|CNY|CHF|SEK|NOK|DKK|INR|MXN|BRL|HKD|SGD|ZAR|PLN';
  const NUM = '\\d(?:[\\d,.]*\\d)?';
  const SUFFIX = `(?:€|\\b(?:${CODES})\\b)`;
  const PRICE_SRC = `(?:(?:\\b[A-Z]{1,3}\\$|\\$|£|€|¥|₹|\\b(?:${CODES})\\s?)\\s?${NUM}|\\d[\\d,.]*[.,]\\d{2}\\s?${SUFFIX}|${NUM}\\s?${SUFFIX}(?!\\s?[\\d$£€¥₹]))`;
  const PRICE_RE = new RegExp(PRICE_SRC);
  const PRICE_G = new RegExp(PRICE_SRC, 'g');
  const SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', CNY: '¥', INR: '₹', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', HKD: 'HK$', MXN: 'MX$', SGD: 'S$' };
  const SAVE_RE = new RegExp(`\\b(?:you save|save)\\s+(?:up to\\s+)?(?:${PRICE_SRC}|\\d+%)[^()]{0,40}(\\(\\d+%\\))?`, 'i');
  const CTA_TEXT = new RegExp(`^\\s*(?:buy|shop|get it|see (?:it|deal|price|offer)|check price|view (?:deal|offer|price)|${PRICE_SRC})`, 'i');

  // The number in a price, whichever separator is the decimal one.
  function money(s) {
    let t = String(s).replace(/[^\d.,]/g, '');
    if (!t) return NaN;
    const lc = t.lastIndexOf(',');
    const ld = t.lastIndexOf('.');
    if (lc >= 0 && ld >= 0) t = lc > ld ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (lc >= 0) t = /,\d{1,2}$/.test(t) ? t.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, '') : t.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    return parseFloat(t);
  }

  // Write an amount the way another price on the page is written ("$", "£",
  // "CA$", "12,99 €").
  function fmtMoney(n, like) {
    const s = String(like);
    const first = s.search(/\d/);
    const last = s.search(/\d[^\d]*$/);
    const pre = first > 0 ? s.slice(0, first) : '';
    const post = last >= 0 ? s.slice(last + 1).replace(/^[\d.,]+/, '') : '';
    let num = n.toFixed(2).replace(/\.00$/, '');
    if (/\d,\d{1,2}(\D*)$/.test(s)) num = num.replace('.', ',');
    return pre + num + post;
  }
  const currencyOf = (p) => String(p).replace(/[\d.,\s]/g, '');

  function fmtCurrency(p, code) {
    const n = Number(p);
    const num = Number.isFinite(n) ? n.toFixed(2).replace(/\.00$/, '') : String(p);
    const c = String(code || '').toUpperCase();
    return (SYMBOLS[c] !== undefined ? SYMBOLS[c] : c ? c + ' ' : '') + num;
  }

  function savingsNote(price, old, hasPct) {
    const p = money(price);
    const o = money(old);
    if (!(p > 0 && o > p) || currencyOf(price) !== currencyOf(old)) return '';
    return `You save ${fmtMoney(o - p, price)}` + (hasPct ? '' : ` (${Math.round(((o - p) / o) * 100)}%)`);
  }

  // ---------- links ----------

  const sameSite = (host) => siteOf(host) === SITE;

  // A link to buy the item somewhere. On the site itself, only its own
  // affiliate redirects and links it marks as paid; elsewhere, a known shop
  // or affiliate network, a link marked sponsored, button-like text ("Buy",
  // "$24 at Acme"), or an outbound link right beside a price.
  function isBuyLink(a) {
    let u;
    try { u = new URL(a.href, location.href); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const sponsored = /\bsponsored\b/i.test(a.getAttribute('rel') || '');
    if (sameSite(host)) return REDIRECT_PATH.test(u.pathname) || REDIRECT_PARAM.test(u.search) || sponsored;
    if (hostIn(host, NOT_SHOPS)) return false;
    if (sponsored || hostIn(host, AFFILIATE_HOSTS) || RETAILERS.test('.' + host + '.')) return true;
    if (CTA_TEXT.test(a.textContent || '')) return true;
    const near = a.parentElement && clean(a.parentElement.textContent);
    return !!near && near.length < 200 && PRICE_RE.test(near);
  }

  function buyLinksIn(blocks) {
    const out = [];
    for (const b of blocks) {
      for (const a of b.matches('a[href]') ? [b] : b.querySelectorAll('a[href]')) {
        if (!a.closest(EXCLUDED) && isBuyLink(a)) out.push(a);
      }
    }
    return out;
  }

  const usableHref = (a) => {
    if (!(a instanceof HTMLAnchorElement)) return false;
    const h = a.getAttribute('href');
    return !!h && h[0] !== '#' && /^https?:$/.test(a.protocol);
  };

  // A link's identity for grouping: host and path, without www, query, hash
  // or Amazon-style "/ref=…" tails.
  function normHref(href) {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return '';
      return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/+$/, '')).toLowerCase();
    } catch { return ''; }
  }

  function siteName() {
    const og = document.querySelector('meta[property="og:site_name"]');
    return clean(og && og.content) || location.hostname.replace(/^www\./, '');
  }

  function effectiveBg(el) {
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (!TRANSPARENT.test(c)) return c;
    }
    return 'rgb(255, 255, 255)';
  }

  const hasImage = (el) => el.matches('img, picture, video') || !!el.querySelector('img, picture, video');
  const isMedia = (el) => hasImage(el) && clean(el.textContent).length < 200 && !el.querySelector(HEADINGS) && !buyLinksIn([el]).length;

  // Newsletter boxes, ads and other inserts between an item's paragraphs:
  // anything with a form or iframe, or painted in its own background colour.
  function isJunk(el, parentBg) {
    if (el.matches('form, iframe, aside') || el.querySelector('form, input, select, textarea, iframe')) return true;
    if (isMedia(el) || buyLinksIn([el]).length) return false;
    const area = el.offsetWidth * el.offsetHeight;
    if (!area) return false;
    const list = [el, ...el.querySelectorAll('*')];
    for (let i = 0; i < list.length && i < 40; i++) {
      const c = list[i];
      if (c.matches('img, picture, video, svg') || c.offsetWidth * c.offsetHeight < area * 0.6) continue;
      const cs = getComputedStyle(c);
      if ((!TRANSPARENT.test(cs.backgroundColor) && cs.backgroundColor !== parentBg) || cs.backgroundImage !== 'none') return true;
    }
    return false;
  }

  // Screen-reader-only spans ("Buying options:", ", opens in a new tab") are
  // clipped to nothing; leave them out of anything shown.
  function hiddenEl(el, cache) {
    if (cache.has(el)) return cache.get(el);
    let h = !el.getClientRects().length;
    if (!h) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) {
        const cs = getComputedStyle(el);
        h = cs.position === 'absolute' || cs.clip !== 'auto' || cs.overflow === 'hidden';
      }
    }
    cache.set(el, h);
    return h;
  }

  function textOf(root, cache, skip = null) {
    const parts = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      let bad = false;
      for (let e = n.parentElement; e && e !== root.parentElement; e = e.parentElement) {
        if (e === skip || hiddenEl(e, cache)) { bad = true; break; }
      }
      if (!bad) parts.push(n.textContent);
    }
    return clean(parts.join(' '));
  }

  // Text a screen reader would read: screen-reader-only spans in, the
  // aria-hidden visual duplicates ("$ 24 . 99", truncated titles) out.
  function srText(root) {
    if (!root) return '';
    const parts = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (p.closest('script, style, noscript, template')) continue;
      const ah = p.closest('[aria-hidden="true"]');
      if (!ah || ah === root || !root.contains(ah)) parts.push(n.textContent);
    }
    return clean(parts.join(' '));
  }

  function categoryOf(el) {
    const sec = el.closest('section');
    const h = sec && [...sec.children].find((k) => k.matches(ANY_HEADING));
    return h ? clean(h.textContent).slice(0, 80) : '';
  }

  // ---------- editorial lists (links out to shops) ----------

  function findRoot() {
    return document.querySelector('main') || document.body;
  }

  function editorialItems(root) {
    let items = byHeadings(root);
    // Headings that each cover a whole category of products are the wrong
    // grain. (Counted by destination: a product's photo, name and first
    // button often share one link.)
    const avgLinks = items.length ? items.reduce((n, it) => n + new Set(it.links.map((a) => a.href)).size, 0) / items.length : 0;
    if (items.length < 3 || avgLinks >= 3) {
      const fb = fallback(root);
      if (fb.length > Math.max(items.length * 1.5, 2)) items = fb;
    }
    return items;
  }

  function wirecutterCards(root) {
    const cards = [...root.querySelectorAll('.global-cob')].filter(
      (c) => !c.parentElement.closest('.global-cob') && !c.closest(EXCLUDED) && isVisible(c) && buyLinksIn([c]).length,
    );
    if (cards.length < 3) return [];
    const cardSet = new Set(cards);
    return cards.map((card) => {
      const blocks = [];
      const prev = card.previousElementSibling;
      const deck = prev && prev.matches(ANY_HEADING) ? prev : null;
      if (deck) blocks.push(deck);
      blocks.push(card);
      const parentBg = effectiveBg(card.parentElement);
      for (let s = card.nextElementSibling, n = 0; s && n < 8; s = s.nextElementSibling, n++) {
        if (cardSet.has(s) || s.matches(ANY_HEADING + ', figure') || s.querySelector('.global-cob, ' + ANY_HEADING)) break;
        if (!isJunk(s, parentBg)) blocks.push(s);
      }
      const names = uniq([...card.querySelectorAll(ANY_HEADING)].map((h) => clean(h.textContent)).filter(Boolean));
      return {
        head: card,
        anchor: card,
        blocks,
        links: uniq(buyLinksIn(blocks)),
        title: (names.join(' + ') || 'Item').slice(0, 160),
        deck: deck ? clean(deck.textContent).slice(0, 200) : '',
        category: categoryOf(card),
      };
    });
  }

  function byHeadings(root) {
    const nodes = [...root.querySelectorAll(HEADINGS + ', a[href]')].filter((n) => !n.closest(EXCLUDED));

    // Attribute each buy link to the open section at every heading level.
    const levels = [2, 3, 4, 5];
    const open = {};
    const sections = { 2: [], 3: [], 4: [], 5: [] };
    for (const n of nodes) {
      if (n.tagName === 'A') {
        if (!isBuyLink(n)) continue;
        for (const L of levels) if (open[L]) open[L].links.push(n);
        continue;
      }
      if (!isVisible(n) || !clean(n.textContent)) continue;
      const lvl = levelOf(n);
      const sec = { head: n, links: [], category: '' };
      for (let L = lvl - 1; L >= 2; L--) {
        if (open[L]) { sec.category = clean(open[L].head.textContent).slice(0, 80); break; }
      }
      sections[lvl].push(sec);
      for (const L of levels) if (L >= lvl) open[L] = null;
      open[lvl] = sec;
    }

    // A heading whose only buy links go where the next heading's do is a
    // category heading over the next item's photo link, not an item.
    for (const L of levels) {
      const secs = sections[L];
      for (let i = 0; i + 1 < secs.length; i++) {
        const next = new Set(secs[i + 1].links.map((a) => a.href));
        if (secs[i].links.length && secs[i].links.every((a) => next.has(a.href))) secs[i].links = [];
      }
    }

    let best = 0;
    let bestCount = 0;
    for (const L of levels) {
      const c = sections[L].filter((s) => s.links.length).length;
      if (c >= bestCount && c > 0) { best = L; bestCount = c; }
    }
    if (!best) return [];

    const bySection = new Map(sections[best].map((s) => [s.head, s]));
    return extents(sections[best].map((s) => s.head), best, root)
      .map((it) => {
        const sec = bySection.get(it.head);
        const links = uniq([...sec.links, ...buyLinksIn(it.blocks)]);
        return { ...it, links, title: clean(it.head.textContent).slice(0, 160), deck: '', category: sec.category };
      })
      .filter((it) => it.links.length);
  }

  // An item's page area: the largest wrapper around its heading that holds no
  // other item heading, plus (when the items are flat siblings) the blocks
  // that follow it up to the next item. A smaller heading right above an item
  // introduces it. An image between two flat items is ambiguous; the page's
  // own habit decides: if most items have an image right above their heading,
  // that image belongs to the item below.
  function extents(heads, level, root) {
    const count = new Map();
    for (const h of heads) {
      for (let el = h; el && el !== root; el = el.parentElement) count.set(el, (count.get(el) || 0) + 1);
    }
    const stop = Array.from({ length: level }, (_, i) => 'h' + (i + 1)).join(', ');
    const isStop = (el) => el.matches(stop) || !!el.querySelector(stop);
    const isIntroHeading = (el) => el.matches(HEADINGS) && levelOf(el) > level;
    const isIntro = (el) => isIntroHeading(el) || isMedia(el);
    const maxSpan = window.innerHeight * 2.5;

    const res = heads.map((h) => {
      let el = h;
      while (el.parentElement && el.parentElement !== root && el.parentElement !== document.body && count.get(el.parentElement) === 1) {
        el = el.parentElement;
      }
      const sibs = el.parentElement ? [...el.parentElement.children] : [el];
      const i = sibs.indexOf(el);
      const top = el.getBoundingClientRect().top;
      const parentBg = el.parentElement ? effectiveBg(el.parentElement) : '';
      const trail = [];
      let reachedNext = false;
      for (let j = i + 1; j < sibs.length; j++) {
        const s = sibs[j];
        if (count.get(s)) { reachedNext = true; break; }
        if (isStop(s) || s.getBoundingClientRect().bottom - top > maxSpan) break;
        if (!isJunk(s, parentBg)) trail.push(s);
      }
      let t = trail.length;
      if (reachedNext) while (t > 0 && trail.length - t < 3 && isIntro(trail[t - 1])) t--;
      const tail = trail.slice(t);
      const body = [el, ...trail.slice(0, t)];
      const lead = [];
      for (let j = i - 1; j >= 0 && lead.length < 3; j--) {
        const s = sibs[j];
        if (count.get(s) || !isIntro(s)) break;
        lead.unshift(s);
      }
      return { head: h, el, trail, tail, lead, imageless: !body.some(hasImage) };
    });

    const leadMedia = res.filter((r) => r.imageless && r.lead.some(isMedia)).length;
    const tailMedia = res.filter((r) => r.imageless && r.tail.some(isMedia)).length;
    const above = leadMedia > 0 && leadMedia >= tailMedia;
    for (const r of res) r.lead = r.lead.filter((b) => isIntroHeading(b) || (above && r.imageless));
    const claimed = new Set(res.flatMap((r) => r.lead));
    return res.map((r) => ({
      head: r.head,
      anchor: r.el,
      blocks: [...r.lead, r.el, ...r.trail.filter((b) => !claimed.has(b))],
    }));
  }

  function fallback(root) {
    const links = [...root.querySelectorAll('a[href]')].filter((a) => !a.closest(EXCLUDED) && isVisible(a) && isBuyLink(a));
    const cards = [];
    for (const a of links) {
      let card = null;
      for (let el = a.parentElement; el && el !== root; el = el.parentElement) {
        if (el.querySelector('img, picture')) {
          if (el.getBoundingClientRect().height < window.innerHeight * 1.5) card = el;
          break;
        }
      }
      card = card || a.closest('li');
      if (card && root.contains(card) && !cards.includes(card)) cards.push(card);
    }
    return cards
      .filter((c) => !cards.some((o) => o !== c && c.contains(o)))
      .map((c) => {
        const head = c.querySelector('h1, h2, h3, h4, h5, h6, strong, b') || buyLinksIn([c])[0];
        return {
          head,
          anchor: c,
          blocks: [c],
          links: uniq(buyLinksIn([c])),
          title: clean(head && head.textContent).slice(0, 160) || 'Item',
          deck: '',
          category: '',
        };
      });
  }

  // ---------- schema.org hints ----------
  //
  // JSON-LD Product and ItemList entries (url, name, offer price) and
  // microdata itemtype=Product. A hint, never a requirement: a card that
  // links to a listed product, or is marked up as one, counts as a product
  // card even without a visible price, and its offer price fills in a buy
  // button that has none.

  let schemaCache = null;
  function schemaHints() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    const sig = location.href + '|' + scripts.length;
    if (schemaCache && schemaCache.sig === sig) return schemaCache;
    const urls = new Map();
    const names = new Map();
    const offerOf = (o) => {
      o = Array.isArray(o) ? o[0] : o;
      if (!o || typeof o !== 'object') return '';
      const p = o.price !== undefined ? o.price : o.lowPrice;
      return p !== undefined && p !== null && p !== '' ? fmtCurrency(p, o.priceCurrency) : '';
    };
    const add = (url, name, price) => {
      const rec = { name: clean(typeof name === 'string' ? name : ''), price };
      const k = typeof url === 'string' ? normHref(url) : '';
      if (k && !urls.has(k)) urls.set(k, rec);
      if (rec.name && !names.has(rec.name.toLowerCase())) names.set(rec.name.toLowerCase(), rec);
    };
    const walk = (o, d) => {
      if (!o || typeof o !== 'object' || d > 8) return;
      if (Array.isArray(o)) {
        for (const x of o.slice(0, 1000)) walk(x, d + 1);
        return;
      }
      const types = [].concat(o['@type'] || []).map(String);
      if (types.some((t) => /Product/i.test(t))) add(o.url || o['@id'], o.name, offerOf(o.offers));
      if (types.includes('ListItem')) {
        const it = o.item;
        if (typeof it === 'string') add(it, o.name, '');
        else if (it && typeof it === 'object') add(it.url || it['@id'] || o.url, it.name || o.name, offerOf(it.offers));
        else if (o.url) add(o.url, o.name, '');
      }
      for (const k of ['@graph', 'itemListElement', 'mainEntity', 'hasPart', 'item', 'hasVariant']) if (o[k] && typeof o[k] === 'object') walk(o[k], d + 1);
    };
    for (const s of scripts) {
      try { walk(JSON.parse(s.textContent), 0); } catch { /* not JSON; ignore */ }
    }
    schemaCache = { sig, urls, names, any: urls.size + names.size > 0 };
    return schemaCache;
  }

  const PRODUCT_MD = '[itemtype*="schema.org/Product" i]';
  function microPrice(md) {
    const p = md.querySelector('[itemprop="price"], [itemprop="lowPrice"]');
    if (!p) return '';
    const v = p.getAttribute('content') || clean(p.textContent);
    if (PRICE_RE.test(v)) return v.match(PRICE_RE)[0];
    const c = md.querySelector('[itemprop="priceCurrency"]');
    return v ? fmtCurrency(v.replace(/[^\d.]/g, ''), c ? c.getAttribute('content') || clean(c.textContent) : '') : '';
  }

  // ---------- repeated cards (shop grids, search results, gift grids) ----------
  //
  // Elements that hold a link are grouped by their own tag+class signature
  // together with their parent's, so the cards of a grid group together even
  // across the rows that wrap them. A group is a candidate list when it has
  // at least GRID_MIN card-sized, visible members that each stand for one
  // product (a member linking to several products is a wrapper row, and
  // pieces of one card that share its link count once), it isn't a sideways
  // carousel, and at least half its members carry a commerce signal: a
  // price, an add-to-cart/buy button, an outbound buy link, or a schema.org
  // Product hint. The best group scores most, each card worth
  // 1 + 0.6 image + 1 price + 0.4 button + 0.5 schema + 0.3 buy link, which
  // is how the card beats both its inner pieces (fewer signals) and its
  // wrapper rows (fewer members); a tie goes to the larger area (the card
  // over a same-size inner box). Article lists without any commerce signal
  // are left alone on purpose.

  const GRID_MIN = 4;
  const GRID_EXCLUDED = EXCLUDED + ', [role="banner"], body > header, [role="menu"], [role="menubar"], [role="tablist"], [role="dialog"], [aria-modal="true"], dialog';
  const CTA_BUTTON = /^(?:add to (?:cart|bag|basket|trolley|order)|add\b|buy\b|shop now|order now|get it|see (?:it|deal|price|details|options)|view (?:deal|product|item|details|options)|check price|choose options|select options)/i;
  // State and index classes that differ between otherwise identical cards.
  const VOLATILE_CLASS = /^(?:is-|has-|js-)|^(?:active|selected|current|first|last|odd|even|hover|focus|focused|open|visible|hidden|loaded|loading|lazy\w*|in-view|show)$|[-_]\d+$|^\d+$/i;

  function sigOf(el) {
    const cls = [...el.classList].filter((c) => !VOLATILE_CLASS.test(c)).sort().join('.');
    const tid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-component-type');
    const role = el.getAttribute('role');
    const it = el.getAttribute('itemtype');
    return el.tagName + (cls ? '.' + cls : '') + (tid ? '[t=' + tid.replace(/\d+/g, '#') + ']' : '') + (role ? '[r=' + role + ']' : '') + (it ? '[i=' + it + ']' : '');
  }

  // What one card holds: its main link, how many different products it
  // links to, and its commerce signals.
  function memberInfo(m, schema) {
    const text = srText(m);
    const info = { key: '', main: null, hrefs: 0, img: false, price: PRICE_RE.test(text), cta: false, buy: false, schema: null, value: 1 };
    const byHref = new Map();
    const strong = new Set();
    for (const a of m.matches('a[href]') ? [m] : m.querySelectorAll('a[href]')) {
      if (!usableHref(a)) continue;
      const k = normHref(a.href);
      if (!k) continue;
      if (!info.buy && isBuyLink(a)) info.buy = true;
      const t = clean(a.textContent);
      if (CTA_BUTTON.test(t)) { info.cta = true; continue; }
      const media = !!a.querySelector('img, picture, [role="img"]');
      const heading = !!(a.querySelector(ANY_HEADING) || a.closest(ANY_HEADING));
      // A price button ("$24 at Acme") is a way to buy, not the card's own link.
      if (PRICE_RE.test(t) && !media && !heading) continue;
      if (media || heading || t.length >= 15) strong.add(k);
      let c = byHref.get(k);
      if (!c) byHref.set(k, (c = { a, score: 0 }));
      c.score += 1 + (media ? 2 : 0) + (heading ? 2 : 0) + Math.min(t.length, 80) / 40 - (/review|rating/i.test(t) ? 2 : 0);
    }
    let best = null;
    for (const c of byHref.values()) if (!best || c.score > best.score) best = c;
    for (const im of m.querySelectorAll('img, picture, [role="img"]')) {
      const r = im.getBoundingClientRect();
      if ((r.width >= 50 && r.height >= 50) || +im.getAttribute('width') >= 50) { info.img = true; break; }
    }
    // Only a price button and nothing else (no photo, no name): one shop's
    // buy box inside a card, not a card.
    if (best) info.main = best.a;
    else if (info.img || m.querySelector(ANY_HEADING)) info.main = buyLinksIn([m])[0] || null;
    info.key = info.main ? normHref(info.main.href) : '';
    info.hrefs = strong.size;
    if (!info.cta) {
      for (const b of m.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) {
        if (CTA_BUTTON.test(clean(b.textContent || b.value || b.getAttribute('aria-label') || ''))) { info.cta = true; break; }
      }
    }
    const md = m.matches(PRODUCT_MD) ? m : m.querySelector(PRODUCT_MD);
    if (md) info.schema = { price: microPrice(md) };
    else if (schema.any && info.key) info.schema = schema.urls.get(info.key) || null;
    info.value = 1 + (info.img ? 0.6 : 0) + (info.price ? 1 : 0) + (info.cta ? 0.4 : 0) + (info.schema ? 0.5 : 0) + (info.buy ? 0.3 : 0);
    return info;
  }

  function evalGroup(key, members, schema) {
    const rects = new Map();
    const ms = members.filter((m) => {
      const r = m.getBoundingClientRect();
      if (r.width < 60 || r.height < 40 || r.height > innerHeight * 1.6) return false;
      rects.set(m, r);
      return true;
    });
    if (ms.length < GRID_MIN) return null;
    // A carousel scrolled sideways ("Customers also bought", "Recently
    // viewed") is not the page's list.
    const off = ms.filter((m) => { const r = rects.get(m); return r.right <= 0 || r.left >= innerWidth; }).length;
    if (off > ms.length * 0.3) return null;
    for (let e = ms[0].parentElement, i = 0; e && e !== document.body && i < 3; e = e.parentElement, i++) {
      if (/(auto|scroll)/.test(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 20) return null;
    }
    const byHref = new Map();
    let wrappers = 0;
    for (const m of ms) {
      const info = memberInfo(m, schema);
      if (!info.main) continue;
      if (info.hrefs >= 3) { wrappers++; continue; }
      const cur = byHref.get(info.key);
      if (!cur || info.value > cur.info.value) byHref.set(info.key, { m, info });
    }
    if (wrappers > ms.length / 2) return null;
    const kept = [...byHref.values()];
    if (kept.length < GRID_MIN) return null;
    const frac = (f) => kept.filter((x) => x.info[f]).length / kept.length;
    if (!(frac('price') >= 0.5 || frac('cta') >= 0.5 || frac('schema') >= 0.5 || frac('buy') >= 0.5)) return null;
    kept.sort((a, b) => (a.m.compareDocumentPosition(b.m) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    let score = 0;
    let area = 0;
    for (const { m, info } of kept) {
      score += info.value;
      const r = rects.get(m);
      area += r.width * r.height;
    }
    return { key, members: kept, score, area };
  }

  function findGrid() {
    const body = document.body;
    if (!body) return null;
    const groups = new Map();
    const sigs = new Map();
    const sig = (e) => {
      let s = sigs.get(e);
      if (s === undefined) sigs.set(e, (s = sigOf(e)));
      return s;
    };
    let n = 0;
    for (const a of body.querySelectorAll('a[href]')) {
      if (++n > 8000) break;
      if (!usableHref(a) || a.closest(GRID_EXCLUDED)) continue;
      let e = a;
      for (let d = 0; d < 10 && e.parentElement && e !== body; d++, e = e.parentElement) {
        const key = sig(e.parentElement) + '>' + sig(e);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = new Set()));
        g.add(e);
      }
    }
    const schema = schemaHints();
    let best = null;
    for (const [key, set] of groups) {
      if (set.size < GRID_MIN) continue;
      // Same-signature members nested in each other: keep the inner ones.
      const outer = new Set();
      for (const m of set) {
        for (let p = m.parentElement, d = 0; p && d < 10; p = p.parentElement, d++) if (set.has(p)) outer.add(p);
      }
      const members = [...set].filter((m) => !outer.has(m));
      if (members.length < GRID_MIN) continue;
      const g = evalGroup(key, members, schema);
      if (!g) continue;
      if (!best || g.score > best.score * 1.01 || (g.score >= best.score * 0.99 && g.area > best.area)) best = g;
    }
    return best;
  }

  // Grid detection is the costly part; once per detect() pass.
  let pass = 0;
  let gridMemo = { pass: -1, grid: null };
  function gridOnce() {
    if (gridMemo.pass !== pass) gridMemo = { pass, grid: findGrid() };
    return gridMemo.grid;
  }

  // A virtualized grid positions its cards itself (Amazon's rows are
  // absolutely positioned in a list as tall as all of them).
  function isVirtual(g) {
    for (const { m } of g.members.slice(0, 3)) {
      for (let e = m, i = 0; e && i < 4; e = e.parentElement, i++) {
        const cs = getComputedStyle(e);
        if (cs.position === 'absolute' || (cs.transform !== 'none' && /translate|matrix/.test(cs.transform))) return true;
      }
    }
    return false;
  }

  function titleOf(m, info) {
    const ok = (t) => t && t.length >= 2 && t.length <= 220;
    const h = m.querySelector(ANY_HEADING);
    if (h && ok(srText(h))) return srText(h);
    const ip = m.querySelector('[itemprop="name"]');
    if (ip) {
      const t = clean(ip.getAttribute('content') || srText(ip));
      if (ok(t)) return t;
    }
    // The longest piece of the main link's text that isn't a price, a
    // button or a badge ("59% off").
    let best = '';
    for (const a of m.querySelectorAll('a[href]')) {
      if (normHref(a.href) !== info.key) continue;
      for (const e of [a, ...a.querySelectorAll('p, span, strong, b, div')]) {
        const t = srText(e);
        if (ok(t) && t.length > best.length && !PRICE_RE.test(t) && !CTA_BUTTON.test(t) && !/^-?\d+\s?%/.test(t)) best = t;
      }
    }
    if (best) return best;
    const s = m.querySelector('strong, b');
    if (s && ok(srText(s))) return srText(s);
    const im = m.querySelector('img[alt]');
    if (im && ok(clean(im.alt))) return clean(im.alt);
    return clean(srText(info.main)).slice(0, 160) || 'Item';
  }

  function gridItem(m, info) {
    const title = titleOf(m, info).slice(0, 220);
    const rec = info.schema || schemaHints().names.get(title.toLowerCase()) || null;
    return {
      head: m,
      anchor: m,
      blocks: [m],
      links: uniq(buyLinksIn([m])),
      main: info.main.href,
      offer: (rec && rec.price) || '',
      title,
      deck: '',
      category: categoryOf(m),
    };
  }

  // ---------- virtualized lists (Amazon's deals grid, any grid like it) ----------
  //
  // Amazon's deal grids (inspected 2026-11-22 on /events/devicedeals/) are
  // virtualized: of the deals loaded so far, only the rows near the screen
  // exist in the page, each at a fixed position, and more deals load as the
  // end of the grid comes into view. So each card is read once, when it
  // first appears, and kept with where it sat; paging works long after the
  // page drops the card, and regFill() draws the rows past either end on
  // demand. A registry holds what's been read: reg: id -> item; pos:
  // "top|left" in the list -> id; list: the virtual list element; done: the
  // page had no more to load; replaced: item key -> the key of the item that
  // took its slot (Amazon swaps colour variants of a product in place
  // between loads).

  const makeReg = (prefix) => ({ prefix, reg: new Map(), pos: new Map(), ctx: '', list: null, done: false, replaced: new Map(), msig: '', psig: '', tag: '' });
  function regReset(R, ctx) {
    R.ctx = ctx;
    R.reg.clear();
    R.pos.clear();
    R.replaced.clear();
    R.list = null;
    R.done = false;
    R.msig = R.psig = R.tag = '';
  }

  // The virtual list's own box: the first wrapper much taller than a card.
  // Positions are kept relative to it, since the page above the grid still
  // shifts as its images and banners load.
  function listOf(card, h) {
    for (let e = card.parentElement, i = 0; e && e !== document.body && i < 12; e = e.parentElement, i++) {
      if (e.getBoundingClientRect().height > h * 2.5) return e;
    }
    return null;
  }

  // Page coordinates of a list's top-left corner (the page itself without one).
  function baseOf(list, R) {
    if (!list || !list.isConnected) list = R && R.list && R.list.isConnected ? R.list : null;
    if (!list) return { top: 0, left: 0, height: 0, list: null };
    const b = list.getBoundingClientRect();
    return { top: b.top + scrollY, left: b.left + scrollX, height: b.height, list };
  }

  function regRect(it) {
    const b = baseOf(it.list, it.R);
    const r = it.rel;
    return { top: b.top + r.top, left: b.left + r.left, bottom: b.top + r.bottom, right: b.left + r.right };
  }

  function seenAt(R, card, id, r) {
    const list = listOf(card, r.height);
    const b = baseOf(list, R);
    const top = r.top + scrollY - b.top;
    const left = r.left + scrollX - b.left;
    return { card, id, list: b.list, rel: { top, left, bottom: top + r.height, right: left + r.width }, at: Math.round(top / 4) + '|' + Math.round(left / 4) };
  }

  // Fold the cards drawn now into the registry. Returns the items in list
  // order, or null when the list changed under us and was started over.
  function regMerge(R, seen, make) {
    // A different item where a kept one sat. A slot or two: the page swapped
    // in another colour of the same product, so that item replaces the old
    // one. Most of what's drawn: the grid changed under us (another filter,
    // a re-sort); start over.
    const drawn = new Set(seen.map((s) => s.id));
    const clashes = seen.filter((s) => R.pos.has(s.at) && R.pos.get(s.at) !== s.id);
    if (clashes.length >= 4 && clashes.length > seen.length * 0.6) {
      const keep = { msig: R.msig, psig: R.psig, tag: R.tag };
      regReset(R, R.ctx);
      Object.assign(R, keep);
      return null;
    }
    for (const s of clashes) {
      const old = R.pos.get(s.at);
      R.pos.delete(s.at);
      if (drawn.has(old)) continue; // it moved; its new slot is read below
      R.reg.delete(old);
      R.replaced.set(R.prefix + old, R.prefix + s.id);
    }
    for (const s of seen) {
      let it = R.reg.get(s.id);
      if (!it) {
        it = make(s);
        it.R = R;
        R.reg.set(s.id, it);
        R.done = false;
      }
      if (it.rel) {
        const was = Math.round(it.rel.top / 4) + '|' + Math.round(it.rel.left / 4);
        if (R.pos.get(was) === s.id) R.pos.delete(was);
      }
      it.head = it.anchor = s.card;
      it.blocks = [s.card];
      it.list = s.list;
      it.rel = s.rel;
      if (s.list) R.list = s.list;
      R.pos.set(s.at, s.id);
    }
    return [...R.reg.values()].sort((a, b) => (Math.abs(a.rel.top - b.rel.top) > 8 ? a.rel.top - b.rel.top : a.rel.left - b.rel.left));
  }

  // Draw the rows past one end of what's been read, by scrolling the page
  // there (in card view it's out of sight behind the card), and wait for
  // them. Past the last loaded item, that's also what makes the page load
  // more, or, on Amazon once it has loaded a couple of hundred, shows its
  // "View more deals" button, which this presses (more() finds it). If
  // nothing comes within a few seconds, that was the last item (each of
  // Amazon's filters really does end: 50 under $50, 117 in all devices, on
  // 2026-11-22). Returns 'grew', 'end' (nothing more), or 'cancelled'
  // (another key interrupted it), or '' when there was nothing to try.
  const FILL_WAIT = { draw: 1500, load: 3500, probe: 2500 };

  async function regFill(R, dir, more, msgs) {
    const edge = dir > 0 ? S.items[S.items.length - 1] : S.items[0];
    if (!edge || !edge.rel) return '';
    const b = baseOf(edge.list, R);
    const above = !!b.list && edge.rel.top > 20;
    const atEnd = dir > 0 && (!b.list || edge.rel.bottom >= b.height - 20);
    if (dir < 0 && !above) return '';
    if (atEnd && R.done && !more()) return 'end';
    const rc = regRect(edge);
    const { token, slow } = beginFill(dir, atEnd ? msgs.load : msgs.draw);
    const before = S.items.length;
    // Something now on the far side of the edge item?
    const beyond = () => {
      const i = S.items.indexOf(edge);
      if (i < 0) return S.items.length > before;
      return dir > 0 ? i < S.items.length - 1 : i > 0;
    };
    const t0 = performance.now();
    let result = '';
    let nudges = 0;
    let pressed = false;
    window.scrollTo({ top: dir > 0 ? rc.top - 40 : rc.bottom - innerHeight + 40, behavior: 'instant' });
    while (performance.now() - t0 < (atEnd ? FILL_WAIT.load : FILL_WAIT.draw)) {
      const btn = atEnd && !pressed && more();
      if (btn) {
        btn.click();
        pressed = true;
      }
      await wait(120);
      if (token !== S.fillToken) { result = 'cancelled'; break; }
      refresh();
      if (beyond()) {
        await wait(150); // the rest of the row
        if (token !== S.fillToken) { result = 'cancelled'; break; }
        refresh();
        result = 'grew';
        break;
      }
      // The page loads when the end of the grid comes into view; bring it
      // into view again from a little way up, in case it already was.
      const t = performance.now() - t0;
      if (atEnd && ((nudges === 0 && t > 900) || (nudges === 1 && t > 2000))) {
        nudges++;
        const end = baseOf(edge.list, R);
        window.scrollTo({ top: end.top + end.height - innerHeight * (nudges === 1 ? 2 : 3), behavior: 'instant' });
        await wait(120);
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      }
    }
    endFill(token, slow);
    if (!result) result = 'end';
    if (result === 'end' && atEnd) R.done = true;
    return result;
  }

  // The waiting state every kind of fill shares: j and k are held off, any
  // other key cancels (see onKey), and a toast appears if it takes a while.
  function beginFill(dir, msg) {
    const token = ++S.fillToken;
    S.filling = true;
    S.fillDir = dir;
    if (ui) ui.host.dataset.busy = '1';
    return { token, slow: setTimeout(() => toast(msg), 400) };
  }

  function endFill(token, slow) {
    clearTimeout(slow);
    if (token === S.fillToken) {
      S.filling = false;
      if (ui) ui.host.dataset.busy = '';
    }
  }

  // Another key while a fill waits: stop waiting and do what that key says.
  function cancelFill() {
    S.fillToken++;
    S.filling = false;
    if (ui) ui.host.dataset.busy = '';
    // The wait left the page scrolled to the list's end; put it back.
    if (S.items[S.idx]) scrollToItem(S.items[S.idx]);
  }

  // ---------- growing lists (load more, infinite scroll) ----------
  //
  // Most long lists don't draw everything at once. Past the last item drawn,
  // the pager scrolls the end of the list into view (behind the card in card
  // view), presses a visible "Load more" / "Show more" / "View more" button
  // under it if there is one, and waits for more items. It only tries when
  // there's a reason to think more will come: the adapter says the page
  // grows (the gift guide), the page's own count is higher than what's drawn
  // ("Showing 324 gifts", "1–24 of 310 results"), a more-button is there, or
  // the list has already grown by itself while you scrolled. Otherwise the
  // first j past the end just says "Last item", and a second j within a few
  // seconds has a look anyway. Each try is time-limited and counts only new
  // items, so an endless feed of other things can't keep it waiting.

  // total: the page's own count; countEl: where it says so; noun: what it
  // calls the items; endAt: how many items there were when a wait for more
  // came back empty; grew: the list grew without the pager asking;
  // endPress: the last j past the end that didn't try.
  const GROW = { total: 0, countEl: null, noun: '', endAt: -1, grew: false, endPress: null, href: '' };
  const COUNT_NOUN = 'results?|items?|products?|deals?|gifts?|styles?|listings?|picks?|finds?';
  const COUNT_RES = [
    new RegExp(`^(?:showing|viewing|displaying)\\s+(?:all\\s+)?(?:\\d[\\d,]*\\s*(?:[-–—]|to)\\s*\\d[\\d,]*\\s+(?:of|out of)\\s+)?(\\d[\\d,]*)\\s+(${COUNT_NOUN})\\b`, 'i'),
    new RegExp(`^(?:(?:showing|viewing|displaying|${COUNT_NOUN})\\s+)?\\d[\\d,]*\\s*(?:[-–—]|to)\\s*\\d[\\d,]*\\s+(?:of|out of)\\s+(\\d[\\d,]*)(?:\\s+(${COUNT_NOUN}))?`, 'i'),
    new RegExp(`^(?:showing\\s+)?\\d[\\d,]*\\s+(?:of|out of)\\s+(\\d[\\d,]*)\\s+(${COUNT_NOUN})\\b`, 'i'),
    new RegExp(`^(\\d[\\d,]*)\\s+(${COUNT_NOUN})(?:\\s+found)?$`, 'i'),
  ];
  const MORE_TEXT = new RegExp(`^(?:(?:load|show|view|see|get)\\s+(?:\\d+\\s+)?more|more\\s+(?:${COUNT_NOUN})|(?:load|show)\\s+next)\\b`, 'i');

  function countMatch(t) {
    if (!t || t.length > 80) return null;
    for (const re of COUNT_RES) {
      const m = t.match(re);
      if (!m) continue;
      const n = +m[1].replace(/,/g, '');
      if (n >= 2) return { n, noun: m[2] ? m[2].toLowerCase().replace(/s?$/, 's') : '' };
    }
    return null;
  }

  function countTotal(items) {
    const inItem = (e) => items.some((it) => it.blocks.some((b) => b.contains(e)));
    let e = GROW.countEl;
    let m = e && e.isConnected ? countMatch(clean(e.textContent)) : null;
    if (!m) {
      e = null;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let looked = 0;
      for (let n = w.nextNode(); n && !m && looked < 4000; n = w.nextNode()) {
        if (!/\d/.test(n.textContent)) continue;
        looked++;
        for (let p = n.parentElement, d = 0; p && d < 3 && !m; p = p.parentElement, d++) {
          const t = clean(p.textContent);
          if (t.length > 80) break;
          const r = countMatch(t);
          if (r && !p.closest(GRID_EXCLUDED) && !inItem(p)) { m = r; e = p; }
        }
      }
      GROW.countEl = e;
    }
    GROW.total = m ? m.n : 0;
    GROW.noun = m ? m.noun : '';
  }

  const growDone = () => (GROW.total > 0 && S.items.length >= GROW.total) || GROW.endAt === S.items.length;

  // A button under the list that loads more of it in place. Links that go
  // to another page (pagination, "See all") are not pressed.
  function moreButton(items) {
    const last = items[items.length - 1];
    const lr = last && rectOf(last);
    if (!lr) return null;
    for (const b of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a:not([href]), a[href="#"]')) {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true' || b.closest(EXCLUDED)) continue;
      const t = clean(b.textContent || b.value || b.getAttribute('aria-label') || '');
      if (t.length > 40 || !MORE_TEXT.test(t) || !b.getClientRects().length) continue;
      const top = b.getBoundingClientRect().top + scrollY;
      if (top < lr.top - 4 || top > lr.bottom + innerHeight * 2) continue;
      if (items.some((it) => it.blocks.some((x) => x.isConnected && x.contains(b)))) continue;
      return b;
    }
    return null;
  }

  // The element that holds the list: the closest one around its first and
  // last items.
  function listBox(items) {
    const a = items[0] && items[0].head;
    const b = items[items.length - 1] && items[items.length - 1].head;
    if (!a || !b || !a.isConnected || !b.isConnected) return null;
    if (a === b) return a.parentElement;
    for (let e = a.parentElement; e; e = e.parentElement) if (e.contains(b)) return e;
    return null;
  }

  async function growFill(dir) {
    const a = S.adapter;
    const n = S.items.length;
    const edge = S.items[n - 1];
    if (dir < 0 || !edge) return '';
    if (growDone()) return 'end';
    let btn = moreButton(S.items);
    const now = performance.now();
    const reason = a.grows === 'always' || GROW.total > n || !!btn || GROW.grew;
    if (!reason) {
      const p = GROW.endPress;
      if (!p || p.n !== n || p.href !== location.href || now - p.t > 6000) {
        GROW.endPress = { n, href: location.href, t: now };
        return '';
      }
    }
    GROW.endPress = null;
    const { token, slow } = beginFill(1, `Loading more ${nounOf(a)}…`);
    const before = n;
    const box = listBox(S.items);
    const toEnd = () => {
      const bottom = box && box.isConnected ? box.getBoundingClientRect().bottom + scrollY : (rectOf(edge) || { bottom: 0 }).bottom;
      window.scrollTo({ top: bottom - innerHeight + 200, behavior: 'instant' });
    };
    toEnd();
    const t0 = performance.now();
    const limit = reason ? FILL_WAIT.load : FILL_WAIT.probe;
    let result = '';
    let nudges = 0;
    let pressed = false;
    while (performance.now() - t0 < limit) {
      if (!pressed) {
        if (!btn || !btn.isConnected) btn = moreButton(S.items);
        if (btn) {
          btn.click();
          pressed = true;
        }
      }
      await wait(120);
      if (token !== S.fillToken) { result = 'cancelled'; break; }
      refresh();
      if (S.items.length > before) { result = 'grew'; break; }
      // The end was already in view, so the page saw nothing change;
      // scroll away and back.
      if (nudges < 2 && performance.now() - t0 > 900 * (nudges + 1)) {
        nudges++;
        window.scrollBy({ top: -innerHeight, behavior: 'instant' });
        await wait(120);
        toEnd();
      }
    }
    endFill(token, slow);
    if (!result) {
      result = 'end';
      GROW.endAt = S.items.length;
    }
    return result;
  }

  // ---------- Amazon ----------
  //
  // A card: data-testid="product-card" holding two product-card-link anchors
  // (the photo; then the badges, a price-section with screen-reader text such
  // as "Deal Price: $24.99 Typical: $59.99", and the title in a <p>), then
  // review-value and a hidden "4,652 global ratings" line.
  //
  // The same grid (data-testid="discount-asin-grid") backs every deals page
  // seen so far: /events/devicedeals/, /blackfriday/ and /blackfriday/3/
  // (2026-11-24; /deals and /gp/goldbox redirect to /blackfriday this week).
  // Elsewhere on Amazon (product pages, search, the cart) this adapter finds
  // nothing and the generic ones get a look; if Amazon renames these test
  // ids, the deals grid still pages as a generic virtualized grid.

  const AMAZON_HOST = /(^|\.)amazon\.[a-z.]+$/i.test(location.hostname);
  const amazonGrid = () => document.querySelector('[data-testid="discount-asin-grid"]');
  const AMZ = makeReg('asin:');
  const PRICE = PRICE_SRC;

  // The page's filter (bubble-id, department...) without the paging state
  // Amazon writes into the URL as the grid scrolls.
  function amazonCtx() {
    const p = new URLSearchParams(location.search);
    for (const k of [...p.keys()]) if (/^(promotionsSearch|ref_?$|pd_rd|pf_rd|_encoding|content-id)/i.test(k)) p.delete(k);
    return location.pathname + '?' + p;
  }

  // Amazon image URLs carry their size as a modifier; ask for a big one.
  const amazonImg = (u) => u.replace(/\._[^/]*_\.(jpe?g|png|webp)(\?.*)?$/i, '._AC_SL1000_.$1');

  function amazonItem(card, asin) {
    const url = `${location.origin}/dp/${asin}`;
    const tp = card.querySelector('a[data-testid="product-card-link"] p, a[href*="/dp/"] p') || card.querySelector('p');
    const im = card.querySelector('img');
    const title = srText(tp) || (im && clean(im.alt)) || 'Item';

    const badges = uniq([...card.querySelectorAll('[role="presentation"]')].map(srText).filter((t) => t && t.length < 40));
    const priceBox = card.querySelector('[data-testid="price-section"]');
    let ps = srText(priceBox);
    if (!priceBox) ps = [...card.querySelectorAll('.a-price .a-offscreen')].map((e) => e.textContent).join(' ');
    const pm = ps.match(new RegExp(`^(?:\\D*?:\\s*)?(${PRICE}(?:\\s*[-–]\\s*${PRICE})?)`));
    const om = ps.match(new RegExp(`(?:typical|list|was|regular)\\D*?(${PRICE})`, 'i')) || (!priceBox && ps.match(new RegExp(`${PRICE}\\s+(${PRICE})`)));
    const price = pm ? pm[1].replace(/\s/g, '') : '';
    const old = om ? om[1].replace(/\s/g, '') : '';
    const note = savingsNote(price, old, badges.some((b) => b.includes('%')));

    const rv = card.querySelector('[data-testid="review-value"]');
    const global = [...card.querySelectorAll('span')].map((s) => clean(s.textContent)).find((t) => /^[\d,]+ global ratings?$/i.test(t));
    const countLink = card.querySelector('[data-testid="review-count-link"]');
    const count = global ? global.replace(/\s*global\s*/i, ' ') : countLink ? clean(countLink.textContent).replace(/[()]/g, '') + ' ratings' : '';
    const rating = rv ? clean(rv.textContent) : '';
    const lede = rating || count ? [{ text: ['★ ' + (rating || '–'), count].filter(Boolean).join(' · '), href: url + '#customerReviews' }] : [];

    return {
      key: 'asin:' + asin,
      head: card,
      anchor: card,
      blocks: [card],
      links: [],
      title: title.slice(0, 220),
      deck: badges.join(' · '),
      category: '',
      list: null,
      rel: null,
      card: {
        img: im ? amazonImg(bestSrc(im)) : '',
        titleHref: url,
        review: url + '#customerReviews',
        buys: price || old ? [{ href: url, old, price, label: 'on Amazon', note }] : [{ href: url, old: '', price: '', label: 'See it on Amazon', note: '' }],
        lede,
        body: [],
        cache: new Map(),
      },
    };
  }

  function amazonItems() {
    const ctx = amazonCtx();
    if (ctx !== AMZ.ctx) regReset(AMZ, ctx);
    const scope = amazonGrid();
    if (!scope) return [];
    const seen = [];
    for (const card of scope.querySelectorAll('[data-testid="product-card"]')) {
      if (card.closest(EXCLUDED)) continue;
      const r = card.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      const a = card.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      const m = a && a.href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/i);
      const holder = card.closest('[data-asin]');
      const asin = m ? m[1].toUpperCase() : holder ? holder.getAttribute('data-asin') : '';
      if (!asin) continue;
      seen.push(seenAt(AMZ, card, asin, r));
    }
    return regMerge(AMZ, seen, (s) => amazonItem(s.card, s.id)) || amazonItems();
  }

  // Amazon's "View more deals" button: on /blackfriday/3/ (2026-11-24) the
  // grid stopped loading on scroll at 208 deals and put this under the last
  // row. A click loads the next batch in place, same URL.
  function amazonMoreButton() {
    const g = amazonGrid();
    const b = g && g.querySelector('[data-testid="load-more-view-more-button"]');
    return b && !b.disabled && b.getClientRects().length ? b : null;
  }

  // ---------- the Times' gift guide ----------

  // The Times' Holiday Gift Guide (nytimes.com/interactive/2026/us/
  // wirecutter-holiday-gift-guide.html, inspected 2026-11-24) is an
  // interactive page, not Wirecutter's own markup. Each gift is a div with
  // data-category and data-featured attributes (its class names are
  // build-hashed) holding the photo, an h2 tagline wrapped in the buy link, a
  // paragraph that names the product in <strong>, a byline, sometimes a
  // "Read More" review link, and one "Buy for $175 at REI" link. The page
  // draws 8 gifts, then 8 more each time the end of the grid scrolls into
  // view, keeping the ones already drawn (growFill); "Showing 324 gifts"
  // above the grid is the total (countTotal). The category and price filters
  // are left alone: the pager follows whatever the grid shows.

  function guideItems() {
    const out = [];
    for (const card of document.querySelectorAll('[data-category][data-featured]')) {
      if (card.closest(EXCLUDED) || !isVisible(card)) continue;
      const tag = card.querySelector(ANY_HEADING);
      // The tagline's own link goes where the buy button does.
      const links = uniq(buyLinksIn([card]).filter((a) => !a.querySelector(ANY_HEADING)));
      if (!tag || !links.length) continue;
      // The product's name, in bold in the first paragraph. ("Read More" is
      // bold too, further down.)
      const first = card.querySelector('p');
      const strong = first && first.querySelector('strong, b');
      const product = strong ? clean(strong.textContent) : '';
      const tagline = clean(tag.textContent);
      const named = product.length > 2 && product.length < 120;
      out.push({
        head: card,
        anchor: null, // the write-up goes under the buy button, as on Wirecutter
        blocks: [card],
        links,
        title: (named ? product : tagline).slice(0, 160),
        deck: named ? tagline.slice(0, 200) : '',
        category: '',
      });
    }
    return out;
  }

  // ---------- generic ----------

  const GV = makeReg('url:');

  // The page's filter, without paging and tracking state written into the URL.
  function listCtx() {
    const p = new URLSearchParams(location.search);
    for (const k of [...p.keys()]) if (/^(page|p|start|offset|promotionsSearch|ref_?$|pd_rd|pf_rd|_encoding|content-id|utm_)/i.test(k)) p.delete(k);
    return location.pathname + '?' + p;
  }

  // A virtualized grid found by findGrid. Once found, its cards are read by
  // their signature inside the list on later passes, so the grid needn't be
  // found afresh as it redraws.
  function virtualItems(again = false) {
    const ctx = listCtx();
    if (ctx !== GV.ctx) regReset(GV, ctx);
    const schema = schemaHints();
    let members;
    if (GV.list && GV.list.isConnected && GV.msig) {
      members = [];
      for (const e of GV.list.getElementsByTagName(GV.tag)) {
        if (e.parentElement && sigOf(e) === GV.msig && sigOf(e.parentElement) === GV.psig) {
          const info = memberInfo(e, schema);
          if (info.main) members.push({ m: e, info });
        }
      }
    } else {
      if (GV.reg.size) regReset(GV, ctx);
      const g = gridOnce();
      if (!g || !isVirtual(g)) return [];
      members = g.members;
      GV.tag = g.members[0].m.tagName;
      GV.msig = sigOf(g.members[0].m);
      GV.psig = sigOf(g.members[0].m.parentElement);
    }
    const seen = [];
    for (const { m, info } of members) {
      const r = m.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      seen.push({ ...seenAt(GV, m, info.key, r), info });
    }
    const items = regMerge(GV, seen, (s) => {
      const it = gridItem(s.card, s.info);
      it.key = 'url:' + s.id;
      extract(it); // read it now; the page may drop the card later
      return it;
    });
    return items || (again ? [] : virtualItems(true));
  }

  function genericItems() {
    const ed = editorialItems(findRoot());
    const g = gridOnce();
    if (g && !isVirtual(g) && (ed.length < 3 || g.members.length >= ed.length * 1.5)) {
      return g.members.map(({ m, info }) => gridItem(m, info));
    }
    return ed;
  }

  // ---------- adapters ----------
  //
  // An adapter: id; match() (cheap: is this its kind of page?); items() (an
  // array, [] to hand over to the next adapter); and, all optional:
  //   min        fewest items that count without an explicit start (default 1)
  //   live       re-read on every key (the page redraws as it scrolls)
  //   registry() its virtual-list registry (positions, done, swaps)
  //   fill(dir)  draw or load more past an end: 'grew' | 'end' | 'cancelled' | ''
  //   grows      'always' | 'signals' (see growFill) | false
  //   counts     look for the page's own count ("Showing 324 gifts")
  //   count(n)   the counter's total; allText(n) the "that's all" toast
  //   noun       what to call the items in toasts ("deals")
  //   reviewWhat what r opens ("the reviews")
  //   onResize() the window changed width

  const ADAPTERS = [
    {
      id: 'amazon',
      noun: 'deals',
      live: true,
      reviewWhat: 'the reviews',
      match: () => AMAZON_HOST,
      items: amazonItems,
      registry: () => AMZ,
      fill: (dir) => regFill(AMZ, dir, amazonMoreButton, { load: 'Loading more deals…', draw: 'Loading…' }),
      allText: (n) => `That’s all ${n} deals on this page`,
      // A new width reflows the grid, so the kept positions are wrong; read
      // it afresh (the current deal is found again by its ASIN).
      onResize: () => regReset(AMZ, amazonCtx()),
    },
    {
      id: 'gift-guide',
      noun: 'gifts',
      grows: 'always',
      counts: true,
      match: () => !!document.querySelector('[data-category][data-featured]'),
      items: guideItems,
      fill: growFill,
    },
    {
      id: 'wirecutter',
      grows: false,
      match: () => !!document.querySelector('.global-cob'),
      items: () => wirecutterCards(findRoot()),
    },
    {
      id: 'generic-virtual',
      min: 2,
      live: true,
      match: () => true,
      items: () => virtualItems(),
      registry: () => GV,
      fill: (dir) => regFill(GV, dir, () => moreButton(S.items), { load: `Loading more ${nounOf()}…`, draw: 'Loading…' }),
      onResize: () => regReset(GV, GV.ctx),
    },
    {
      id: 'generic',
      min: 2,
      grows: 'signals',
      counts: true,
      match: () => true,
      items: genericItems,
      fill: growFill,
    },
  ];

  let explicitStart = false;
  function detect() {
    pass++;
    for (const a of ADAPTERS) {
      if (!a.match()) continue;
      const items = a.items();
      if (!items.length || items.length < (S.active || explicitStart ? 1 : a.min || 1)) continue;
      S.adapter = a;
      if (a.counts) countTotal(items);
      return items;
    }
    S.adapter = null;
    return [];
  }

  const nounOf = (a = S.adapter) => (a && a.noun) || GROW.noun || 'items';
  const regOf = (a = S.adapter) => (a && a.registry ? a.registry() : null);

  async function fill(dir) {
    if (S.filling || !S.adapter || !S.adapter.fill) return '';
    return S.adapter.fill(dir);
  }

  // Nothing more will come past the last item.
  function allLoaded() {
    const a = S.adapter;
    if (!a) return false;
    const R = regOf(a);
    if (R) return R.done;
    return a.grows ? growDone() : false;
  }

  // ---------- card contents ----------

  function bestSrc(img) {
    const cands = [];
    const add = (set) => {
      for (const part of (set || '').split(/,\s+/)) {
        const [u, d = ''] = part.trim().split(/\s+/);
        if (u && !u.startsWith('data:')) cands.push({ u, w: d.endsWith('w') ? parseFloat(d) : d.endsWith('x') ? parseFloat(d) * 600 : 0 });
      }
    };
    add(img.getAttribute('srcset'));
    add(img.dataset.srcset);
    const pic = img.closest('picture');
    if (pic) for (const s of pic.querySelectorAll('source')) add(s.getAttribute('srcset'));
    for (const u of [img.getAttribute('src'), img.dataset.src, img.currentSrc]) if (u && !u.startsWith('data:')) cands.push({ u, w: 0 });
    if (!cands.length) return img.currentSrc || img.src;
    const big = cands.filter((c) => c.w >= 900).sort((a, b) => a.w - b.w)[0];
    const pick = big || cands.sort((a, b) => b.w - a.w)[0];
    try { return new URL(pick.u, location.href).href; } catch { return img.src; }
  }

  function noteFor(a, cache) {
    let e = a.parentElement;
    for (let i = 0; e && i < 4; i++, e = e.parentElement) {
      if (new Set(buyLinksIn([e]).map((x) => x.href)).size > 1) break;
      const m = textOf(e, cache).match(SAVE_RE);
      if (m) return clean(m[0]);
    }
    return '';
  }

  // A card's sale and former prices: a struck-through or "was"-classed
  // price, or one labelled typical/list/was/RRP, is the old one; the first
  // other price is the price; a schema.org offer stands in for a missing one.
  const OLD_LABEL = /(?:typical|list|was|regular|rrp|original|orig\.?|before|compare at|reg\.?)\s*(?:price)?\s*:?\s*$/i;
  function pricesOf(blocks, offer) {
    const live = blocks.filter((b) => b.isConnected);
    let old = '';
    for (const b of live) {
      for (const e of b.querySelectorAll('del, s, strike, [class*="strike" i], [class*="was" i], [class*="old-price" i], [class*="original" i], [class*="compare" i], [class*="list-price" i]')) {
        const m = srText(e).match(PRICE_RE);
        if (m) { old = m[0]; break; }
      }
      if (old) break;
    }
    const text = live.map(srText).join(' ');
    let price = '';
    for (const m of text.matchAll(PRICE_G)) {
      const before = text.slice(Math.max(0, m.index - 28), m.index);
      if (!old && OLD_LABEL.test(before)) { old = m[0]; continue; }
      if (m[0] === old || OLD_LABEL.test(before) || /\bsave\s*(?:up to)?\s*$/i.test(before)) continue;
      if (!price) price = m[0];
    }
    if (!price && offer) price = offer;
    const sm = text.match(SAVE_RE);
    return { price, old: old !== price ? old : '', note: sm ? clean(sm[0]) : '' };
  }

  const ownTextLen = (el) => {
    let n = 0;
    for (const c of el.childNodes) if (c.nodeType === 3) n += c.textContent.trim().length;
    return n;
  };

  const LEADING_PRICE = new RegExp(`^(${PRICE_SRC})\\s*(.*)$`);
  const TWO_PRICES = new RegExp(`^(${PRICE_SRC})\\s+(${PRICE_SRC}.*)$`);
  const BUY_FOR = new RegExp(`^(?:buy|shop)\\s+(?:it\\s+)?for\\s+(${PRICE_SRC})\\s*(.*)$`, 'i');
  const SAVE_START = new RegExp(`^(?:you save|save\\s+(?:up to\\s+)?(?:${PRICE_SRC}|\\d+%))`, 'i');

  function extract(it) {
    if (it.card) return it.card;
    const cache = new Map();
    const blocks = it.blocks.filter((b) => b.isConnected);
    const all = blocks.flatMap((b) => [b, ...b.querySelectorAll('*')]);

    let img = null;
    let area = 0;
    for (const e of all) {
      if (e.tagName !== 'IMG') continue;
      const r = e.getBoundingClientRect();
      const w = r.width || +e.getAttribute('width') || 0;
      const h = r.height || +e.getAttribute('height') || 0;
      if (w < 90 || h < 60) continue;
      if (w * h > area) { img = e; area = w * h; }
    }

    const head = it.head;
    const th = head && (head.matches(ANY_HEADING + ', strong, b, a') ? head : head.querySelector(ANY_HEADING));
    const ta = th && (th.closest('a[href]') || th.querySelector('a[href]'));

    const buys = [];
    const seen = new Set();
    for (const a of it.links) {
      if (seen.has(a.href) || a.closest(ANY_HEADING)) continue;
      const full = textOf(a, cache);
      if (!full || full.toLowerCase() === it.title.toLowerCase()) continue;
      seen.add(a.href);
      const del = a.querySelector('del, s, strike');
      let old = del ? textOf(del, cache) : '';
      let rest = del ? textOf(a, cache, del) : full;
      if (!old) {
        const m = rest.match(TWO_PRICES);
        if (m) { old = m[1]; rest = m[2]; }
      }
      // "Buy for $175 at REI" (the gift guide) reads as "$175" "at REI".
      const bf = rest.match(BUY_FOR);
      if (bf) rest = bf[1] + ' ' + bf[2];
      const pm = rest.match(LEADING_PRICE);
      buys.push({ href: a.href, old, price: pm ? pm[1] : '', label: pm ? pm[2] : rest, note: noteFor(a, cache) });
      if (buys.length >= 6) break;
    }
    // A shop's own grid has no buy links, only the product's page: one button
    // to it, with the card's prices.
    if (!buys.length && it.main) {
      const pp = pricesOf(blocks, it.offer);
      buys.push({ href: it.main, old: pp.old, price: pp.price, label: (pp.price ? 'at ' : 'See it at ') + siteName(), note: pp.note || savingsNote(pp.price, pp.old, false) });
    }

    const TEXT = 'p, li, blockquote, dd';
    const picked = [];
    const seenText = new Set();
    for (const e of all) {
      if (!(e.matches(TEXT) || ownTextLen(e) >= 40)) continue;
      if (picked.some((p) => p.contains(e))) continue;
      if (e.closest(ANY_HEADING + ', button, [role="button"], figcaption, del, s')) continue;
      const a = e.closest('a[href]');
      if (a && isBuyLink(a)) continue;
      if (!e.matches(TEXT) && e.querySelector(TEXT)) continue;
      if (hiddenEl(e, cache)) continue;
      const text = textOf(e, cache);
      if (!text || seenText.has(text) || SAVE_START.test(text) || text.toLowerCase() === it.title.toLowerCase() || text === it.deck) continue;
      const lt = buyLinksIn([e]).map((x) => textOf(x, cache)).join(' ');
      if (lt && text.length - lt.length < 20) continue;
      seenText.add(text);
      picked.push(e);
    }
    const inAnchor = (e) => it.anchor && it.anchor.contains(e);

    // The full review: a "Read more: …" link, else a link to a review page
    // on the site itself ("/wirecutter/reviews/…", "/product-reviews/…") or
    // to the reviews on the product's page.
    const links = all.filter((e) => e.tagName === 'A' && /^https?:/i.test(e.href) && !isBuyLink(e));
    const readMore =
      links.find((a) => /^read more/i.test(clean((a.closest('p, li, div') || a).textContent)) || /^read more/i.test(clean(a.textContent))) ||
      links.find((a) => sameSite(a.hostname) && /(^|[/-])reviews?\//i.test(a.pathname)) ||
      links.find((a) => /^#(customer)?reviews?\b/i.test(a.hash));

    it.card = {
      img: img ? bestSrc(img) : '',
      titleHref: ta ? ta.href : it.main || '',
      review: readMore ? readMore.href : '',
      buys,
      lede: picked.filter(inAnchor),
      body: picked.filter((e) => !inAnchor(e)),
      cache,
    };
    return it.card;
  }

  // A safe copy of a paragraph: text, links and simple emphasis only.
  function inline(el, cache) {
    const frag = document.createDocumentFragment();
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { frag.append(n.textContent); continue; }
      if (n.nodeType !== 1 || hiddenEl(n, cache)) continue;
      const tag = n.tagName.toLowerCase();
      if (['script', 'style', 'svg', 'img', 'picture', 'button', 'noscript', 'iframe'].includes(tag)) continue;
      if (tag === 'a') {
        const href = n.href || '';
        if (/^https?:/i.test(href)) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener';
          a.append(inline(n, cache));
          frag.append(a);
        } else frag.append(inline(n, cache));
      } else if (['strong', 'b', 'em', 'i', 's', 'del', 'sup', 'sub', 'code'].includes(tag)) {
        const e = document.createElement(tag);
        e.append(inline(n, cache));
        frag.append(e);
      } else if (tag === 'br') frag.append(document.createElement('br'));
      else frag.append(inline(n, cache));
    }
    return frag;
  }

  // ---------- state ----------

  const S = {
    items: [],
    idx: -1,
    active: false,
    view: 'card',
    starredOnly: false,
    stars: {},
    sig: '',
    path: '',
    target: 0,
    settleUntil: 0,
    timer: 0,
    filling: false,
    fillToken: 0,
    fillDir: 0,
    adapter: null,
  };
  const allEls = document.getElementsByTagName('*');

  const keyOf = (it) => it.key || it.title.toLowerCase();
  const isStarred = (it) => !!S.stars[keyOf(it)];
  const starKey = () => 'df:stars:' + location.origin + location.pathname;

  function refresh() {
    if (location.pathname !== S.path) {
      S.path = location.pathname;
      S.stars = {};
      loadStars();
    }
    // A live list (Amazon's grid) redraws as it scrolls, so read it every time.
    const sig = location.href + '|' + allEls.length;
    if (!(S.adapter && S.adapter.live) && sig === S.sig && S.items.length) return;
    S.sig = sig;
    const cur = S.items[S.idx];
    const prevAdapter = S.adapter;
    const prevCount = S.items.length;
    S.items = detect();
    if (S.adapter !== prevAdapter || GROW.href !== location.href) {
      GROW.href = location.href;
      GROW.endAt = -1;
      GROW.grew = false;
      GROW.endPress = null;
    } else if (!S.filling && prevCount > 0 && S.items.length > prevCount && !regOf()) {
      GROW.grew = true; // the page appended items by itself as you scrolled
    }
    if (cur) {
      let i = S.items.findIndex((it) => it === cur || (cur.key && it.key === cur.key));
      // Swapped out for another colour of the same product: follow the swap.
      const R = regOf();
      for (let k = R && cur.key && R.replaced.get(cur.key), n = 0; i < 0 && k && n < 5; k = R.replaced.get(k), n++) {
        i = S.items.findIndex((it) => it.key === k);
      }
      if (i < 0) i = S.items.findIndex((it) => it.head === cur.head);
      S.idx = i >= 0 ? i : Math.min(S.idx, S.items.length - 1);
    }
  }

  // chrome.storage.local only; outside the extension (or once it has been
  // reloaded under the page) stars last for this page view.
  const hasChromeStorage = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const memory = {};
  const store = {
    get(k) {
      return new Promise((res) => {
        try {
          if (hasChromeStorage()) chrome.storage.local.get(k, (o) => res(o && o[k]));
          else res(memory[k] === undefined ? null : memory[k]);
        } catch { res(memory[k] === undefined ? null : memory[k]); }
      });
    },
    set(k, v) {
      memory[k] = v;
      try {
        if (hasChromeStorage()) chrome.storage.local.set({ [k]: v });
      } catch { /* storage unavailable: lasts for this page view only */ }
    },
  };

  function loadStars() {
    const path = S.path;
    store.get(starKey()).then((v) => {
      if (path !== S.path) return;
      S.stars = Object.assign(v || {}, S.stars);
      if (S.active) render();
    });
  }
  // The view is not remembered: every page starts in card view, and v
  // switches it for that page only. Versions up to 2.0.0 saved the choice,
  // so one stray v left every page in page view; drop what they saved.
  try { if (hasChromeStorage()) chrome.storage.local.remove('df:view'); } catch { /* nothing to drop */ }

  // ---------- geometry (page view) ----------

  function rectOf(it) {
    if (it.rel) return regRect(it); // drawn or not
    let t = Infinity, l = Infinity, b = -Infinity, r = -Infinity;
    for (const bl of it.blocks) {
      if (!bl.isConnected) continue;
      const rc = bl.getBoundingClientRect();
      if (!rc.width && !rc.height) continue;
      t = Math.min(t, rc.top); l = Math.min(l, rc.left);
      b = Math.max(b, rc.bottom); r = Math.max(r, rc.right);
    }
    if (t === Infinity) return null;
    return { top: t + scrollY, left: l + scrollX, bottom: b + scrollY, right: r + scrollX };
  }

  // Combined height of fixed or sticky bars stacked against the top edge.
  function topInset() {
    const host = ui && ui.host;
    if (host) host.style.display = 'none';
    let inset = 0;
    const seen = new Set();
    for (let y = 1; y < innerHeight * 0.4 && y <= inset + 12; y += 6) {
      for (const x of [innerWidth / 2, innerWidth / 4]) {
        for (const hit of document.elementsFromPoint(x, y)) {
          let bar = null;
          for (let e = hit; e && e !== document.documentElement; e = e.parentElement) {
            const pos = getComputedStyle(e).position;
            if (pos === 'fixed' || pos === 'sticky') { bar = e; break; }
          }
          if (!bar) continue;
          if (!seen.has(bar)) {
            seen.add(bar);
            const r = bar.getBoundingClientRect();
            if (r.top <= y && r.bottom < innerHeight * 0.4) inset = Math.max(inset, r.bottom);
          }
          break;
        }
      }
    }
    if (host) host.style.display = '';
    return inset;
  }

  // Page view hides the page's own fixed and sticky bars (site header,
  // "Browse" bar, newsletter banners) so nothing covers the item; they come
  // back when the pager closes or switches to card view.
  const hiddenBars = new Map();
  function hideBars() {
    const host = ui && ui.host;
    const it = S.items[S.idx];
    const style = new Map();
    const pos = (e) => {
      if (!style.has(e)) style.set(e, getComputedStyle(e).position);
      return style.get(e);
    };
    const ys = [];
    for (let y = 2; y < innerHeight * 0.35; y += 14) ys.push(y);
    for (let y = innerHeight - 2; y > innerHeight * 0.65; y -= 14) ys.push(y);
    for (const y of ys) {
      for (const x of [innerWidth * 0.1, innerWidth / 2, innerWidth * 0.9]) {
        for (const hit of document.elementsFromPoint(x, y).slice(0, 4)) {
          if (host && (hit === host || host.contains(hit))) continue;
          let bar = null;
          for (let e = hit; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
            const p = pos(e);
            if (p !== 'fixed' && p !== 'sticky') continue;
            const r = e.getBoundingClientRect();
            if (r.height < innerHeight * 0.4 && !(it && it.blocks.some((b) => e.contains(b)))) bar = e;
          }
          if (bar && !hiddenBars.has(bar)) {
            hiddenBars.set(bar, [bar.style.getPropertyValue('visibility'), bar.style.getPropertyPriority('visibility')]);
            bar.style.setProperty('visibility', 'hidden', 'important');
          }
        }
      }
    }
  }

  function restoreBars() {
    for (const [bar, [v, p]] of hiddenBars) {
      if (v) bar.style.setProperty('visibility', v, p);
      else bar.style.removeProperty('visibility');
    }
    hiddenBars.clear();
  }

  const PAD = 12;

  function scrollToItem(it) {
    const rc = rectOf(it);
    if (!rc) return;
    if (S.view === 'page') hideBars();
    S.target = topInset() + 16;
    window.scrollTo({ top: rc.top - PAD - S.target, behavior: 'instant' });
    if (S.view !== 'page') return;
    hideBars(); // bars that only appear once scrolled
    const t2 = topInset() + 16;
    if (t2 !== S.target) {
      S.target = t2;
      window.scrollTo({ top: rectOf(it).top - PAD - S.target, behavior: 'instant' });
    }
    S.settleUntil = performance.now() + 1500;
  }

  // Lazy images and sliding header bars move things after a jump; follow.
  function tick() {
    if (!S.active || S.view !== 'page') return;
    const it = S.items[S.idx];
    if (!it) return;
    if (performance.now() < S.settleUntil) {
      hideBars();
      S.target = topInset() + 16;
      const rc = rectOf(it);
      if (rc && Math.abs(rc.top - PAD - scrollY - S.target) > 3) {
        window.scrollTo({ top: rc.top - PAD - S.target, behavior: 'instant' });
      }
    }
    place();
  }

  function nearest(dir) {
    const y = scrollY + topInset() + 16;
    const tops = S.items.map((it) => (rectOf(it) || { top: Infinity }).top);
    if (dir > 0) {
      const i = tops.findIndex((t) => t >= y - 30);
      return i === -1 ? S.items.length - 1 : i;
    }
    let i = 0;
    tops.forEach((t, k) => { if (t < y - 30) i = k; });
    return i;
  }

  function offscreen(it) {
    const rc = rectOf(it);
    return !rc || rc.bottom < scrollY || rc.top > scrollY + innerHeight;
  }

  // ---------- UI ----------

  let ui = null;
  const SANS = 'nyt-franklin, "Franklin Fallback Helvetica", -apple-system, BlinkMacSystemFont, "Helvetica Neue", helvetica, sans-serif';
  const SERIF = 'nyt-imperial, "Imperial Fallback Georgia", georgia, serif';

  function buildUI() {
    const host = document.createElement('deal-flash');
    host.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    // A fixed template: nothing from the page goes into it.
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }

        .spot { position: absolute; border-radius: 14px; pointer-events: none;
          box-shadow: 0 0 0 2px rgba(255,255,255,.85), 0 0 0 200vmax rgba(18,18,22,.82); }
        .badge { position: absolute; top: -14px; right: -14px; width: 30px; height: 30px; border-radius: 50%;
          background: #f6b600; color: #1a1a1a; font: 17px/30px ${SANS}; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.35); }

        .backdrop { position: fixed; inset: 0; background: rgba(14,14,18,.88); }
        .panel { position: fixed; left: 50%; top: calc(50% - 22px); transform: translate(-50%, -50%);
          width: min(1280px, 95vw); max-height: calc(100vh - 100px); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin;
          background: #fff; color: #121212; border-radius: 20px; box-shadow: 0 30px 90px rgba(0,0,0,.55); }
        .card { display: grid; grid-template-columns: minmax(0, 45fr) minmax(0, 55fr); gap: clamp(28px, 4vw, 64px);
          padding: clamp(28px, 4vw, 60px); align-items: center; animation: df-in .14s ease-out; }
        .card.noimg { grid-template-columns: minmax(0, 1fr); max-width: 920px; margin: 0 auto; }
        @keyframes df-in { from { opacity: 0; transform: translateY(10px); } }
        .media { display: flex; align-items: center; justify-content: center; align-self: start; position: sticky; top: 0; }
        .media img { display: block; width: 100%; max-height: calc(100vh - 220px); object-fit: contain; }
        .cat { font: 700 clamp(12px, 1vw, 14px)/1.2 ${SANS}; letter-spacing: .1em; text-transform: uppercase; color: #8a8a8a; margin: 0 0 14px; }
        .deck { font: 800 clamp(18px, 1.6vw, 23px)/1.3 ${SANS}; color: #3a3a3a; margin: 0 0 10px; }
        .title { font: 700 clamp(32px, 3.4vw, 52px)/1.08 ${SANS}; letter-spacing: -.01em; margin: 0 0 18px; color: #121212; }
        .title.long { font-size: clamp(26px, 2.5vw, 38px); line-height: 1.15; }
        .title.longer { font-size: clamp(22px, 2vw, 30px); line-height: 1.2; }
        .title a { color: inherit; text-decoration: none; }
        .title a:hover { text-decoration: underline; }
        .lede { font: 500 clamp(19px, 1.6vw, 24px)/1.45 ${SANS}; color: #333; margin: 0 0 14px; }
        .lede s, .lede del { color: #888; }
        .buys { display: flex; flex-direction: column; gap: 12px; margin: 22px 0 26px; max-width: 560px; }
        .buy { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-radius: 12px; background: #121212; color: #fff;
          text-decoration: none; font: 700 clamp(18px, 1.5vw, 22px)/1.25 ${SANS}; }
        .buy:hover { background: #333; }
        .buy kbd { flex: none; width: 28px; height: 28px; border-radius: 7px; background: rgba(255,255,255,.16); color: #fff;
          font: 700 15px/28px ${SANS}; text-align: center; }
        .buy .txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .buy s { font-weight: 400; color: #aaa; }
        .buy .note { font-weight: 500; font-size: .72em; color: #8fe3a2; }
        .body p { font: 400 clamp(20px, 1.6vw, 24px)/1.6 ${SERIF}; color: #222; margin: 0 0 .9em; }
        .lede a, .body a { color: inherit; text-decoration: underline; text-decoration-color: #bbb; text-underline-offset: 3px; }
        kbd.key { display: inline-block; margin-left: 10px; padding: 3px 8px; border-radius: 6px; background: #ececec; color: #555;
          font: 700 14px/1 ${SANS}; vertical-align: 3px; }
        .cardstar { position: absolute; top: 18px; right: 18px; width: 40px; height: 40px; border-radius: 50%; z-index: 1;
          background: #f6b600; color: #1a1a1a; font: 22px/40px ${SANS}; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
        /* Narrower windows: stack the photo above the text so neither is cramped. */
        @media (max-width: 980px) {
          .card { grid-template-columns: minmax(0, 1fr); gap: 24px; }
          .media { position: static; }
          .media img { width: auto; max-width: 100%; max-height: 36vh; }
          .info { max-width: 720px; }
        }

        .hud { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: min(820px, calc(100vw - 24px));
          display: flex; align-items: center; gap: 12px; padding: 9px 18px; border-radius: 999px;
          background: rgba(30,30,34,.96); color: #fff; font: 13px/1.2 ${SANS}; box-shadow: 0 6px 24px rgba(0,0,0,.35); white-space: nowrap; }
        .count { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 15px; }
        .title-h { overflow: hidden; text-overflow: ellipsis; color: #e8e8ea; min-width: 0; }
        .tag { color: #f6b600; font-weight: 600; }
        .hint { color: #9a9aa2; }
        .toast { position: fixed; left: 50%; bottom: 66px; transform: translateX(-50%); padding: 8px 14px; border-radius: 10px;
          background: #f6b600; color: #1a1a1a; font: 600 13px ${SANS}; box-shadow: 0 6px 20px rgba(0,0,0,.3); transition: opacity .25s; }
        .help { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 380px; padding: 22px 26px;
          border-radius: 16px; background: #fff; color: #1a1a1a; font: 14px/1.4 ${SANS}; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
        .help h2 { margin: 0 0 12px; font-size: 17px; }
        .help table { border-collapse: collapse; width: 100%; }
        .help td { padding: 4px 0; vertical-align: top; }
        .help td:first-child { width: 86px; }
        .help kbd { display: inline-block; min-width: 22px; padding: 1px 6px; border: 1px solid #ccc; border-bottom-width: 2px;
          border-radius: 5px; background: #f6f6f6; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; }
      </style>
      <div class="spot" hidden><div class="badge" hidden>★</div></div>
      <div class="backdrop" hidden></div>
      <div class="panel" hidden><div class="cardstar" hidden>★</div><div class="content"></div></div>
      <div class="toast" hidden></div>
      <div class="hud" hidden>
        <span class="count"></span><span class="tag"></span><span class="title-h"></span>
        <span class="hint">j/k · 1 buy · r review · s star · v view · ? keys</span>
      </div>
      <div class="help" hidden>
        <h2>Deal Flash</h2>
        <table>
          <tr><td><kbd>j</kbd> <kbd>k</kbd></td><td>Next / previous item</td></tr>
          <tr><td><kbd>g</kbd> <kbd>G</kbd></td><td>First / last item</td></tr>
          <tr><td><kbd>1</kbd>–<kbd>9</kbd></td><td>Open that buy button in a background tab</td></tr>
          <tr><td><kbd>o</kbd> <kbd>O</kbd></td><td>Open the first one (O switches to it)</td></tr>
          <tr><td><kbd>r</kbd> <kbd>R</kbd></td><td>Go to the item’s full review or its reviews (R opens it in the background)</td></tr>
          <tr><td><kbd>s</kbd></td><td>Star / unstar (gift idea)</td></tr>
          <tr><td><kbd>f</kbd></td><td>Only page through starred items</td></tr>
          <tr><td><kbd>c</kbd></td><td>Copy starred items as a list</td></tr>
          <tr><td><kbd>v</kbd></td><td>Card view / page view</td></tr>
          <tr><td><kbd>space</kbd></td><td>Scroll a long card</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Turn the pager off</td></tr>
        </table>
      </div>`;
    document.documentElement.appendChild(host);
    ui = {
      host,
      spot: root.querySelector('.spot'),
      badge: root.querySelector('.badge'),
      backdrop: root.querySelector('.backdrop'),
      panel: root.querySelector('.panel'),
      content: root.querySelector('.content'),
      cardStar: root.querySelector('.cardstar'),
      hud: root.querySelector('.hud'),
      count: root.querySelector('.count'),
      tag: root.querySelector('.tag'),
      title: root.querySelector('.title-h'),
      toast: root.querySelector('.toast'),
      help: root.querySelector('.help'),
      cardHead: null,
    };
    ui.backdrop.addEventListener('click', deactivate);
    ui.backdrop.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  function newTabLink(href) {
    const a = el('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  function renderCard(it) {
    const c = extract(it);
    const card = el('div', 'card' + (c.img ? '' : ' noimg'));
    if (c.img) {
      const media = el('div', 'media');
      const im = el('img');
      im.src = c.img;
      im.alt = '';
      media.append(im);
      card.append(media);
    }
    const info = el('div', 'info');
    if (it.category) info.append(el('div', 'cat', it.category));
    if (it.deck) info.append(el('div', 'deck', it.deck));
    const h = el('h1', 'title' + (it.title.length > 130 ? ' longer' : it.title.length > 70 ? ' long' : ''));
    if (c.titleHref) {
      const a = newTabLink(c.titleHref);
      a.textContent = it.title;
      h.append(a);
    } else h.textContent = it.title;
    info.append(h);
    for (const p of c.lede) {
      const e = el('p', 'lede');
      if (p instanceof Element) e.append(inline(p, c.cache));
      else if (p.href) {
        const a = newTabLink(p.href);
        a.textContent = p.text;
        e.append(a);
      } else e.textContent = p.text;
      info.append(e);
    }
    if (c.buys.length) {
      const box = el('div', 'buys');
      c.buys.forEach((b, i) => {
        const a = newTabLink(b.href);
        a.className = 'buy';
        a.append(el('kbd', '', String(i + 1)));
        const txt = el('span', 'txt');
        const label = el('span');
        if (b.old) label.append(el('s', '', b.old), ' ');
        if (b.price) label.append(el('b', '', b.price), ' ');
        label.append(b.label);
        txt.append(label);
        if (b.note) txt.append(el('span', 'note', b.note));
        a.append(txt);
        box.append(a);
      });
      info.append(box);
    }
    if (c.body.length) {
      const body = el('div', 'body');
      for (const p of c.body) {
        const e = el('p');
        e.append(inline(p, c.cache));
        body.append(e);
      }
      info.append(body);
    }
    const reviewLink = c.review && [...info.querySelectorAll('.lede a, .body a')].find((a) => a.href === c.review);
    if (reviewLink) reviewLink.after(el('kbd', 'key', 'r'));
    card.append(info);
    ui.content.replaceChildren(card);
    ui.panel.scrollTop = 0;
    ui.cardHead = it.head;
    preload();
  }

  // The next photos, from the page's own image URLs, so paging doesn't wait.
  const preloaded = new Set();
  function preload() {
    for (const d of [1, 2, -1]) {
      const it = S.items[S.idx + d];
      if (!it) continue;
      const src = extract(it).img;
      if (src && !preloaded.has(src)) {
        preloaded.add(src);
        new Image().src = src;
      }
    }
  }

  function place() {
    const it = S.items[S.idx];
    const rc = it && rectOf(it);
    if (!rc) { ui.spot.hidden = true; return; }
    Object.assign(ui.spot.style, {
      top: rc.top - PAD + 'px',
      left: rc.left - PAD + 'px',
      width: rc.right - rc.left + PAD * 2 + 'px',
      height: rc.bottom - rc.top + PAD * 2 + 'px',
    });
    ui.spot.hidden = false;
  }

  // The counter's total. A virtual list (Amazon): "44+" while it may have
  // more to load past the ones read so far. A growing list: the page's own
  // count ("324") while more are still to be drawn, else "24+" while there's
  // reason to expect more (see growFill).
  function countLabel() {
    const n = S.items.length;
    const a = S.adapter;
    if (!a) return String(n);
    if (a.count) return a.count(n);
    const R = regOf(a);
    if (R) return n + (R.done ? '' : '+');
    if (!a.grows || growDone()) return String(n);
    if (GROW.total > n) return String(GROW.total);
    if (a.grows === 'always' || GROW.grew || moreButton(S.items)) return n + '+';
    return String(n);
  }

  function render() {
    if (!ui) buildUI();
    if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);
    const it = S.items[S.idx];
    const on = S.active && !!it;
    ui.host.dataset.view = S.view;
    ui.host.dataset.active = on ? '1' : '';
    if (!on) {
      ui.spot.hidden = ui.hud.hidden = ui.help.hidden = ui.backdrop.hidden = ui.panel.hidden = true;
      restoreBars();
      return;
    }
    const starredCount = S.items.filter(isStarred).length;
    ui.count.textContent = `${S.idx + 1} / ${countLabel()}`;
    ui.tag.textContent = (S.starredOnly ? '★ only' : '') + (starredCount ? `${S.starredOnly ? ' · ' : ''}★ ${starredCount}` : '');
    ui.title.textContent = it.title;
    ui.host.dataset.index = String(S.idx);
    ui.host.dataset.title = it.title;
    ui.host.dataset.adapter = S.adapter ? S.adapter.id : '';
    ui.hud.hidden = false;
    if (S.view === 'card') {
      restoreBars();
      ui.spot.hidden = true;
      ui.backdrop.hidden = ui.panel.hidden = false;
      if (ui.cardHead !== it.head || !ui.content.firstChild) renderCard(it);
      ui.cardStar.hidden = !isStarred(it);
    } else {
      ui.backdrop.hidden = ui.panel.hidden = true;
      ui.badge.hidden = !isStarred(it);
      place();
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    if (!ui) buildUI();
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    ui.toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ui.toast.style.opacity = '0';
      toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 260);
    }, 1600);
  }

  // ---------- actions ----------

  function activate() {
    S.active = true;
    clearInterval(S.timer);
    S.timer = setInterval(tick, 200);
  }

  function deactivate() {
    S.active = false;
    clearInterval(S.timer);
    render();
  }

  function go(i) {
    S.idx = i;
    scrollToItem(S.items[i]);
    render();
  }

  const allowed = (it) => !S.starredOnly || isStarred(it);

  async function step(dir) {
    for (let i = S.idx + dir; i >= 0 && i < S.items.length; i += dir) {
      if (allowed(S.items[i])) return go(i);
    }
    // Have the page draw or load what's past this end, then try again.
    const r = S.starredOnly ? '' : await fill(dir);
    if (r === 'grew') return S.active && step(dir);
    if (r === 'cancelled' || !S.active) return;
    const a = S.adapter;
    if (dir > 0 && allLoaded()) toast(a && a.allText ? a.allText(S.items.length) : `That’s all ${S.items.length} ${nounOf(a)}`);
    else toast(dir > 0 ? 'Last item' : 'First item');
    go(S.idx);
  }

  function jump(dir) {
    const order = S.items.map((_, i) => i);
    if (dir > 0) order.reverse();
    const i = order.find((k) => allowed(S.items[k]));
    if (i !== undefined) go(i);
  }

  function setView(v) {
    S.view = v;
    scrollToItem(S.items[S.idx]);
    render();
    toast(v === 'card' ? 'Card view' : 'Page view');
  }

  function priceOf(it) {
    const b = extract(it).buys[0];
    if (b && b.price) return b.price;
    const m = it.blocks.map((x) => x.innerText || '').join(' ').match(PRICE_RE);
    return m ? m[0].replace(/\s+/g, ' ') : '';
  }

  const firstHref = (it) => {
    const b = extract(it).buys[0];
    return b ? b.href : it.links[0] ? it.links[0].href : it.main || '';
  };

  function toggleStar() {
    const it = S.items[S.idx];
    const k = keyOf(it);
    if (S.stars[k]) {
      delete S.stars[k];
      toast('Unstarred');
    } else {
      S.stars[k] = { title: it.title, url: firstHref(it), price: priceOf(it), t: Date.now() };
      toast('★ Starred');
    }
    store.set(starKey(), S.stars);
    render();
  }

  function toggleStarredOnly() {
    if (!S.starredOnly && !S.items.some(isStarred)) return toast('No starred items yet (press s)');
    S.starredOnly = !S.starredOnly;
    if (S.starredOnly && !isStarred(S.items[S.idx])) {
      const next = S.items.findIndex((it, i) => i > S.idx && isStarred(it));
      go(next >= 0 ? next : S.items.findIndex(isStarred));
    } else render();
    toast(S.starredOnly ? 'Starred items only' : 'All items');
  }

  function copyStarred() {
    const starred = S.items.filter(isStarred);
    const extra = Object.keys(S.stars).filter((k) => !S.items.some((it) => keyOf(it) === k)).map((k) => S.stars[k]);
    const rows = [...starred.map((it) => ({ title: it.title, url: firstHref(it), price: priceOf(it) })), ...extra];
    if (!rows.length) return toast('No starred items yet (press s)');
    const lines = rows.map((r) => `- ${r.url ? `[${r.title}](${r.url})` : r.title}${r.price ? ` (${r.price})` : ''}`);
    const text = `${clean(document.title)}\n${location.href}\n\n${lines.join('\n')}\n`;
    const done = () => toast(`Copied ${rows.length} starred item${rows.length === 1 ? '' : 's'}`);
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      ok ? done() : toast('Copy failed');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, legacy);
    else legacy();
  }

  function openUrl(href, active) {
    try {
      chrome.runtime.sendMessage({ type: 'df-open', url: href, active });
    } catch {
      // Extension context gone (extension reloaded) or running outside one.
      window.open(href, '_blank', 'noopener');
    }
  }

  function openLink(n, active) {
    const it = S.items[S.idx];
    const buys = extract(it).buys;
    const href = buys[n] ? buys[n].href : n === 0 ? firstHref(it) : '';
    if (!href) return toast(n === 0 ? 'No link on this item' : `No button ${n + 1} on this item`);
    openUrl(href, active);
    const where = buys[n] && buys[n].label ? ` (${buys[n].label.replace(/^(see it\s+)?(from|at|on)\s+/i, '')})` : '';
    toast((active ? 'Opening' : 'Opened in a background tab') + where);
  }

  // A new tab rather than this one, so the list keeps your place.
  function openReview(active) {
    const href = extract(S.items[S.idx]).review;
    if (!href) return toast('No “Read more” link on this item');
    openUrl(href, active);
    const what = (S.adapter && S.adapter.reviewWhat) || 'the review';
    toast(active ? `Opening ${what}` : `Opened ${what} in a background tab`);
  }

  // ---------- starting ----------

  // Turn the pager on at the item nearest the scroll position, as the first
  // j does. The popup or toolbar button calls this through window.__df.start
  // ({ explicit: true }); then, and only then, a page with nothing to page
  // through says so. Returns whether the pager is on.
  function start(opts = {}) {
    const explicit = !!(opts && opts.explicit);
    if (S.filling) cancelFill();
    explicitStart = explicit;
    try {
      S.sig = '';
      refresh();
    } finally {
      explicitStart = false;
    }
    if (!S.items.length) {
      if (explicit) toast('Deal Flash: no items found on this page');
      return false;
    }
    if (S.active) {
      render();
      return true;
    }
    activate();
    const i = nearest(1);
    S.idx = i;
    if (S.starredOnly && !isStarred(S.items[i])) step(1);
    else go(i);
    return true;
  }

  // ---------- keys ----------

  function typing(e) {
    const t = e.composedPath()[0];
    if (!(t instanceof Element)) return false;
    return t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  }

  const KEYS = new Set(['j', 'k', 'g', 'G', 'o', 'O', 'r', 'R', 's', 'f', 'c', 'v', '?', 'Escape', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  const SCROLL_KEYS = new Set([' ', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']);

  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || typing(e)) return;
    const k = e.key;

    // A long card scrolls inside its panel, not the page behind it.
    if (S.active && S.view === 'card' && SCROLL_KEYS.has(k)) {
      const page = ui.panel.clientHeight * 0.85;
      const dy = { ' ': e.shiftKey ? -page : page, ArrowDown: 90, ArrowUp: -90, PageDown: page, PageUp: -page }[k];
      ui.panel.scrollBy({ top: dy, behavior: 'smooth' });
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!KEYS.has(k)) { S.settleUntil = 0; return; }
    if (!S.active && k !== 'j' && k !== 'k') return;
    if (S.filling) {
      // Waiting on the page from the last press. Another press the same way
      // is dropped; any other key stops the wait and goes ahead.
      if ((k === 'j' && S.fillDir > 0) || (k === 'k' && S.fillDir < 0)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      cancelFill();
    }

    refresh();
    // Nothing to page through: j and k stay the page's own, silently.
    if (!S.items.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();

    if (k === 'Escape') {
      if (ui && !ui.help.hidden) ui.help.hidden = true;
      else deactivate();
      return;
    }
    if (k === '?') {
      if (ui) ui.help.hidden = !ui.help.hidden;
      return;
    }

    const lost = S.idx < 0 || S.idx >= S.items.length || (S.view === 'page' && offscreen(S.items[S.idx]));
    if (!S.active || lost) {
      // Start (or resync) from wherever the reader has scrolled to.
      const fresh = !S.active;
      activate();
      if (k === 'j' || k === 'k') {
        const i = nearest(k === 'j' ? 1 : -1);
        if (fresh || i !== S.idx) {
          S.idx = i;
          if (S.starredOnly && !isStarred(S.items[i])) return step(k === 'j' ? 1 : -1);
          return go(i);
        }
      }
    }

    if (/^[1-9]$/.test(k)) return openLink(+k - 1, false);
    switch (k) {
      case 'j': return step(1);
      case 'k': return step(-1);
      case 'g': return jump(-1);
      case 'G': return jump(1);
      case 'o': return openLink(0, false);
      case 'O': return openLink(0, true);
      case 'r': return openReview(true);
      case 'R': return openReview(false);
      case 's': return toggleStar();
      case 'f': return toggleStarredOnly();
      case 'c': return copyStarred();
      case 'v': return setView(S.view === 'card' ? 'page' : 'card');
    }
  }

  const stopSettle = () => { S.settleUntil = 0; };
  let lastWidth = innerWidth;
  const onResize = () => {
    if (innerWidth !== lastWidth) for (const a of ADAPTERS) if (a.onResize) a.onResize();
    lastWidth = innerWidth;
    if (S.active && S.view === 'page') place();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('wheel', stopSettle, { passive: true, capture: true });
  window.addEventListener('touchmove', stopSettle, { passive: true, capture: true });
  window.addEventListener('resize', onResize);

  // Lets a fresh copy (a re-inject) replace this one cleanly.
  window.__dfTeardown = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('wheel', stopSettle, { capture: true });
    window.removeEventListener('touchmove', stopSettle, { capture: true });
    window.removeEventListener('resize', onResize);
    clearInterval(S.timer);
    clearTimeout(toastTimer);
    S.fillToken++;
    S.filling = false;
    S.active = false;
    restoreBars();
    if (ui) ui.host.remove();
  };
  window.__df = { start, detect, extract, state: S, adapter: () => (S.adapter ? S.adapter.id : '') };})();
