# End-to-end validation checklist

Run this in your **dev** project (personal Google account, dummy data) before
anything goes near prod. It covers login, routing, every module, and that
each action writes the right data to the Sheet. Tick each box and note any
failure with the exact message from **Executions** in the Apps Script sidebar.

Prod is not tested this way. It never gets `seedDummyData()` or
`EMAIL_OVERRIDE`. See "Prod smoke test" at the end.

## 0. Prepare

- [ ] `git switch main && git pull`, then `clasp push`
- [ ] In the editor run `setupSheets()`, then `seedDummyData()`
- [ ] Open the Sheet: all 8 tabs have headers; Staff has 3 rows; Tasks 3;
      Reports 3; Attendance 3; Config has `priority`, `access_level`,
      `employment_type`, `work_mode` and `report_history_weeks` rows
- [ ] Script Properties: `ENV` = `dev`, `SHEET_ID` set. Add `EMAIL_OVERRIDE`
      only while testing a role, and **delete it at the end**
- [ ] Deploy → Test deployments → open the `/dev` URL. After changing
      `EMAIL_OVERRIDE`, reload the page. No redeploy is needed.

Seeded people: `admin@example.org` (Ada, Admin), `lead@example.org` (Leo,
Lead, manages Sam), `staff@example.org` (Sam, Staff).

## 1. Login and routing

| `EMAIL_OVERRIDE` | Expected |
|---|---|
| `staff@example.org` | "Signed in as Sam Staff (Staff)"; sections: Attendance, Tasks, Reports, Staff directory |
| `lead@example.org` | "Signed in as Leo Lead (Lead)"; as above plus team boards |
| `admin@example.org` | "Signed in as Ada Admin (Admin)"; everything |
| `nobody@example.org` | Access denied message, no data on the page |
| *(delete the override, then add your real email to Staff as Admin/Active)* | Your own name and Admin: proves the real session lookup works |

- [ ] Set a Staff row's `status` to `Inactive` and reload as that person:
      access denied. Set it back to `Active`.

## 2. Staff directory (as Admin)

- [ ] Table shows all staff, including inactive ones (greyed)
- [ ] Add a person (fake email, any department): appears as the next `ATX-` id
      with status Active; Sheet row matches what you typed
- [ ] Add the same email again: rejected ("already exists")
- [ ] Deactivate the new person: status Inactive, Sheet shows `Inactive`, row kept
- [ ] Try to deactivate yourself: rejected
- [ ] As Lead: only Leo and Sam, no add form, no buttons
- [ ] As Staff: only Sam

## 3. Tasks

**As Lead**
- [ ] Assign a task to Sam (any priority, a due date in the past): appears in
      the Team board, flagged OVERDUE
- [ ] A `[DEV]` email arrives in **your** inbox for the new task
      (it must not go to `staff@example.org`)
- [ ] Try to assign to `admin@example.org`: not offered / rejected

**As Staff (Sam)**
- [ ] My tasks are grouped by status; overdue tasks are red with a badge
- [ ] Mark an overdue task Completed with no note: rejected
- [ ] Add a note and save: moves to Completed, no longer overdue
- [ ] Sheet row: `status` = Completed, `completed_date` = today,
      `completion_note` set, `updated_by` = `staff@example.org`
- [ ] Reopen it (In progress): `completed_date` clears, the note stays
- [ ] Type `=1+1` in a completion note: the Sheet shows the text `=1+1`, not `2`

**As Admin**
- [ ] "All tasks" board shows every task; filters by person, department,
      programme and status each narrow the list; Clear filters restores it

**Automation**
- [ ] Run `sendMondayTaskSummaries` from the editor: `[DEV]` emails to you,
      overdue tasks listed first, completed tasks absent

## 4. Weekly reports

**As Staff (Sam)**
- [ ] Form is pre-filled with name, role, department, email and the current
      week ending (a Friday)
- [ ] Submit with hours `abc`: rejected. Hours `169`: rejected
- [ ] Submit a valid report: success message; history shows the week as Filed
- [ ] Submit the same week again: rejected ("already filed")
- [ ] File an older Missed week late: allowed; it turns Filed
- [ ] Sheet row: `staff_email` is Sam's (not typed by you), `submitted_at`
      stamped, `hours_worked` is a number

**As Lead**
- [ ] Compliance table: "x of 2 submitted" for Leo and Sam only
- [ ] Blockers list shows Sam's blocker from his latest report. After Sam
      files "None" for the current week, the blocker disappears

**As Admin**
- [ ] Compliance covers every active staff member; inactive people are absent

**Automation**
- [ ] Run `sendWeeklyReportReminders`: `[DEV]` emails only for people who
      have not filed this week

## 5. Attendance

**As Staff (Sam)**
- [ ] Choose a work mode and Check in: message shows the time; the card now
      offers Check out only
- [ ] Reload: still shows checked in, same time
- [ ] Sheet row: `date` = today, `check_in` = exact time with seconds,
      `work_mode` as chosen, `check_out` blank
- [ ] Check out: message shows time worked; card says "Done for today"
- [ ] Sheet: `check_out` filled. Reload and try to check in again: not offered
- [ ] History: yesterday's seeded row shows **No check-out**; today's shows Complete

**As Lead / Admin**
- [ ] Team attendance for today: Leo Checked in, others Not checked in until
      they act; change the date picker to yesterday and check the statuses
- [ ] A future date is rejected

## 6. Security checks (the server must refuse, not just the UI)

- [ ] As Staff, open the browser console on the page and run
      `google.script.run.tasksCreate({title:'x',assignee_email:'lead@example.org',priority:'High',due_date:'2030-01-01'})`:
      fails with "Lead or Admin only"
- [ ] As Staff run `google.script.run.staffDirectoryDeactivate('lead@example.org')`:
      fails with "Admin only"
- [ ] As Staff run `google.script.run.reportsCompliance()`: fails
- [ ] As Lead run `google.script.run.attendanceTeam('')`: returns only Leo and Sam

## 7. Data integrity

- [ ] No Sheet cell in Tasks, Reports or Attendance turned a date or text into
      a formula or a different format
- [ ] Ids are unique and sequential in each tab (`TSK-`, `RPT-`, `ATT-`, `ATX-`)
- [ ] Nothing was deleted from the Sheet by the app: deactivations and
      reopenings only changed status cells
- [ ] After all of the above, only `[DEV]` emails reached your inbox, and none
      reached `*@example.org` addresses

## 8. Clean up

- [ ] Delete the `EMAIL_OVERRIDE` Script Property
- [ ] `git status` is clean on `main`

## Prod smoke test (once org Apps Script access exists)

Only after the dev checklist passes. In the **prod** project:

- [ ] Script Properties: `ENV` = `prod`, org Sheet and folder IDs. **No** `EMAIL_OVERRIDE`
- [ ] Run `setupSheets()` only. **Never** run `seedDummyData()` in prod (it refuses, by design)
- [ ] Add one real Admin to Staff and to Config as `admin_email`
- [ ] Deploy the web app, sign in with an org account: you see your own name and Admin
- [ ] Run `installTriggers()` once. Check **Triggers** in the sidebar shows two:
      Friday reminders and Monday summaries
- [ ] Add one real staff member through the Staff directory and confirm they can sign in
