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

## Alerts, new items and PDF

- **Orders due within 2 days.** Any open order (not MET) due today, tomorrow or the day after,
  or already late, is counted at the top and marked on its item, with how many it is short of
  closing stock. Late orders are red, the rest amber.
- **Monthly report** (Daily entry → *Month report*): pick a month for one PDF of every day tab in
  it — each item's opening (first day), production and despatch (summed) and closing (last
  day), the daily totals with absentees — and all its transfers by kind, by item and one by one.
  Past tabs are cached for an hour, so a second report is quick.
- **Day PDF** lists orders due, then all items, then low stock moving well, last.
- Items are read down to the first blank row, so the packing-roll and cover tables under them
  never show up as items.
- **Only pending orders are shown.** A MET order doesn't appear on its item, in *With orders* or in
  the PDF; *Order* on that item starts a new one.
- **Low stock, moving well.** For each item the script reads Despatch from the last 14 day
  tabs (past tabs cached for 6 hours). An item is flagged when it **moved** (despatched on at
  least 4 of those days) **and** is **low**: closing below its Mini Level, or less than 7
  days of cover at its average daily despatch. The thresholds are at the top of
  `src/insights.ts`.
- **New order.** Pick any item, then quantity, deliver-by date and status. It's saved with
  everything else.
- **New item.** Section, code, name, opening stock and minimum level. On Save it becomes a
  new row at the end of its section on that day's tab, formatted like the row above, with the
  sheet's Closing and Required Qty formulas, and the No column is renumbered. Later days pick
  it up through the sheet's ➕ Next Day. (If tomorrow's tab already exists, add it there in
  the sheet as well.)
- **PDF.** The day as saved in the sheet, on A4 with the Abu Salim logo: orders due, low
  stock, then every item by section, with the same colours.

## Transfers (merged from the stock-transfer app)

The **Transfers** switch under the header replaces transfers.abusalim.sa. It reads and writes
the requisition app's sheet (*salesman requisition and transfer*), so requisitions keep coming
from salesreq.abusalim.sa.

- **Open requisitions** are the ones with no transfer against them yet. Tap one and its items
  fill in; enter Transfer, Physical, System and Pieces reimbursed. Variance = Physical − System.
  A transfer can also be made without a requisition.
- **Saved to the Transfers tab** with the same columns and `TRF-<year>-0001` numbering the old app
  used, so its history carries on. A requisition can only be transferred once.
- **Added to Despatch.** Each line's Transfer quantity is added to Despatch on the store's day
  tab for the transfer date (that tab must exist). Each line suggests a store row: same item
  code, then the closest name (1126 is two different bags), then the section for the route's
  region (Riyadh / Kharj / Qaseem routes → the Riyadh section). It can be changed per line or
  set to *Don't add*; codes the store sheet doesn't have can't be added.
- **Three kinds of transfer.** *Salesman route* (with or without a requisition), *Direct sale*
  (a customer name instead of a route) and *Regional warehouse* (Riyadh or Dammam). The Riyadh
  warehouse draws on the Riyadh section, Dammam and direct sales on the regular ones. Sales and
  warehouse transfers only ask for the quantity. The kind is saved in a 16th column,
  `transfer_type`, added to the Transfers tab the first time it's needed; older rows count as
  routes. The sheet's route column reads "Direct sale" / "Riyadh warehouse".
- **Add an item** opens a searchable list grouped by product, with code and unit tags and the
  store's closing stock for that transfer's section.
- **Invoice no.** for direct sales (optional), saved in a 17th column, `invoice_no`, and shown on
  the list and the PDF.
- **PDF** of each transfer with the logo and signature lines, titled by kind.
- **Day's transfers PDF**: pick a day (any of the last 31) for one PDF of every transfer made on
  it, then the quantity per item split into route, direct and warehouse.

Retire the old transfer app once this is live, so two apps don't number transfers at once.

## Setting it up

1. **Apps Script.** script.google.com → New project, paste `apps-script/entry.gs`. In
   **Project Settings → Script Properties** add `SECRET` with a long random value. It must
   never go in the file itself: this repository is shared, and Netlify's secret scan fails
   the build when it finds the value in the code. Run **setup** once and allow access; the
   log lists the tab, every column it found and the absentees cell.
2. **Deploy → New deployment → Web app**, execute as **Me**, access **Anyone**. Copy the URL.
3. **Netlify.** Import this repo as a new site (build `npm run build`, publish `dist`; both
   come from `netlify.toml`). Under Environment variables, with the Functions scope, set:

   | Variable | Value |
   | --- | --- |
   | `ENTRY_SCRIPT_URL` | the web app URL (…/exec) |
   | `ENTRY_SCRIPT_SECRET` | the same value as the script's `SECRET` property |
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
