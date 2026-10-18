# ARS Store Entry

Read and write the daily tabs of **Packing and dispach 2026** from a phone, without opening
the sheet: each item's **Production** and **Despatch**, the **Absentees** note, and its
**Specific Order / Deliver By / Order Status**.

```
browser ──► /api/daily (team passcode) ──► Apps Script web app (shared secret) ──► day tab
```

- **Reads are live.** Every open, day switch and save re-reads the tab through the script,
  so the form never starts from numbers a few minutes old.
- **Only what you edited is sent.** A colleague's entry in another cell is never
  overwritten by a form opened earlier. An emptied box clears the cell.
- **Closing stays the sheet's.** Closing is a formula (Opening + Production − Despatch); the
  app mirrors it as you type and never writes it. A cell holding a formula is refused.
- **Production and Despatch go to the chosen day only** (today by default; the last week can
  be picked to back-fill). Later days' Opening is a formula on that day's Closing.
- **Orders also go to later day tabs that already exist**, so a tab made in advance doesn't
  miss one. Carrying orders to new days stays with the sheet's own ➕ Next Day.
- **All or nothing.** The script checks every change first, then writes, under a lock.

## Setting it up

1. **Apps Script.** script.google.com → New project, paste `apps-script/entry.gs`, set
   `SECRET` to a long random value. Run **setup** once and allow access; the log lists the
   tab, every column it found and the absentees cell.
2. **Deploy → New deployment → Web app**, execute as **Me**, access **Anyone**. Copy the URL.
3. **Netlify.** Import this repo as a new site (build `npm run build`, publish `dist`; both
   come from `netlify.toml`). Under Environment variables, with the Functions scope, set:

   | Variable | Value |
   | --- | --- |
   | `ENTRY_SCRIPT_URL` | the web app URL (…/exec) |
   | `ENTRY_SCRIPT_SECRET` | the same value as `SECRET` in the script |
   | `APP_PASSCODE` | the team passcode people type once per phone |

   Then redeploy. Until the first two are set the app says it isn't connected.

After editing the script, redeploy it with **Manage deployments → Edit → New version** so
its URL stays the same.

## Commands

```bash
npm install
npm run dev     # http://localhost:5173 with an in-memory sample day (passcode "dev")
npm run build   # production build + typecheck
```

## Installing on a phone

Open the site in Safari (iPhone) or Chrome (Android) and choose **Add to Home Screen**.
