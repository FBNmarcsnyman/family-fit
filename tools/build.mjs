// Copies site/ to dist/ and stamps a version into the offline worker, so every device picks up
// a new front door after a change. Run: node tools/build.mjs
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const dist = path.join(root, 'dist');

const files = [];
(function walk(dir, rel) {
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f), r = rel ? `${rel}/${f}` : f;
    if (statSync(p).isDirectory()) walk(p, r);
    else if (r !== 'sw.js') files.push(r);
  }
})(site, '');

// Nothing that identifies the family may go on the website or into this repository. The words to look
// for are themselves private, so they live in the private folder beside this one, one per line.
const wordsFile = path.join(root, '..', 'Family Fit private', 'public-check.txt');
if (!existsSync(wordsFile)) throw new Error(`Missing ${wordsFile}, the list of private words to keep out.`);
const words = readFileSync(wordsFile, 'utf8').split(/\r?\n/).map((w) => w.trim().toLowerCase()).filter(Boolean);
(function scan(dir, rel) {
  for (const f of readdirSync(dir)) {
    if (['dist', '.git', 'node_modules'].includes(f)) continue;
    const p = path.join(dir, f), r = rel ? `${rel}/${f}` : f;
    if (statSync(p).isDirectory()) { scan(p, r); continue; }
    if (!/\.(html|js|mjs|css|webmanifest|json|md|sql|txt)$/.test(f) && f !== '.gitignore') continue;
    const text = readFileSync(p, 'utf8').toLowerCase();
    const hit = words.find((w) => text.includes(w));
    if (hit) throw new Error(`${r} contains a private word ("${hit.slice(0, 2)}..."). Take it out before building.`);
  }
})(root, '');

const hash = createHash('sha1');
for (const f of files) hash.update(f).update(readFileSync(path.join(site, f)));
hash.update(readFileSync(path.join(site, 'sw.js')));
const version = hash.digest('hex').slice(0, 10);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(site, dist, { recursive: true });
const cached = ['./', ...files.filter((f) => f !== 'index.html')];
writeFileSync(path.join(dist, 'sw.js'), readFileSync(path.join(site, 'sw.js'), 'utf8').replace('__VERSION__', version).replace('__FILES__', JSON.stringify(cached)));
writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ version }));
writeFileSync(path.join(dist, '.nojekyll'), '');
console.log(`Built dist/ (version ${version}, ${files.length + 1} files)`);
