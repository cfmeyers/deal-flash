// Tests the extension "shell" around pager.js: the manifest, the service
// worker's start-on-any-page and always-on logic, and the popup.
//
//   node test/shell.cjs
//
// Like run.cjs, pages come from request interception and every hostname
// resolves to nothing, so no request leaves the machine.
//
// Puppeteer can't click the toolbar icon, press a browser shortcut or answer
// a permission prompt, and without one of those activeTab grants nothing. So
// most checks run against a temporary copy of the extension whose manifest
// adds host_permissions ["https://*/*", "http://*/*"] (and nothing else); background.js and
// popup.js are byte-for-byte the shipped files. The shipped manifest itself
// is loaded first to check that it installs, wires up the command and the
// built-in sites, and can NOT script an arbitrary site on its own.
//
// Not covered here (see the manual checklist): the real toolbar click and
// shortcut, the permission prompt, revoking a permission in the browser's own
// UI, and registrations surviving a browser restart (puppeteer loads the
// unpacked extension afresh on every launch, which clears them).
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const EXT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures ----------

const swatch = (label, color) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220"><rect width="100%" height="100%" fill="${color}"/><text x="20" y="50" font-size="32" fill="#fff" font-family="sans-serif">${label}</text></svg>`)}`;
// A small shop's deals page: headings, photos and retailer buy links, which
// the pager's generic heading strategy finds.
const dealsPage = (title) => `<!doctype html><html><head><title>${title}</title></head>
<body style="font:16px sans-serif;max-width:640px;margin:0 auto"><h1>${title}</h1>${Array.from(
  { length: 5 },
  (_, i) => `<h3>Shell Product ${i + 1}</h3><img width="400" height="220" alt="" src="${swatch(`Item ${i + 1}`, ['#e4572e', '#29335c', '#f3a712', '#669bbc', '#8e6c88'][i])}">
  <p>An invented product blurb for item ${i + 1}.</p><p><a href="https://www.target.com/p/shell-${i}">$${20 + i} from Target</a></p>`,
).join('')}</body></html>`;
const plainPage = (title) => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Nothing to page through.</p></body></html>`;

function servePage(page, html) {
  return page.setRequestInterception(true).then(() =>
    page.on('request', (req) => {
      const u = req.url();
      if (!/^https?:/.test(u)) return req.continue();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        return req.respond({ status: 200, contentType: 'text/html', body: typeof html === 'function' ? html(u) : html });
      }
      req.abort();
    }),
  );
}

// ---------- browser helpers ----------

async function launch(extDir, userDataDir) {
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [extDir],
    userDataDir,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1100,800'],
    defaultViewport: { width: 1100, height: 800 },
  });
  if (process.env.DEBUG) {
    browser.on('targetcreated', (t) => console.log('  [target+]', t.type(), t.url().slice(0, 80)));
    browser.on('targetdestroyed', (t) => console.log('  [target-]', t.type(), t.url().slice(0, 80)));
  }
  const isSw = (t) => t.type() === 'service_worker' && t.url().endsWith('/background.js');
  const target = await browser.waitForTarget(isSw, { timeout: 10000 });
  const id = new URL(target.url()).host;
  // Chrome stops an idle service worker even with puppeteer attached, so
  // re-attach (waking it with an extension page) whenever it has gone.
  let worker = await target.worker();
  const attach = async () => {
    let t = browser.targets().find(isSw);
    if (!t) {
      const waker = await browser.newPage();
      await waker.goto(`chrome-extension://${id}/manifest.json`).catch(() => {});
      await waker.evaluate(() => chrome.runtime.sendMessage({ type: 'wake' }).catch(() => {})).catch(() => {});
      t = await browser.waitForTarget(isSw, { timeout: 10000 });
      await waker.close();
    }
    return t.worker();
  };
  const sw = {
    async evaluate(fn, ...args) {
      for (let i = 0; ; i++) {
        try {
          return await worker.evaluate(fn, ...args);
        } catch (e) {
          if (i >= 2 || !/detached|closed|not available|destroyed/i.test(e.message)) throw e;
          worker = await attach();
        }
      }
    },
  };
  // onInstalled's reconcile may still be running; let it settle.
  await sleep(300);
  return { browser, sw, id };
}

// Opens url in a new tab and returns { page, tabId }. The tab id comes from
// the service worker: the one tab that wasn't there before.
async function openTab(browser, sw, url, html) {
  const before = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t) => t.id));
  const page = await browser.newPage();
  if (html) await servePage(page, html);
  await page.goto(url, { waitUntil: 'load' }).catch(() => {});
  await sleep(250);
  const tabId = await sw.evaluate(async (b) => (await chrome.tabs.query({})).map((t) => t.id).find((id) => !b.includes(id)), before);
  return { page, tabId };
}

const pagerIn = (sw, tabId) =>
  sw.evaluate(
    async (tabId) => {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => (window.__df ? { tag: window.__df.__testTag || null, start: typeof window.__df.start } : null) });
        return r.result;
      } catch (e) {
        return { error: e.message };
      }
    },
    tabId,
  );

const pagerActive = (page) => page.evaluate(() => {
  const h = document.querySelector('deal-flash');
  return !!h && h.dataset.active === '1';
});

const registrations = (sw) => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches, js: s.js, runAt: s.runAt, persist: s.persistAcrossSessions })));

// ---------- 1. static checks ----------

function pngSize(file) {
  const b = fs.readFileSync(file);
  return b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}

function staticChecks() {
  console.log('\nmanifest and files');
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  ok(m.manifest_version === 3 && /^\d+\.\d+\.\d+$/.test(m.version), `MV3, version ${m.version}`);
  ok(m.description.length <= 132, `description is ${m.description.length} chars (limit 132)`);
  ok(!/wirecutter|amazon|times/i.test(m.name + m.description), 'no third-party names in name or description');
  ok(JSON.stringify(m.permissions.slice().sort()) === JSON.stringify(['activeTab', 'scripting', 'storage']), `permissions ${JSON.stringify(m.permissions)}`);
  ok(!m.host_permissions, 'no required host_permissions');
  ok(JSON.stringify(m.optional_host_permissions) === '["https://*/*"]', 'optional host permissions: https only');
  ok(!JSON.stringify(m).includes('<all_urls>'), 'no <all_urls> anywhere');
  for (const set of [m.icons, m.action.default_icon]) {
    for (const [size, file] of Object.entries(set)) {
      const dims = pngSize(path.join(EXT, file));
      ok(dims && dims[0] === +size && dims[1] === +size, `${file} is ${dims && dims.join('x')}`);
    }
  }
  ok(fs.existsSync(path.join(EXT, m.action.default_popup)), `popup ${m.action.default_popup} exists`);
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  ok(scripts.length > 0 && scripts.every((s) => /\bsrc=/.test(s[1]) && !s[2].trim()), 'popup has no inline script');
  ok(!/\son[a-z]+=/i.test(html), 'popup has no inline event handlers');
  const code = ['background.js', 'popup.js', 'popup.html', 'popup.css'].map((f) => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n');
  ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\/(?!\$\{host\}|\*\/|www\.amazon|www\.nytimes)[a-z]/i.test(code.replace(/\/\/.*$/gm, '')), 'no network calls or remote URLs in the shell code');
  return m;
}

// ---------- 2. the shipped manifest ----------

async function shippedChecks() {
  console.log('\nshipped manifest, loaded as is');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shell-'));
  const { browser, sw } = await launch(EXT, dir);
  try {
    ok(true, 'extension loads and its service worker starts');
    const cmds = await sw.evaluate(() => new Promise((r) => chrome.commands.getAll(r)));
    const cmd = cmds.find((c) => c.name === 'start-pager');
    ok(cmd && cmd.shortcut, `command start-pager registered with shortcut "${cmd && cmd.shortcut}"`);
    const granted = await sw.evaluate(() => chrome.permissions.getAll());
    ok(!granted.origins.some((o) => o === 'https://*/*' || o === '<all_urls>'), `granted origins at install: ${JSON.stringify(granted.origins)}`);
    ok((await sw.evaluate(() => self.dfShell.listSites())).length === 0, 'no always-on sites after install');

    const site = await openTab(browser, sw, 'https://shop.example/deals/', dealsPage('Shop deals'));
    const r = await sw.evaluate((t) => self.dfShell.startInTab(t), site.tabId);
    ok(!r.ok && /permission|access/i.test(r.error || ''), `without activeTab, start on an arbitrary site is refused (${r.error})`);
    const info = await sw.evaluate((t) => self.dfShell.pageInfo(t), site.tabId);
    ok(info.kind === 'unsupported', 'and the popup has no URL for it (no tabs permission, no activeTab grant)');

    // Static content-script matches don't give the worker host access (only
    // the click's activeTab grant does), so look for the content script's
    // isolated world over CDP instead of asking the worker.
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', (e) => worlds.push(e.context.name));
    await cdp.send('Runtime.enable');
    await servePage(page, plainPage('Amazon product'));
    await page.goto('https://www.amazon.com/gp/product-page/', { waitUntil: 'load' });
    await sleep(400);
    ok(worlds.includes('Deal Flash'), `a built-in site gets pager.js from the static content script (worlds: ${JSON.stringify(worlds)})`);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 3. the test copy: start, always on, reconcile ----------

function testCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-ext-'));
  for (const f of fs.readdirSync(EXT)) {
    if (['.git', 'test', 'node_modules', 'shots'].includes(f) || f.startsWith('.')) continue;
    fs.cpSync(path.join(EXT, f), path.join(dir, f), { recursive: true });
  }
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions = ['https://*/*', 'http://*/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

async function startChecks(browser, sw) {
  console.log('\nstart on any page (service worker)');
  const a = await openTab(browser, sw, 'https://shop.example/deals/', dealsPage('Shop deals'));
  ok((await pagerIn(sw, a.tabId)) === null, 'a non-built-in site has no pager before start');
  let r = await sw.evaluate((t) => self.dfShell.startInTab(t), a.tabId);
  ok(r.ok && r.injected, `first start injects pager.js (${JSON.stringify(r)})`);
  const p = await pagerIn(sw, a.tabId);
  ok(p && !p.error, 'window.__df exists in the isolated world afterwards');
  if (r.result === 'started') ok(await pagerActive(a.page), 'window.__df.start() turned the pager on');
  else console.log(`  note pager.js has no window.__df.start yet (result "${r.result}"): injection only`);

  // Second start must not re-inject (that would drop the pager's state).
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__df.__testTag = 'first-copy'; } });
  }, a.tabId);
  r = await sw.evaluate((t) => self.dfShell.startInTab(t), a.tabId);
  ok(r.ok && !r.injected && (await pagerIn(sw, a.tabId)).tag === 'first-copy', 'second start reuses the loaded pager');

  const b = await openTab(browser, sw, 'https://other.example/list/', dealsPage('Other list'));
  r = await sw.evaluate((t) => self.dfShell.onCommand('start-pager', { id: t }), b.tabId);
  ok(r && r.ok && r.injected, 'the keyboard command takes the same path');
  r = await sw.evaluate((t) => self.dfShell.onCommand('something-else', { id: t }), b.tabId);
  ok(r === null, 'other commands are ignored');

  const c = await openTab(browser, sw, 'chrome://version/');
  r = await sw.evaluate((t) => self.dfShell.onCommand('start-pager', { id: t }), c.tabId);
  ok(r && !r.ok, `the command fails cleanly on chrome:// (${r && r.error})`);
  const badge = await sw.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), c.tabId);
  ok(badge === '×', 'and marks the toolbar icon');
  for (const t of [a, b, c]) await t.page.close();
}

async function alwaysOnChecks(browser, sw) {
  console.log('\nalways on (register / unregister / reconcile)');
  const a = await openTab(browser, sw, 'https://shop.example/deals/', dealsPage('Shop deals'));
  let r = await sw.evaluate((t) => self.dfShell.addSite('shop.example', t), a.tabId);
  ok(r.ok, 'addSite(shop.example)');
  let regs = await registrations(sw);
  const reg = regs.find((s) => s.id === 'df:shop.example');
  ok(
    reg && JSON.stringify(reg.matches) === '["https://shop.example/*"]' && JSON.stringify(reg.js) === '["pager.js"]' && reg.runAt === 'document_idle' && reg.persist === true,
    `registered ${JSON.stringify(reg)}`,
  );
  ok((await pagerIn(sw, a.tabId)) !== null, 'and loaded the pager into the current tab right away');
  r = await sw.evaluate(() => self.dfShell.addSite('shop.example'));
  ok(r.ok && (await registrations(sw)).filter((s) => s.id === 'df:shop.example').length === 1, 'adding twice keeps one registration');
  await Promise.all([sw.evaluate(() => self.dfShell.reconcile()), sw.evaluate(() => self.dfShell.addSite('race.example'))]);
  ok((await registrations(sw)).filter((s) => s.id === 'df:race.example').length === 1, 'overlapping reconcile + add do not collide');
  await sw.evaluate(() => self.dfShell.removeSite('race.example'));

  const b = await openTab(browser, sw, 'https://shop.example/another-page/', dealsPage('Shop page two'));
  ok((await pagerIn(sw, b.tabId)) !== null, 'a fresh page on shop.example gets the pager by itself');
  await b.page.keyboard.press('j');
  await sleep(300);
  ok(await pagerActive(b.page), 'and j starts it there');
  const c = await openTab(browser, sw, 'https://nope.example/deals/', dealsPage('Elsewhere'));
  ok((await pagerIn(sw, c.tabId)) === null, 'another host does not');
  const www = await openTab(browser, sw, 'https://www.shop.example/deals/', dealsPage('www'));
  ok((await pagerIn(sw, www.tabId)) === null, 'nor does a subdomain (www.shop.example)');

  r = await sw.evaluate(() => self.dfShell.addSite('evil.example/../x'));
  ok(!r.ok, 'a malformed host is rejected');

  // The user revokes the permission (chrome://extensions, or the site-access
  // menu): onRemoved -> reconcile drops the registration.
  await sw.evaluate(() => {
    self.__realContains = self.dfShell.perms.contains;
    self.dfShell.perms.contains = async (p) => (p.origins[0] === 'https://shop.example/*' ? false : self.__realContains(p));
  });
  await sw.evaluate(() => self.dfShell.reconcile());
  ok(!(await registrations(sw)).some((s) => s.id === 'df:shop.example'), 'reconcile drops a site whose permission is gone');
  r = await sw.evaluate(() => self.dfShell.addSite('shop.example'));
  ok(!r.ok && r.error === 'no permission', 'and addSite refuses without the permission');
  await sw.evaluate(() => { self.dfShell.perms.contains = self.__realContains; });

  // A grant made outside the popup (chrome://extensions "specific sites", or
  // the popup closing while the prompt was up): onAdded -> reconcile
  // registers it. Built-in patterns and "all sites" are not sites.
  await sw.evaluate(() => {
    self.__realGetAll = self.dfShell.perms.getAll;
    self.dfShell.perms.getAll = async () => ({
      permissions: [],
      origins: ['https://*/*', 'https://www.amazon.com/*', 'https://www.nytimes.com/wirecutter/*', 'https://gear.example/*', 'https://*.sub.example/*', 'http://plain.example/*'],
    });
  });
  await sw.evaluate(() => self.dfShell.reconcile());
  regs = (await registrations(sw)).map((s) => s.id).sort();
  ok(JSON.stringify(regs) === '["df:*.sub.example","df:gear.example"]', `reconcile registers granted sites only: ${JSON.stringify(regs)}`);
  await sw.evaluate(() => { self.dfShell.perms.getAll = self.__realGetAll; });

  for (const h of ['gear.example', '*.sub.example']) await sw.evaluate((h) => self.dfShell.removeSite(h), h);
  ok((await registrations(sw)).length === 0, 'removeSite unregisters');
  const d = await openTab(browser, sw, 'https://gear.example/x/', dealsPage('Gear'));
  ok((await pagerIn(sw, d.tabId)) === null, 'and a removed site no longer gets the pager');
  for (const t of [a, b, c, www, d]) await t.page.close();
}

async function popupChecks(browser, sw, id) {
  console.log('\npopup');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'df-file-'));
  const localFile = path.join(scratch, 'deals.html');
  fs.writeFileSync(localFile, dealsPage('Local file'));

  await sw.evaluate(() => self.dfShell.addSite('shop.example'));
  const tabs = {
    builtin: await openTab(browser, sw, 'https://www.amazon.com/blackfriday/', plainPage('Built-in deals')),
    always: await openTab(browser, sw, 'https://shop.example/deals/', dealsPage('Shop deals')),
    site: await openTab(browser, sw, 'https://fresh.example/deals/', dealsPage('Fresh deals')),
    http: await openTab(browser, sw, 'http://plain.example/deals/', dealsPage('Plain deals')),
    chrome: await openTab(browser, sw, 'chrome://version/'),
    file: await openTab(browser, sw, `file://${localFile}`),
  };

  const popup = async (tabId) => {
    const p = await browser.newPage();
    await p.setViewport({ width: 320, height: 600 });
    await p.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`, { waitUntil: 'load' });
    await p.waitForFunction(() => document.body.dataset.kind, { timeout: 5000 }).catch(() => {});
    return p;
  };
  const view = (p) =>
    p.evaluate(() => {
      const vis = (id) => !document.getElementById(id).hidden && !document.getElementById(id).closest('[hidden]');
      return {
        kind: document.body.dataset.kind,
        status: document.getElementById('status').textContent,
        start: vis('start'),
        always: vis('always-row'),
        checked: document.getElementById('always').checked,
        note: vis('note') ? document.getElementById('note').textContent : null,
        sites: [...document.querySelectorAll('#sites li span')].map((s) => s.textContent),
        builtins: [...document.querySelectorAll('#builtins li')].map((li) => li.textContent),
        keys: document.querySelector('.keys').textContent.replace(/\s+/g, ' '),
        shortcut: document.getElementById('shortcut').textContent,
      };
    });

  let p = await popup(tabs.builtin.tabId);
  let v = await view(p);
  ok(v.kind === 'builtin' && v.start && !v.always && /by itself/.test(v.status), `built-in site: "${v.status}", start button, no toggle`);
  ok(v.builtins.length === 3 && v.builtins.every((b) => /built in$/.test(b)) && v.builtins.includes('www.amazon.combuilt in'), `built-in list: ${JSON.stringify(v.builtins)}`);
  ok(['j', 'k', 's', 'c', 'v', '?', 'Esc'].every((k) => v.keys.includes(k)), 'keys listed');
  ok(/starts it on any page/.test(v.shortcut), `shortcut line: "${v.shortcut}"`);
  if (process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, 'popup-builtin.png') });
  await p.close();

  p = await popup(tabs.always.tabId);
  v = await view(p);
  ok(v.kind === 'site' && v.always && v.checked && /Always on for shop\.example/.test(v.status), `always-on site: "${v.status}", toggle on`);
  ok(JSON.stringify(v.sites) === '["shop.example"]', `always-on list: ${JSON.stringify(v.sites)}`);
  for (const scheme of ['light', 'dark']) {
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(scheme === 'light' ? bg === 'rgb(255, 255, 255)' : bg !== 'rgb(255, 255, 255)', `${scheme} scheme background ${bg}`);
    if (process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, `popup-always-${scheme}.png`) });
  }
  await p.click('#sites button');
  await p.waitForFunction(() => document.querySelectorAll('#sites li').length === 0, { timeout: 3000 }).catch(() => {});
  v = await view(p);
  ok(v.sites.length === 0 && !v.checked && !(await registrations(sw)).some((s) => s.id === 'df:shop.example'), 'Remove unregisters the site and unticks the toggle');
  await p.close();

  p = await popup(tabs.site.tabId);
  v = await view(p);
  ok(v.kind === 'site' && v.start && v.always && !v.checked && /until you start it/.test(v.status), `plain https site: "${v.status}", toggle off`);
  // The test copy already holds https://*/*, so request() resolves without a
  // prompt; in the shipped build this is where the browser asks.
  await p.click('#always');
  await p.waitForFunction(() => document.getElementById('always').checked && document.querySelectorAll('#sites li').length === 1, { timeout: 3000 }).catch(() => {});
  v = await view(p);
  ok(v.checked && v.sites.includes('fresh.example') && (await registrations(sw)).some((s) => s.id === 'df:fresh.example'), 'ticking the toggle registers the site');
  ok((await pagerIn(sw, tabs.site.tabId)) !== null, 'and loads the pager into that tab');
  await p.click('#always');
  await p.waitForFunction(() => !document.getElementById('always').checked, { timeout: 3000 }).catch(() => {});
  ok(!(await registrations(sw)).some((s) => s.id === 'df:fresh.example'), 'unticking unregisters it');
  await p.close();

  p = await popup(tabs.always.tabId);
  await p.click('#start');
  await sleep(400);
  const started = await pagerIn(sw, tabs.always.tabId);
  ok(started !== null, 'the popup button loads the pager into its tab');
  if (started && started.start === 'function') ok(await pagerActive(tabs.always.page), 'and starts it');
  if (!p.isClosed()) await p.close();

  p = await popup(tabs.http.tabId);
  v = await view(p);
  ok(v.kind === 'site' && v.start && !v.always && /needs an https page/.test(v.note || ''), `http site: start button, no toggle, note "${v.note}"`);
  await p.close();

  for (const k of ['chrome', 'file']) {
    p = await popup(tabs[k].tabId);
    v = await view(p);
    ok(v.kind === 'unsupported' && !v.start && !v.always && /can't run on this page/.test(v.status), `${k} page: unsupported, no buttons`);
    if (k === 'chrome' && process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, 'popup-unsupported.png') });
    await p.close();
  }
  for (const t of Object.values(tabs)) await t.page.close();

  // The Web Store can't be opened under puppeteer (Chrome moves it to a
  // privileged process and the DevTools connection drops), so check the
  // classification the popup info is built from directly.
  const kinds = await sw.evaluate(() =>
    [
      'https://chromewebstore.google.com/detail/some-extension/abcdefghijklmnop',
      'https://chrome.google.com/webstore/detail/abc',
      'https://chrome.google.com/search?q=x',
      'chrome://extensions/',
      'arc://settings/',
      'file:///tmp/deals.html',
      undefined,
      'https://www.nytimes.com/wirecutter/deals/',
      'https://www.nytimes.com/2026/11/24/business/x.html',
    ].map((u) => self.dfShell.classifyUrl(u).kind),
  );
  ok(
    JSON.stringify(kinds) === JSON.stringify(['unsupported', 'unsupported', 'site', 'unsupported', 'unsupported', 'unsupported', 'unsupported', 'builtin', 'site']),
    `URL classification (Web Store x2, other google page, chrome://, arc://, file://, hidden, built-in path, other nytimes path): ${kinds.join(', ')}`,
  );
  fs.rmSync(scratch, { recursive: true, force: true });
}

(async () => {
  if (process.env.SHOTS) fs.mkdirSync(process.env.SHOTS, { recursive: true });
  staticChecks();
  await shippedChecks();

  const copy = testCopy();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-shell-'));
  const { browser, sw, id } = await launch(copy, dir);
  try {
    await startChecks(browser, sw);
    await alwaysOnChecks(browser, sw);
    await popupChecks(browser, sw, id);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(copy, { recursive: true, force: true });

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
