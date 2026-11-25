#!/usr/bin/env bash
# Builds the zip the Chrome Web Store takes: only the files the extension
# runs, with manifest.json at the zip's root.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="deal-flash-$version.zip"
rm -f "$out"
zip -q -X "$out" manifest.json background.js pager.js popup.html popup.css popup.js \
  icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png LICENSE
unzip -l "$out"
echo "Wrote $out"
