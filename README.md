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

**Important:** `clasp create` also overwrites `src/appsscript.json` with
Google's default (wrong time zone, no scopes, no `webapp` block). Restore
the repo version straight away, then force-push it:

```bash
git restore src/appsscript.json
clasp push -f
```

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
  StaffDirectory.gs view / add / deactivate staff (Admin writes, server-checked)
  Tasks.gs          assign, update status, completion notes, overdue flag, emails
  Reports.gs        weekly report form, history (filed/missed), compliance, blockers, Friday reminder
  Attendance.gs     check in / check out with server timestamps, history, team view
  ui/Index.html     page shell, includes the module partials
  ui/StaffDirectory.html  staff directory UI
  ui/Tasks.html     my tasks, team/all-tasks board, assign form
  ui/Reports.html   report form, my history, team compliance and blockers
  ui/Attendance.html  check in/out card, my history, team attendance
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
4. Added `completion_note`, `updated_by` and `updated_at` to Tasks (the
   Staff view asks for a completion note; Section 8 asks for a user and
   timestamp on every record). Section 5.2 does not list them.
5. Added a `priority` category to Config (High / Medium / Low) so the
   priority dropdown reads from Config like every other dropdown.

6. Added a `report_history_weeks` category to Config (default 8): how many
   recent weeks show in a person's report history and can be filed late.

7. Added a `work_mode` category to Config (Remote / Office / Field) so the
   attendance dropdown reads from Config like every other dropdown.

## How the attendance rules work

- Timestamps always come from the server clock, with seconds. The browser
  never sends a time, a date or who is checking in.
- One row per person per day: one check-in, then one check-out. The day is
  the calendar date in the script's time zone.
- A check-out only closes today's row. If someone forgets, that day shows
  "No check-out" in their history and an Admin corrects the Sheet row.
  Overnight shifts are not supported.
- Work mode is chosen at check-in. Staff see their own history, Leads see
  themselves and their direct reports, Admins see everyone, for any past day.

## How the weekly report rules work

- A "week ending" is a Friday. Monday to Friday belong to that Friday;
  Saturday and Sunday still belong to the Friday just gone (a weekend grace
  period). Monday starts a new week.
- Everyone with an active Staff record is expected to report, from the first
  Friday on or after their start date.
- One report per person per week. Reports are never edited or deleted from
  the app. To correct one, an Admin edits the Sheet row.
- A week shows as Missed once its weekend has passed. Late reports for
  recent weeks are still accepted.
- The blockers list uses each person's most recent report only, and ignores
  answers such as "None" or "N/A".

## Testing

`docs/E2E-TEST-CHECKLIST.md` is the full end-to-end checklist: login,
routing, every module, security, data integrity, and a prod smoke test.

## After pulling a change that adds columns

Run `setupSheets()` once in each environment. It adds any missing header
columns to the end of an existing tab, never touches data, and leaves a tab
alone (with a logged warning) if its headers were renamed or reordered.
Then run `seedDummyData()` in dev to pick up new sample data and Config rows.
