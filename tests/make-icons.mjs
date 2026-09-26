// Renders PNG app icons from SVG using headless Chromium (dev-time only).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
// Maskable: white logo on the navy brand background, kept inside the safe zone.
const maskable = svg.replace('<path fill="#0B3C5D"', '<rect width="512" height="512" fill="#0B3C5D"/><path transform="translate(256 256) scale(.8) translate(-256 -256)" fill="#FFFFFF"');
const browser = await chromium.launch();
for (const [name, src, size] of [['icon-192.png', svg, 192], ['icon-512.png', svg, 512], ['icon-maskable-512.png', maskable, 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${src}`);
  await page.screenshot({ path: new URL(`../icons/${name}`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written');
