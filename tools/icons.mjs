// Draws the app icon: a white house with a heart on Family Fit orange. Run: node tools/icons.mjs
// Uses the image library already installed for Holeshot, so nothing new needs installing.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, '..', 'road-scholars', 'package.json'));
const sharp = require('sharp');

// scale shrinks the drawing toward the middle, for the maskable icon that phones crop into a circle.
const svg = (round, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${round}" fill="#E9501C"/>
  <g transform="translate(256 262) scale(${scale}) translate(-256 -262)">
    <path d="M256 92 L436 240 L404 240 L404 418 L108 418 L108 240 L76 240 Z" fill="none" stroke="#fff" stroke-width="34" stroke-linejoin="round"/>
    <path d="M256 372 C 210 336 168 306 168 266 C 168 238 190 218 214 218 C 232 218 248 228 256 244 C 264 228 280 218 298 218 C 322 218 344 238 344 266 C 344 306 302 336 256 372 Z" fill="#fff"/>
  </g>
</svg>`;

const out = (name) => path.join(root, 'site', 'img', name);
await sharp(Buffer.from(svg(112, 1))).resize(512).png().toFile(out('icon-512.png'));
await sharp(Buffer.from(svg(112, 1))).resize(192).png().toFile(out('icon-192.png'));
// Apple rounds the corners itself, so its icon is a full square.
await sharp(Buffer.from(svg(0, 1))).resize(180).png().toFile(out('icon-180.png'));
await sharp(Buffer.from(svg(0, 0.72))).resize(512).png().toFile(out('icon-maskable-512.png'));
console.log('Icons written to site/img/');
