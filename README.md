# Deal Flash

A small browser extension for Chrome and other Chromium browsers that turns a
long deals page, gift guide or product grid into something you page through
one item at a time with `j` and `k`.

Each item is lifted into a large card: the photo, the product name, numbered
buy buttons with the old price struck through, and the write-up. Star the ones
worth a second look, then copy the starred list as Markdown.

Everything happens in your browser. There is no server, no account and no
analytics, and buy links open exactly the address the page gave them. See
[PRIVACY.md](PRIVACY.md).

## Install

Deal Flash isn't in the Chrome Web Store yet. To load it from this repository:

1. Download the repository (Code → Download ZIP, then unzip it) or clone it.
2. Open `chrome://extensions` (in Arc, `arc://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder.

To update, replace the folder's contents (or `git pull`) and click the reload
arrow on the extension's card.

## Use

**On any page:** click the Deal Flash toolbar button and choose **Page through
this page**, or press `Alt+Shift+J` (`⌥⇧J` on a Mac; change it at
`chrome://extensions/shortcuts`). If the page has a list of products, the first
one opens in a card.

**On sites you use often:** tick **Always on for (the site)** in the popup. The
browser asks for access to that one site, and from then on `j` starts the pager
there with no click. Untick it, or press Remove in the popup's list, to give
the access back.

**Built in:** Wirecutter pages and interactive guides on nytimes.com, and
amazon.com, work this way from the start.

Where Deal Flash finds no list of items, `j` and `k` are left to the page.

### Keys

| Key       | Does                                                  |
| --------- | ----------------------------------------------------- |
| `j` / `k` | Next / previous item (the first press starts it)      |
| `g` / `G` | First / last item (the last one loaded so far)        |
| `1`–`9`   | Open that buy button in a background tab              |
| `o` / `O` | Open the first buy button (`O` switches to the tab)   |
| `r` / `R` | Open the item's review or "Read more" link in a new tab (`R`: background) |
| `s`       | Star / unstar the item                                |
| `f`       | Page through starred items only                       |
| `c`       | Copy the starred items as a Markdown list             |
| `v`       | Switch between card view and page view                |
| `space`   | Scroll a long card (Shift-space goes back up)         |
| `?`       | Show the keys                                         |
| `Esc`     | Turn the pager off (clicking outside the card does too) |

**Card view** is the default. **Page view** (`v`) spotlights the item where it
sits on the page instead, and hides the page's sticky headers and banners
while it's on.

A counter at the bottom shows where you are. `12 / 44+` means the page may
have more to load; paging past the last item scrolls the end of the list into
view behind the card (and presses a "load more" button if there is one), waits
a few seconds, and carries on. Any other key stops the wait.

Stars and your view choice are saved in the browser, per page. Keys are
ignored while you're typing in a field or holding Cmd/Ctrl/Option.

## How it finds items

Site-specific knowledge lives in small adapters, tried in order; the general
detectors come last, and an adapter that finds nothing hands over to them. So
when a site changes its markup, the pager falls back to general detection
rather than stopping.

1. **Amazon's deals grid** (`data-testid="discount-asin-grid"`), which only
   draws the rows near the screen. Each deal is read once as it appears and
   kept, so paging works after Amazon drops the card.
2. **The Times' interactive gift guide** cards (`data-category` and
   `data-featured` attributes).
3. **Wirecutter's callout cards** (`.global-cob`), with the tagline above and
   the description below.
4. **A grid that redraws as it scrolls**, on any site: the same approach as
   Amazon's, for repeated cards that are absolutely positioned.
5. **Any other page**, by two general methods, whichever finds the better
   list:
   - *Editorial pages:* a heading whose stretch of the page holds a buy link,
     at whichever heading level gives the most items; failing that, the
     smallest block holding a buy link and an image.
   - *Product grids:* at least four elements with the same structure, each
     with its own link, where at least half show a price, a buy button, an
     outbound shop link or schema.org Product data. Menus, carousels and plain
     article lists are left alone.

A link counts as a buy link when it leaves the site for a known shop or
affiliate network, is marked `rel="sponsored"`, reads like a button ("Buy",
"$29 at …"), sits beside a price, or is one of the site's own redirect links
(`/out/`, `/go/`, `/link/`). Prices are read in `$`, `£`, `€`, `¥` and `₹`,
with code prefixes (`CA$`, `USD 12`) and suffixes (`12,99 €`).

**What has been checked against real pages.** Version 1.3 was checked by hand
in November 2026 against Wirecutter's deals post (146 items), the Times' 2026
Holiday Gift Guide (324 gifts) and Amazon's deals pages (248 deals in, past
its "View more deals" button). The general detection added in 2.0 has so far
only been run against the invented pages in the test suite. If it misreads a
page, please open an issue with the address.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Saves your stars and view choice on your device. |
| `activeTab` | Lets the toolbar button and the shortcut read the one tab you used them on. |
| `scripting` | Loads the pager into that tab, and on your always-on sites. |
| Site access to nytimes.com (Wirecutter and interactive pages) and amazon.com | The built-in sites. |
| Optional access to other `https` sites | Asked for one site at a time, only when you tick "Always on". |

## Development

There is no build step; the folder is the extension.

```bash
npm install
```

```bash
npm test
```

The tests load the extension into Chrome for Testing and drive it with the
keyboard against invented pages served by request interception, with DNS
blackholed, so nothing leaves the machine. `test/run.cjs` covers the pager
(`--only NAME` runs one layout, `--shots DIR` saves screenshots);
`test/shell.cjs` covers the popup, the shortcut and always-on sites. A real
toolbar click, the browser's permission prompt and a browser restart can't be
automated and need a manual check.

`npm run icons` regenerates the PNG icons from `icons/icon.svg`, and
`npm run package` builds the zip for the Chrome Web Store.

## Not affiliated

Deal Flash is an independent project. It is not affiliated with or endorsed by
Amazon, The New York Times or Wirecutter, whose names appear here only to say
where it works.

## License

[MIT](LICENSE)
