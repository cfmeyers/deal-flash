// Deal Flash service worker.
//
// - Opens buy links in new tabs for pager.js (content scripts can't open
//   background tabs themselves).
// - "Start on any page": the keyboard command and the popup's button inject
//   pager.js into the active tab (activeTab + scripting) and start it.
// - "Always on" sites: one dynamic content script per granted https origin.
//   The rule is simple: a site is always on exactly when the extension holds
//   a specific host permission for it. Granting (from the popup, or from the
//   site-access settings in chrome://extensions) registers the script;
//   revoking it anywhere unregisters it. reconcile() enforces that rule and
//   runs on install, update, browser start and every permission change.

const SCRIPT_PREFIX = 'df:';

// Wrapped so test/shell.cjs can stand in for a revoked permission (there is
// no way to revoke one from puppeteer). Production code always goes through
// these.
const perms = {
  contains: (p) => chrome.permissions.contains(p),
  getAll: () => chrome.permissions.getAll(),
  remove: (p) => chrome.permissions.remove(p),
};

// ---------- built-in sites (the manifest's static content scripts) ----------

const builtinPatterns = () =>
  (chrome.runtime.getManifest().content_scripts || []).flatMap((cs) => cs.matches || []);

// A match pattern ("https://www.amazon.com/*") as a RegExp over full URLs.
const patternRegExp = (pattern) => {
  const m = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
  if (!m) return /$^/;
  const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const scheme = m[1] === '*' ? 'https?' : m[1];
  const host = m[2] === '*' ? '[^/]+' : m[2].startsWith('*.') ? `(?:[^/]+\\.)?${esc(m[2].slice(2))}` : esc(m[2]);
  const path = esc(m[3]).replace(/\*/g, '.*');
  return new RegExp(`^${scheme}://${host}(?::\\d+)?${path}$`);
};

const isBuiltinUrl = (url) => builtinPatterns().some((p) => patternRegExp(p).test(url));

// Pages no extension may script, even with permission.
const isStoreUrl = (u) =>
  u.hostname === 'chromewebstore.google.com' || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));

// ---------- always-on sites ----------

const originFor = (host) => `https://${host}/*`;
const hostOf = (origin) => (/^https:\/\/([^/]+)\/\*$/.exec(origin) || [])[1];

// Origins that count as an always-on site: a specific https host (or
// *.host, which chrome://extensions lets a user type), not every site and
// not one of the built-in patterns.
const isSiteOrigin = (origin) => {
  const host = hostOf(origin);
  return !!host && host !== '*' && !builtinPatterns().includes(origin);
};

const validHost = (host) => typeof host === 'string' && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host);

// Serialises register/unregister so overlapping events (the popup's add plus
// permissions.onAdded) can't race into a duplicate-id error.
let chain = Promise.resolve();
const locked = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

async function registered() {
  const all = await chrome.scripting.getRegisteredContentScripts();
  return all.filter((s) => s.id.startsWith(SCRIPT_PREFIX));
}

async function register(host) {
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_PREFIX + host,
      matches: [originFor(host)],
      js: ['pager.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

const unregister = (ids) => (ids.length ? chrome.scripting.unregisterContentScripts({ ids }) : Promise.resolve());

function reconcile() {
  return locked(async () => {
    const regs = await registered();
    const drop = [];
    for (const s of regs) {
      const host = s.id.slice(SCRIPT_PREFIX.length);
      if (!validHost(host) || !(await perms.contains({ origins: [originFor(host)] }))) drop.push(s.id);
    }
    await unregister(drop);
    const have = new Set(regs.map((s) => s.id).filter((id) => !drop.includes(id)));
    const { origins = [] } = await perms.getAll();
    for (const o of origins) {
      if (!isSiteOrigin(o)) continue;
      const host = hostOf(o);
      if (validHost(host) && !have.has(SCRIPT_PREFIX + host)) {
        await register(host);
        have.add(SCRIPT_PREFIX + host);
      }
    }
  });
}

async function listSites() {
  return (await registered()).map((s) => s.id.slice(SCRIPT_PREFIX.length)).sort();
}

// Called by the popup after chrome.permissions.request() resolved true.
// Registers the script and loads the pager into the current tab now, so j
// works without a reload. (If the popup closed while the permission prompt
// was up, permissions.onAdded -> reconcile() registers it instead.)
async function addSite(host, tabId) {
  if (!validHost(host)) return { ok: false, error: 'bad host' };
  if (!(await perms.contains({ origins: [originFor(host)] }))) return { ok: false, error: 'no permission' };
  await locked(async () => {
    if (!(await registered()).some((s) => s.id === SCRIPT_PREFIX + host)) await register(host);
  });
  if (typeof tabId === 'number') await ensureInjected(tabId).catch(() => {});
  return { ok: true };
}

async function removeSite(host) {
  if (!validHost(host)) return { ok: false, error: 'bad host' };
  await locked(() => unregister([SCRIPT_PREFIX + host]).catch(() => {}));
  // Fails harmlessly when the origin is only covered by a broader grant.
  await perms.remove({ origins: [originFor(host)] }).catch(() => false);
  return { ok: true };
}

// ---------- start on any page ----------

async function hasPager(tabId) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__df });
  return !!(r && r.result);
}

// Injecting twice is safe but loses the pager's state, so only inject when
// it isn't there.
async function ensureInjected(tabId) {
  if (await hasPager(tabId)) return false;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['pager.js'] });
  return true;
}

async function startInTab(tabId) {
  try {
    const injected = await ensureInjected(tabId);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const df = window.__df;
        if (!df) return 'missing';
        if (typeof df.start !== 'function') return 'no-start';
        df.start({ explicit: true });
        return 'started';
      },
    });
    const result = r && r.result;
    return { ok: result !== 'missing', result, injected };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// A brief mark on the toolbar icon when the shortcut can't run on this page
// (chrome://, the Web Store, ...), since there's no page to show a toast in.
function flashBadge(tabId) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#b3261e' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '×' }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}

async function onCommand(command, tab) {
  if (command !== 'start-pager') return null;
  let tabId = tab && tab.id;
  if (typeof tabId !== 'number') {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = t && t.id;
  }
  if (typeof tabId !== 'number') return null;
  const r = await startInTab(tabId);
  if (!r.ok) flashBadge(tabId);
  return r;
}

// ---------- what the popup shows ----------

// What the extension can do on a page, from its URL. No URL means no access
// to the tab: chrome://, arc://, file:// and other pages activeTab doesn't
// cover.
function classifyUrl(url, sites = []) {
  let u = null;
  try {
    u = url ? new URL(url) : null;
  } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || isStoreUrl(u)) return { kind: 'unsupported' };
  const host = u.hostname;
  if (isBuiltinUrl(u.href)) return { kind: 'builtin', host };
  const https = u.protocol === 'https:';
  return { kind: 'site', host, https, canAlwaysOn: https && validHost(host), alwaysOn: sites.includes(host) };
}

async function pageInfo(tabId) {
  const sites = await listSites();
  let url;
  try {
    url = (await chrome.tabs.get(tabId)).url;
  } catch {}
  return { ...classifyUrl(url, sites), sites, builtins: builtinPatterns() };
}

// ---------- wiring ----------

const fromExtensionPage = (sender) =>
  sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Opens an item's buy link in a new tab next to the tab it came from.
  if (msg.type === 'df-open') {
    if (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url)) return;
    const props = { url: msg.url, active: !!msg.active };
    if (sender.tab) {
      props.index = sender.tab.index + 1;
      props.openerTabId = sender.tab.id;
    }
    chrome.tabs.create(props);
    return;
  }

  // Everything else comes from the popup only, never from a page.
  if (!fromExtensionPage(sender)) return;
  const reply = (p) => {
    p.then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  };
  switch (msg.type) {
    case 'df-info': return reply(pageInfo(msg.tabId));
    case 'df-start': return reply(startInTab(msg.tabId));
    case 'df-site-add': return reply(addSite(msg.host, msg.tabId));
    case 'df-site-remove': return reply(removeSite(msg.host));
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  onCommand(command, tab);
});

const reconcileQuietly = () => reconcile().catch((e) => console.warn('Deal Flash: reconcile failed', e));
chrome.permissions.onAdded.addListener(reconcileQuietly);
chrome.permissions.onRemoved.addListener(reconcileQuietly);
chrome.runtime.onInstalled.addListener(reconcileQuietly);
chrome.runtime.onStartup.addListener(reconcileQuietly);

// For test/shell.cjs, which drives these from the service worker.
self.dfShell = { perms, reconcile, listSites, addSite, removeSite, startInTab, onCommand, pageInfo, classifyUrl };
