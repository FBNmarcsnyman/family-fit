# Family Fit

A family app for chores, sport, homework and rewards, with Holeshot (the boys' revision game) as a tile inside it.

This repository is public, so it holds only the front door: the sign-in screen, offline saving and the loader. The app's own screens and all family data live in a private Supabase schema behind a real login, and are fetched after someone signs in.

- `site/`: the front door. `shell.js` signs people in, keeps a copy of the data on the device so it works offline, and sends changes back when there's signal.
- `supabase/001_familyfit.sql`: the private schema, row-level security and the functions the app calls, including the kid rules and the Holeshot minutes.
- `tools/build.mjs` builds `dist/`. `tools/deploy.mjs` publishes it to GitHub Pages. `tools/icons.mjs` draws the icon.
