// Renders PNG app icons from SVG using headless Chromium (dev-time only).
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0b2a4a"/><g transform="translate(256 256) scale(.72) translate(-256 -256)"><path d="M256 92S140 222 140 300a116 116 0 0 0 232 0c0-78-116-208-116-208z" fill="#7fe0d6"/><path d="M196 318a60 60 0 0 0 60 60" fill="none" stroke="#0b2a4a" stroke-width="22" stroke-linecap="round"/></g></svg>`;
const browser = await chromium.launch();
for (const [name, src, size] of [['icon-192.png', svg, 192], ['icon-512.png', svg, 512], ['icon-maskable-512.png', maskable, 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${src}`);
  await page.screenshot({ path: new URL(`../icons/${name}`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'), omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written');
