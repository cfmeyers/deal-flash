// Deal Flash popup. All the logic lives in background.js; this page shows
// what it reports and makes the one call that has to happen here:
// chrome.permissions.request(), which needs the click's user gesture.

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// The tab the popup is about. Normally the active tab; test/shell.cjs opens
// popup.html in a tab of its own and names the tab with ?tabId=.
async function targetTabId() {
  const fromQuery = Number(new URLSearchParams(location.search).get('tabId'));
  if (fromQuery) return fromQuery;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

let tabId;
let info;

const show = (el, on) => {
  el.hidden = !on;
};

function message(text) {
  $('message').textContent = text || '';
  show($('message'), !!text);
}

function renderSites() {
  const list = $('sites');
  list.replaceChildren(
    ...info.sites.map((host) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = host;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = 'Remove';
      rm.setAttribute('aria-label', `Remove ${host}`);
      rm.addEventListener('click', async () => {
        await send({ type: 'df-site-remove', host });
        await refresh();
      });
      li.append(name, rm);
      return li;
    }),
  );
  show($('no-sites'), info.sites.length === 0);

  $('builtins').replaceChildren(
    ...info.builtins.map((pattern) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = pattern.replace(/^https:\/\//, '').replace(/\/\*$/, '').replace(/\*$/, '');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'built in';
      li.append(name, tag);
      return li;
    }),
  );
}

function render() {
  document.body.dataset.kind = info.kind;
  const status = $('status');
  const note = $('note');
  show(note, false);
  show($('always-row'), false);

  if (info.kind === 'unsupported') {
    status.textContent = "Deal Flash can't run on this page. Browsers keep extensions off their own pages (chrome://, arc://), the Chrome Web Store and local files.";
    show($('actions'), false);
  } else {
    show($('actions'), true);
    if (info.kind === 'builtin') {
      status.textContent = `Runs on ${info.host} by itself. Press j to start.`;
    } else if (info.alwaysOn) {
      status.textContent = `Always on for ${info.host}. Press j to start.`;
    } else {
      status.textContent = `Not running on ${info.host} until you start it.`;
    }
    if (info.kind === 'site') {
      if (info.canAlwaysOn) {
        $('always-host').textContent = info.host;
        $('always').checked = !!info.alwaysOn;
        show($('always-row'), true);
      } else if (!info.https) {
        note.textContent = 'Always on needs an https page. The button and the shortcut still work here.';
        show(note, true);
      }
    }
  }
  renderSites();
}

async function refresh() {
  info = await send({ type: 'df-info', tabId });
  render();
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  const r = await send({ type: 'df-start', tabId });
  $('start').disabled = false;
  if (r && r.ok && r.result === 'started') {
    window.close();
  } else if (r && r.ok) {
    message('Deal Flash is loaded on this page. Press j to start.');
  } else {
    message("Couldn't start on this page" + (r && r.error ? ` (${r.error})` : '.'));
  }
});

$('always').addEventListener('change', async (e) => {
  const host = info.host;
  if (e.target.checked) {
    // Must run straight from the click so the browser shows its prompt.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [`https://${host}/*`] });
    } catch (err) {
      message(String(err.message || err));
    }
    if (granted) await send({ type: 'df-site-add', host, tabId });
  } else {
    await send({ type: 'df-site-remove', host });
  }
  await refresh();
});

(async () => {
  tabId = await targetTabId();
  chrome.commands.getAll((cmds) => {
    const c = (cmds || []).find((x) => x.name === 'start-pager');
    $('shortcut').textContent = c && c.shortcut
      ? `${c.shortcut} starts it on any page.`
      : 'Set a shortcut to start it on any page in your browser’s extension shortcuts settings.';
  });
  await refresh();
})();
