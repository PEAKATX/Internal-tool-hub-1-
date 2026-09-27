# AfroTechXcel Staff Dashboard

Google Sheets (database) + Google Apps Script (backend & web app) +
Google account identity (auth). No paid tools, per System Requirements
Section 3.

## First-time setup (each developer)

```bash
git clone <repo-url>
cd staff-dashboard
git config core.hooksPath .githooks     # enables the "no direct push to main" guard

npm install -g @google/clasp
clasp login                             # log in with YOUR OWN personal Google account
```

Create your personal dev environment:

```bash
clasp create --type webapp --title "ATX Dashboard (dev-<yourname>)" --rootDir ./src
```

This generates a `.clasp.json` (gitignored — never commit it; see
`.clasp.json.example` for the shape).

In the new Apps Script project (script.google.com), open
**Project Settings → Script Properties** and set:

| Property | Value |
|---|---|
| `SHEET_ID` | ID of a fresh Google Sheet you own (dev database) |
| `ENV` | `dev` |
| `RECEIPTS_FOLDER_ID` | a Drive folder you own, for testing uploads |
| `EXPORTS_FOLDER_ID` | a Drive folder you own, for testing exports |
| `EMAIL_OVERRIDE` | *(optional)* one of the seeded emails, to test a specific access level — see `Auth.gs` |

Then bootstrap the sheet:

```bash
clasp push
```

In the Apps Script editor, run `setupSheets()` once, then `seedDummyData()`
once (Seed.gs refuses to run if `ENV` is `prod`).

## Day-to-day workflow

```bash
git switch main && git pull
git switch -c feat/<short-description>
# ... edit files in src/ ...
clasp push          # pushes to YOUR dev project, safe to do anytime
git add -A && git commit -m "..."
git push -u origin feat/<short-description>
# open a PR into main, get it reviewed, squash-merge, delete branch
```

Never edit code in the Apps Script browser editor directly — it will
drift from Git. If something gets edited there by accident, `clasp pull`
before making further changes.

## Deploying to prod

Only from a clean, already-merged `main`. Whoever holds the org Google
account login does this step:

```bash
git switch main && git pull
clasp login                          # log in as the org account (or switch clasp --creds profile)
clasp push -P .clasp.prod.json
clasp deploy -i <deploymentId>       # updates the existing deployment, keeps the live URL stable
```

`installTriggers()` must be run manually (once) inside the prod Apps
Script project after the first deploy — `clasp push` does not install
time-driven triggers.

## Project structure

```
src/
  appsscript.json   manifest — auth mode, scopes, timezone
  Code.gs           doGet + routing only, no business logic
  Schema.gs         SCHEMA definition (Section 5) + setupSheets()
  Config.gs         Script Properties + Config-tab helpers
  Auth.gs           currentUser_(), access-level checks
  Utils.gs          sendMail_() (redirects in dev), withLock_(), nextId_()
  Seed.gs           dummy data for dev, refuses to run in prod
  Triggers.gs       installTriggers() + the two scheduled jobs
  ui/Index.html     page shell
```

Feature modules (`Tasks.gs`, `Reports.gs`, `Attendance.gs`, `Finance.gs`,
`Budget.gs`, `Analytics.gs`) get added alongside these as they're built.
Each should wrap its functions in an object (e.g. `const Tasks = { create() {...} }`)
since Apps Script shares one global namespace across all files.

## Open decisions (resolve before relying on these columns)

See the comment block at the top of `Schema.gs`:
1. Currency handling on Budget vs. Finance (NGN/USD).
2. Added `*_id` columns to Programmes, Attendance, Budget (not in the
   original spec) so other tables have something to reference.
3. Added `active` flags to Tasks/Reports/Attendance/Finance/Budget/Programmes
   for soft-delete, matching the Staff `status` pattern.
