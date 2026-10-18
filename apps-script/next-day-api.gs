/**
 * Store Entry → ➕ Next Day, without the menu.
 *
 * Add this as a NEW FILE in the sheet's own script project (Extensions → Apps Script in
 * "Packing and dispach 2026", + → Script, name it "Next Day API"). It is not a copy of Next
 * Day: it calls the same functions nextDay() does (parseAll_, computeSuggestions_,
 * orderModes_, outstandingOrder_, prepDaySheet_, writeDayBlock_), so a day made from the app
 * is built exactly like one made from the menu: Opening from the last sheet's Closing,
 * Suggested Mini from despatch history, orders carried as the alert expects.
 *
 * What the menu asks in dialogs is handled like this instead:
 *   • the last sheet must already have its No. of Absentees (enter it in the app first);
 *   • the new day's absentees start empty;
 *   • carried orders without a Deliver By date carry with no date (as when a prompt is left
 *     empty) — type the date on the new sheet.
 *
 * Setup, once:
 *   1. This file defines no doPost: the project already has one, and Apps Script keeps only
 *      one per project. Make the existing doPost start with
 *          const storeEntry = storeEntryPost_(e);
 *          if (storeEntry) return storeEntry;
 *      Anything that isn't a Store Entry request goes on through doPost exactly as before.
 *   2. Project Settings → Script Properties → add STORE_ENTRY_SECRET with the same value as
 *      Store Entry's ENTRY_SCRIPT_SECRET.
 *   3. If the project is already deployed as a web app (Execute as: Me, access: Anyone), use
 *      Deploy → Manage deployments → Edit → New version and keep its URL; otherwise
 *      Deploy → New deployment → Web app with those settings. Put the …/exec URL in Netlify as
 *      NEXTDAY_SCRIPT_URL and redeploy the site.
 */

/**
 * Called first thing from the project's existing doPost (see setup above). Returns the reply
 * for a Store Entry request, or null for anything else so doPost carries on as before.
 */
function storeEntryPost_(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return null;
  }
  if (!body || body.action !== 'nextDay') return null;

  let out;
  try {
    const secret = PropertiesService.getScriptProperties().getProperty('STORE_ENTRY_SECRET');
    if (!secret || body.secret !== secret) {
      out = { ok: false, error: 'unauthorized' };
    } else {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        out = nextDayFor_(String(body.date || ''));
      } finally {
        lock.releaseLock();
      }
    }
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** nextDay() for a given date (yyyy-mm-dd), with no dialogs. */
function nextDayFor_(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('Pick the date of the new day.');
  const ss = SpreadsheetApp.getActive();
  const tz = ss.getSpreadsheetTimeZone();
  const days = parseAll_();
  if (!days.length) throw new Error('No day sheets found.');

  const latest = days[days.length - 1];
  const absCell = latest.sheet.getRange(findDateRow_(latest.sheet), 9);
  if (String(absCell.getValue()).trim() === '') {
    throw new Error('The ' + latest.date + ' sheet has no No. of Absentees. Enter it (0 if nobody was absent) and try again.');
  }

  const dateVal = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const newKey = Utilities.formatDate(dateVal, tz, CFG.DATE_FMT);
  if (ss.getSheetByName(newKey)) throw new Error('A sheet named "' + newKey + '" already exists.');
  if (dateVal.getTime() <= new Date(latest.date).getTime()) {
    throw new Error('The newest sheet is ' + latest.date + '; the new day must come after it.');
  }

  // From here on, the same steps as nextDay().
  const sug = computeSuggestions_(days, dateVal);
  const prevName = latest.sheet.getName().replace(/'/g, "''");
  const modes = orderModes_();
  const items = latest.rows.map(function (x) {
    return { cat: x.category, code: x.code, item: x.item,
             opening: "=IFERROR('" + prevName + "'!$G" + x.row + ',0)',
             mini: x.mini > 0 ? x.mini : '',
             suggest: sug.map[miniKey_(x.category, x.item)] || '',
             order: outstandingOrder_(x, modes) };
  });
  const carried = items.filter(function (it) { return it.order; });
  const hadOrders = latest.rows.filter(function (x) { return x.specOrder > 0; }).length;

  const sh = ss.insertSheet(newKey, latest.sheet.getIndex());
  prepDaySheet_(sh);
  writeDayBlock_(sh, dateVal, items, '');
  SpreadsheetApp.flush();

  return {
    ok: true,
    tab: newKey,
    from: latest.date,
    ordersKept: carried.length,
    ordersDropped: hadOrders - carried.length,
    undated: carried.filter(function (it) { return !it.order.deliverBy; }).length,
  };
}
