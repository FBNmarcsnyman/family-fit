// Puts the front door on the website: https://<account>.github.io/family-fit/
// Run: node tools/deploy.mjs "what changed"
// It builds dist/, saves this folder to the main branch of the family-fit repository, then publishes
// dist/ on the gh-pages branch, which GitHub Pages serves. node tools/deploy.mjs --check only says
// whether the website already matches this copy.
// The app's own screens are not here: they are published to the database from the private folder.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
execFileSync(process.execPath, [path.join(root, 'tools', 'build.mjs')], { stdio: 'inherit' });

const REPO = run(root, 'remote', 'get-url', 'origin').trim();
const checkOnly = process.argv[2] === '--check';
const what = process.argv[2] || 'Update Family Fit';
const work = mkdtempSync(path.join(tmpdir(), 'family-fit-'));
const git = (...args) => run(work, ...args);

try {
  let hasPages = true;
  try { git('clone', '--depth', '1', '--branch', 'gh-pages', REPO, '.'); } catch (e) { hasPages = false; }
  if (checkOnly) {
    const same = hasPages && readFileSync(path.join(work, 'version.json'), 'utf8').trim() === readFileSync(path.join(dist, 'version.json'), 'utf8').trim();
    console.log(same ? 'Same: the website matches this copy.' : 'DIFFERENT: the website is not what this copy builds.');
    process.exitCode = same ? 0 : 1;
  } else {
    // Save the working files first, so what is live always has its source in the repository.
    run(root, 'add', '-A');
    if (run(root, 'status', '--porcelain').trim()) run(root, 'commit', '-m', `${what}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
    run(root, 'push', 'origin', 'HEAD:main');
    if (!hasPages) { git('init'); git('checkout', '-b', 'gh-pages'); git('remote', 'add', 'origin', REPO); }
    for (const f of readdirSync(work)) if (f !== '.git') rmSync(path.join(work, f), { recursive: true, force: true });
    cpSync(dist, work, { recursive: true });
    git('add', '-A');
    if (!git('status', '--porcelain').trim()) console.log('The website already matches dist/. Nothing to publish.');
    else {
      git('commit', '-m', `${what}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`);
      git('push', 'origin', 'HEAD:gh-pages');
      console.log('Published. The website updates within about a minute.');
    }
  }
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
