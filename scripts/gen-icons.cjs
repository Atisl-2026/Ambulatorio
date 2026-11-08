// Genera le icone PNG (app web e Android) da scripts/icon.svg.  Uso: node scripts/gen-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
const targets = [
  ['public/icons/icon-192.png', 192, 0], ['public/icons/icon-512.png', 512, 0],
  ['public/icons/icon-maskable-512.png', 512, 0.12], ['public/icons/apple-touch-icon.png', 180, 0],
];
const mip = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(mip)) {
  targets.push([`android/app/src/main/res/mipmap-${d}/ic_launcher.png`, s, 0]);
  targets.push([`android/app/src/main/res/mipmap-${d}/ic_launcher_round.png`, s, 0, true]);
  // icona adattiva: 108dp con area sicura centrale di 66dp
  targets.push([`android/app/src/main/res/mipmap-${d}/ic_launcher_foreground.png`, Math.round(s * 108 / 48), 0.19]);
}
targets.push(['android/app/src/main/res/drawable/splash.png', 384, 0.08]);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  for (const [out, size, pad, round] of targets) {
    await p.setViewportSize({ width: size, height: size });
    const inner = Math.round(size * (1 - 2 * pad));
    await p.setContent(`<html><body style="margin:0;background:${round ? 'transparent' : '#FFED00'}"><div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:#FFED00;${round ? 'border-radius:50%;overflow:hidden' : ''}"><div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></div></body></html>`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await p.screenshot({ path: out, omitBackground: !!round });
  }
  await b.close();
  console.log('icone generate:', targets.length);
})();
