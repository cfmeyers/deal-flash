// Renders icons/icon.svg to the PNG sizes the manifest uses.
//
//   npm run icons
//
// Uses sharp (librsvg underneath), which renders the SVG the same way every
// run, so the PNGs only change when icon.svg does.
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const dir = __dirname;
const svg = fs.readFileSync(path.join(dir, 'icon.svg'));
(async () => {
  for (const size of [16, 32, 48, 128]) {
    const out = path.join(dir, `icon-${size}.png`);
    // Render at 8x the target, then shrink, for clean edges at 16px.
    await sharp(svg, { density: 72 * 8 * (size / 128) })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(out);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
