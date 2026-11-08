// Genera le icone PNG (app web, iPhone e Android) dal logo ritagliato scripts/logo-icona.png.
// Uso: node scripts/gen-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const logo = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'logo-icona.png')).toString('base64')}`;
const BG = '#FFEE00'; // stesso giallo dello sfondo del logo
// [file, dimensione, margine (frazione per lato), rotonda]
const targets = [
  ['public/icons/icon-192.png', 192, 0.05], ['public/icons/icon-512.png', 512, 0.05],
  ['public/icons/icon-maskable-512.png', 512, 0.12], ['public/icons/apple-touch-icon.png', 180, 0.05],
  ['android/app/src/main/res/drawable/splash.png', 384, 0.06],
];
const mip = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(mip)) {
  targets.push([`android/app/src/main/res/mipmap-${d}/ic_launcher.png`, s, 0.05]);
  targets.push([`android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, s, 0.13, true]);
  // icona adattiva: 108dp con area sicura centrale di 66dp
  targets.push([`android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`, Math.round(s * 108 / 48), 0.19]);
}
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [out, size, pad, round] of targets) {
    await p.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * (1 - 2 * pad));
    await p.setContent(`<html><body style="margin:0;background:transparent">
      <div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:${BG};${round ? 'border-radius:50%;overflow:hidden' : ''}">
        <img src="${logo}" style="width:${inner}px;height:auto;display:block">
      </div></body></html>`);
    await p.waitForFunction(() => document.images[0].complete);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await p.screenshot({ path: out, omitBackground: true });
  }
  await b.close();
  console.log('icone generate:', targets.length);
})();
