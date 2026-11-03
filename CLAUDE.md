# Family Fit

Marc's family app: chores and points, sport, homework, the boys' week, pocket money and Xbox minutes, with Holeshot inside it. It began as a Claude artifact and was rebuilt here in November 2026 so it could have a real login and get Holeshot results by itself.

Marc is not a programmer. Explain things in plain English and do the technical work for him.

## This repository is public

It is served by GitHub Pages at `/family-fit/` on the same address as Holeshot. Never put surnames, school names, email addresses, staff names, health details, timetables or a child's marks into anything here, including comments and commit messages. `tools/build.mjs` refuses to build if it finds the obvious ones. This folder's git author is set to "Family Fit" with the GitHub no-reply address (`git config user.name` / `user.email` in this repo only), because a commit's author is public too. Keep it that way.

## How it fits together

- **Front door** (`site/`, public): `shell.js` signs a family member in with Supabase Auth, fetches the app's screens from the database, keeps the family's data on the device in IndexedDB, and syncs changes. The app's screens were written against the artifact's `window.claude.use("db")` interface (`collection().onSnapshot`, `doc().onSnapshot/set/delete`), and `shell.js` provides the same interface, so the screens run unchanged.
- **The app's screens** (private): one HTML block stored in `familyfit.app` and fetched with `ff_app_code` after sign-in. They are built from the artifact in the private folder beside this one (`C:\Dev\Kids\Family Fit private\app`, `node build-app.mjs`), and published to the database from there. That folder also has the test server, the setup script, the data backup and Marc's guide. It is not a git repository, so it never goes public.
- **Database** (`supabase/001_familyfit.sql`): schema `familyfit` in Holeshot's Supabase project (`kyosepbdxjwugunylvyo`), next to `holeshot`. `members` maps each login to a name and a role (parent or kid). `docs` holds every saved thing at the artifact's own paths (`log_<name>/<day>`, `settings/prefs_<name>`, `events/<id>`, `family/staff` ...). `rev` rises on every change so devices fetch only what changed. Row-level security lets members read and nothing write directly. All changes go through `ff_put`.
- **Kid rules** (`familyfit.kid_may`, `familyfit.kid_guard`): a kid can save only his own days and settings plus the shared calendar, invites and shopping list. A quest approval (2), a run check, a penalty change, behaviour marks, Holeshot minutes and reward settings (`xbRate`, `xbBase`, `xbMax`, `moneyMax`, `wkPts`, `jarPct`, `ledger`) are put back the way they were. A kid may mark a penalty fixed (status 2) with a photo. On the house page (`family/staff`) a kid's save keeps everything as stored except his own dinner wish (`wish`, `wishWk` under his name) and new calendar suggestions he sends (`suggest`, `by` = him); he can't change or remove anyone else's.
- **Calendar** (since 2 November 2026): an event in `events/<id>` can have a type (`kind`: sport, school, lesson, appt, social, family, holiday, other; only a parent can choose holiday), an end time (`te`) and a weekly repeat (`rep: {days: [weekday numbers, 0 = Sunday], weeks, until}`, with `skip` listing single days taken off). The built-in weekly timetable can be changed too: "just this day" adds `<key>|<date>` to `sched.hideOn` and "from this day on" sets `sched.hideFrom[<key>]`, and either way the new version is saved as an ordinary event. Days already taken off carry over when a repeat is changed from a day on. A kid's change goes in as a suggestion (`v`, `scope`, `day`) for a parent to approve.
- **Two devices at once**: `ff_put` takes the rev the device's copy came from. If someone saved since, it answers "stale" with the newer copy and `shell.js` folds its own change into it (`merge3`) and tries again.
- **Holeshot results**: `ff_holeshot_sync` reads `holeshot.runs` (read-only) for today and yesterday, South African time, and writes `hs` onto the boys' days: a stage is a race of 5 or more questions at 70% or better, not a hot lap; 5 minutes a stage, up to 6 stages; no streak bonus; minutes given are never taken back. Rules approved by Marc on 2 November 2026. It doesn't touch `holeshot-sync` or anything in the `holeshot` schema.
- **Xbox is for weekends** (Marc, 2 November 2026): no Xbox on school days. Everything a boy earns Monday to Sunday (approved quests, runs, Holeshot, the weekly boss bonus once, less penalty minutes) builds his weekend total. Saturday and Sunday each give the basic minutes (`xbBase`, never earned or taken away) plus as much of the total as fits under the daily most (`xbMax`); what is left after Sunday is gone. On a holiday weekday he can play only that day's extras (bonus quests, runs, Holeshot); normal chores still go to the weekend. Holidays are the days outside term (term start and each boy's last school day in the schedule, `staff.sched.from` and `breakup`) and days with a parent's Holiday calendar item.
- **Checking**: parents approve everything in one list (Tasks, reached from the check bar on Today): ticked jobs, runs, fixed messes and kids' calendar suggestions, grouped by boy, with Approve all and 10 seconds to undo.
- **Jobs by time of day** (3 November 2026): a boy's musts show under Morning, After school (Afternoon on a day without school) and Tonight, and a group that is all done folds to one line. The group comes from a fixed list of job ids in the app's screens; anything not listed goes by the hour it opens, or After school.
- **Weekend house jobs** (3 November 2026): a house job can be tied to weekends when the house help goes home (`kz` on the job). She answers each weekend on her screen. The answer is saved on the house page, keyed by the Saturday. With no answer the jobs show. A kid can't change her answer, because a kid's save to the house page keeps everything except his own wish and his suggestions. A house job can also carry its own group (`slot`: 0 morning, 1 afternoon, 2 tonight), which wins over the fixed list.
- **Weekly race** (3 November 2026): pocket money comes in three steps of a boy's weekly points.
  - Gold is `wkPts` and pays all of `moneyMax`. Silver is 80% of the points and pays 70%. Bronze is 60% and pays 40%. Below Bronze nothing is paid.
  - The boss bonus is at Gold.
  - At Gold he picks a prize from the parents' list (`prizes` in the parent settings). His pick (`gold`) and the cheers he has seen (`seenPod`) sit in his own settings, which kids may save.
  - The brothers' challenge is both boys on Silver.
  - Levels run to 15 000 points.
- **Saves the screen makes by itself** (a level up seen, a cheer shown) wait until that person's saved settings have arrived. A save from the starting settings would replace the real ones: a device that never had a document has no base for `merge3`, so its copy wins.
- **Holeshot inside the app**: a full-screen frame of `/holeshot/` with a back button. On a device that has never linked Holeshot, it asks for the family code once.
- **Logins** are first names with a made-up ending (`@familyfit.invalid`). There's no email reset: Marc asks Claude, and the private setup script gives a new password.

## Publishing

- Front door: `node tools/deploy.mjs "what changed"` (builds, saves to `main`, publishes `dist/` on `gh-pages`).
- App screens: from the private folder, `node build-app.mjs`, then `node setup-supabase.mjs app`. Devices pick it up the next time they open, or straight away with the Update button.
- Ask Marc before publishing anything, and before changing the live database.

## Testing

From the private folder, `node dev-server.mjs` serves a test copy on http://localhost:5298 (or `node dev-server.mjs 5297` for a second copy; any port from 5290 to 5299 counts as a test copy) with a pretend server that follows the same rules. It starts from the backup and keeps changes in memory. The logins are the names with the password `dev-<name>`.
