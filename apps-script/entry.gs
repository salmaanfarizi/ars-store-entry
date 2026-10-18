/**
 * ARS Store Entry — reads and writes the day tabs of "Packing and dispach 2026"
 *
 * The entry app never talks to Google directly: its /api/daily function calls this web app
 * with a shared secret. It reads a day tab live, and writes Production, Despatch, the
 * absentees note and each item's Specific Order / Deliver By / Order Status.
 *
 * This is a standalone project (script.google.com → New project), NOT the script inside
 * the sheet, so the sheet's own menus, Next Day and alert scripts are left alone.
 *
 * Setup, once:
 *   1. Paste this file into a new Apps Script project and set SECRET below to a long random
 *      value.
 *   2. Run `setup` once from the editor and allow access when Google asks. The log shows the
 *      tab and the columns it found.
 *   3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. Copy the
 *      web app URL into the site's ENTRY_SCRIPT_URL setting.
 *
 * After editing this file, deploy again with Manage deployments → Edit → New version, so
 * the URL stays the same.
 */

const SHEET_ID = '1l1YuOxJ5W-lWxD-xgC2ZlfatNxDN4HuVAbaf4SL4vxU';
const SECRET = '2031106194';

/** Day tabs are named by date (10/15/2026); "today" is decided in Saudi time. */
const TIME_ZONE = 'Asia/Riyadh';

const HEADERS = {
  opening: 'Opening',
  production: 'Production',
  despatch: 'Despatch',
  closing: 'Closing',
  order: 'Specific Order',
  deliverBy: 'Deliver By',
  status: 'Order Status',
};

/** The cell above the absentees entry; its value sits just right of the label's merged cells. */
const ABSENTEES_LABEL = 'no. of absentees';

/** The sheet's own Order Status dropdown; offered if a tab is missing it. Blank = pending. */
const DEFAULT_STATUSES = ['PENDING', 'MET'];

/** How many recent day tabs the app offers for back-filling. */
const PICKABLE_TABS = 8;

/* ------------------------------- web app ------------------------------- */

function doGet(e) {
  return respond_(function () {
    const params = (e && e.parameter) || {};
    checkSecret_(params.secret);
    return readDaily_(SpreadsheetApp.openById(SHEET_ID), params.tab);
  });
}

function doPost(e) {
  return respond_(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkSecret_(body.secret);
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      return writeDaily_(body);
    } finally {
      lock.releaseLock();
    }
  });
}

function respond_(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function checkSecret_(given) {
  if (!SECRET || SECRET === 'PASTE_SECRET_HERE') {
    throw new Error('The entry script has no SECRET set yet.');
  }
  if (given !== SECRET) throw new Error('unauthorized');
}

function required_(value, label) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new Error('Missing ' + label + '.');
  return s;
}

/* --------------------------------- tabs --------------------------------- */

function tabTime_(name) {
  const m = String(name).match(/^\s*(\d{1,2})\s*[\/-]\s*(\d{1,2})\s*(?:[\/-]\s*(\d{2,4}))?\s*$/);
  if (!m) return null;
  let year = m[3] ? Number(m[3]) : new Date().getFullYear();
  if (year < 100) year += 2000;
  return new Date(year, Number(m[1]) - 1, Number(m[2])).getTime();
}

function todayTime_() {
  return tabTime_(Utilities.formatDate(new Date(), TIME_ZONE, 'M/d/yyyy'));
}

/** Every dated tab, oldest first. */
function datedTabs_(ss) {
  return ss
    .getSheets()
    .map(function (s) {
      return { sheet: s, name: s.getName(), t: tabTime_(s.getName()) };
    })
    .filter(function (x) {
      return x.t != null;
    })
    .sort(function (a, b) {
      return a.t - b.t;
    });
}

function latestTabUpToToday_(ss) {
  const tabs = datedTabs_(ss);
  if (!tabs.length) throw new Error('No dated day tabs found.');
  const today = todayTime_();
  const past = tabs.filter(function (t) {
    return t.t <= today;
  });
  return past.length ? past[past.length - 1] : tabs[0];
}

/** Dated tabs a person can pick, newest first: today's and the last week's, no hidden ones. */
function pickableTabs_(ss) {
  const today = todayTime_();
  return datedTabs_(ss)
    .filter(function (t) {
      return t.t <= today && !t.sheet.isSheetHidden();
    })
    .slice(-PICKABLE_TABS)
    .reverse();
}

/* ------------------------------- layout -------------------------------- */

const norm_ = function (s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
};

const isNumber_ = function (s) {
  const cleaned = String(s).replace(/,/g, '').replace(/\s/g, '');
  return cleaned !== '' && !isNaN(Number(cleaned));
};

/** "1,250" → 1250; blank or text → null. */
function num_(text) {
  const t = String(text == null ? '' : text).replace(/,/g, '').trim();
  return t !== '' && isFinite(Number(t)) ? Number(t) : null;
}

/** A date cell's real date as yyyy-mm-dd, whatever format it is shown in; '' when it isn't one. */
function isoDate_(v) {
  return v instanceof Date && !isNaN(v.getTime()) ? Utilities.formatDate(v, TIME_ZONE, 'yyyy-MM-dd') : '';
}

/**
 * Finds the header row and the stock rows: a row whose first cell isn't a number is a
 * section title, and every numbered row under it is an item.
 */
function readLayout_(sheet) {
  const lastRow = Math.min(sheet.getLastRow(), 250);
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) throw new Error('"' + sheet.getName() + '" is empty.');
  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const values = range.getDisplayValues();
  const raw = range.getValues();

  const headerIdx = values.findIndex(function (r) {
    return norm_(r[0]) === 'no';
  });
  if (headerIdx < 0) throw new Error('"' + sheet.getName() + '" has no "No" header row.');
  const header = values[headerIdx].map(norm_);
  const cols = {};
  Object.keys(HEADERS).forEach(function (key) {
    cols[key] = header.indexOf(norm_(HEADERS[key]));
  });

  const cell = function (r, col) {
    return col >= 0 ? String(r[col]).trim() : '';
  };

  const items = [];
  let section = 'General';
  for (let i = headerIdx + 1; i < values.length; i++) {
    const r = values[i];
    const first = String(r[0]).trim();
    const item = String(r[2]).trim();
    if (!first && !item) continue;
    if (!isNumber_(first)) {
      if (first) section = first;
      continue;
    }
    if (!item || isNumber_(item)) continue;
    items.push({
      row: i + 1,
      section: section,
      code: String(r[1]).trim(),
      item: item,
      opening: num_(cell(r, cols.opening)),
      production: num_(cell(r, cols.production)),
      despatch: num_(cell(r, cols.despatch)),
      closing: num_(cell(r, cols.closing)),
      orderText: cell(r, cols.order),
      deliverBy: cols.deliverBy >= 0 ? isoDate_(raw[i][cols.deliverBy]) : '',
      status: cell(r, cols.status),
    });
  }
  return { cols: cols, items: items };
}

/** Section + code + item identify a finished good: the same code appears per destination. */
function findItem_(layout, want) {
  const exact = layout.items.filter(function (x) {
    return (
      norm_(x.section) === norm_(want.section) &&
      norm_(x.code) === norm_(want.code) &&
      norm_(x.item) === norm_(want.item)
    );
  });
  if (exact.length) return exact[0];
  // A renamed section shouldn't block the write, as long as code + item is unambiguous.
  const loose = layout.items.filter(function (x) {
    return norm_(x.code) === norm_(want.code) && norm_(x.item) === norm_(want.item);
  });
  return loose.length === 1 ? loose[0] : null;
}

function listFromRule_(rule) {
  if (!rule) return null;
  const type = rule.getCriteriaType();
  const args = rule.getCriteriaValues();
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    return args[0]
      .map(function (v) {
        return String(v).trim();
      })
      .filter(String);
  }
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
    return [].concat
      .apply([], args[0].getDisplayValues())
      .map(function (v) {
        return String(v).trim();
      })
      .filter(String);
  }
  return null;
}

/** The Order Status dropdown's choices, read from the first item rows that have one. */
function statusOptions_(sheet, layout) {
  if (layout.cols.status >= 0) {
    const rows = layout.items.slice(0, 8);
    for (let i = 0; i < rows.length; i++) {
      const rule = sheet.getRange(rows[i].row, layout.cols.status + 1).getDataValidation();
      const list = listFromRule_(rule);
      if (list && list.length) return { values: list, strict: !rule.getAllowInvalid() };
    }
  }
  return { values: DEFAULT_STATUSES, strict: false };
}

/** Where the absentees value goes: the first cell after the label's merged cells. */
function absenteesCell_(sheet) {
  const top = sheet.getRange(1, 1, Math.min(6, sheet.getLastRow()), sheet.getLastColumn());
  const values = top.getDisplayValues();
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      if (norm_(values[r][c]).indexOf(ABSENTEES_LABEL) !== 0) continue;
      const merged = sheet.getRange(r + 1, c + 1).getMergedRanges();
      const col = merged.length ? merged[0].getLastColumn() + 1 : c + 2;
      return sheet.getRange(r + 1, col);
    }
  }
  return null;
}

/* -------------------------------- reading -------------------------------- */

/** A day tab as the entry page edits it, read straight from the sheet. */
function readDaily_(ss, wantedTab) {
  const tabs = pickableTabs_(ss);
  const wanted = String(wantedTab || '').trim();
  const hit = wanted
    ? datedTabs_(ss).filter(function (t) {
        return t.name === wanted;
      })[0]
    : null;
  const tab = hit || latestTabUpToToday_(ss);
  const layout = readLayout_(tab.sheet);
  const cell = absenteesCell_(tab.sheet);
  return {
    ok: true,
    tab: tab.name,
    tabs: tabs.map(function (t) {
      return t.name;
    }),
    absentees: cell ? String(cell.getDisplayValue()).trim() : '',
    statuses: statusOptions_(tab.sheet, layout).values,
    rows: layout.items.map(function (x) {
      const hasOrder = x.orderText || x.deliverBy || x.status;
      return {
        section: x.section,
        code: x.code,
        item: x.item,
        opening: x.opening,
        production: x.production,
        despatch: x.despatch,
        closing: x.closing,
        order: hasOrder
          ? { qty: num_(x.orderText), text: x.orderText, deliverBy: x.deliverBy, status: x.status }
          : null,
      };
    }),
  };
}

/* -------------------------------- writing -------------------------------- */

/** yyyy-mm-dd → midnight on that date in the spreadsheet's own time zone. */
function isoToSheetDate_(ss, iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) throw new Error('Deliver By must be a date (yyyy-mm-dd).');
  return Utilities.parseDate(iso + ' 00:00', ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
}

function colOrThrow_(layout, key, tabName) {
  if (layout.cols[key] < 0) {
    throw new Error('"' + tabName + '" has no "' + HEADERS[key] + '" column.');
  }
  return layout.cols[key] + 1;
}

/**
 * Writes Production / Despatch per item, the absentees note and orders on one day tab.
 * Everything is checked first and written after, so a bad row can't leave a half-saved day.
 * Production and Despatch go to the chosen tab only (later days' Opening is a formula on
 * this Closing); an order also goes to later tabs that already exist, so a tab created in
 * advance doesn't miss it. Carrying orders forward stays with the sheet's own Next Day.
 */
function writeDaily_(body) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const name = required_(body.tab, 'tab');
  const tabs = datedTabs_(ss);
  const start = tabs.findIndex(function (t) {
    return t.name === name;
  });
  if (start < 0) throw new Error('There is no ' + name + ' tab.');
  const tab = tabs[start];

  const layouts = {};
  const layoutOf = function (t) {
    if (!layouts[t.name]) layouts[t.name] = readLayout_(t.sheet);
    return layouts[t.name];
  };
  const layout = layoutOf(tab);
  const statuses = statusOptions_(tab.sheet, layout);

  const plan = []; // each: { range, run(range) }
  const set = function (range, value) {
    plan.push({
      range: range,
      run: function () {
        if (value === null) range.clearContent();
        else range.setValue(value);
      },
    });
  };

  (body.entries || []).forEach(function (entry) {
    const want = {
      section: required_(entry.section, 'section'),
      code: String(entry.code == null ? '' : entry.code).trim(),
      item: required_(entry.item, 'item'),
    };
    const hit = findItem_(layout, want);
    if (!hit) throw new Error('"' + want.item + '" is not on the ' + name + ' tab.');

    ['production', 'despatch'].forEach(function (field) {
      const v = entry[field];
      if (v === undefined) return;
      if (v !== null && (typeof v !== 'number' || !isFinite(v) || v < 0)) {
        throw new Error('"' + want.item + '": ' + field + ' must be zero or more.');
      }
      const range = tab.sheet.getRange(hit.row, colOrThrow_(layout, field, name));
      // A formula in the cell means something else owns it; refuse rather than overwrite it.
      if (range.getFormula()) {
        throw new Error('"' + want.item + '": ' + field + ' is calculated on the sheet.');
      }
      set(range, v);
    });

    if (entry.order !== undefined) planOrder_(entry.order, want, tabs.slice(start), layoutOf, statuses, ss, plan);
  });

  let absenteesCell = null;
  if (body.absentees !== undefined) {
    absenteesCell = absenteesCell_(tab.sheet);
    if (!absenteesCell) throw new Error('Could not find the absentees cell on "' + name + '".');
  }

  plan.forEach(function (p) {
    p.run();
  });
  if (absenteesCell) {
    const text = String(body.absentees).trim();
    if (text) absenteesCell.setNumberFormat('@').setValue(text);
    else absenteesCell.clearContent();
  }
  SpreadsheetApp.flush();
  return { ok: true, tab: name, cells: plan.length + (absenteesCell ? 1 : 0) };
}

/** Adds the writes for one item's order (set or clear) on the chosen tab and later ones. */
function planOrder_(order, want, targets, layoutOf, statuses, ss, plan) {
  const isSet = order.action === 'set';
  let qty = null;
  let date = null;
  let status = '';
  if (isSet) {
    qty = Number(order.qty);
    if (!isFinite(qty) || qty <= 0) throw new Error('"' + want.item + '": order quantity must be above zero.');
    date = isoToSheetDate_(ss, order.deliverBy);
    status = required_(order.status, 'order status');
    if (statuses.strict && statuses.values.indexOf(status) < 0) {
      throw new Error('"' + want.item + '": "' + status + '" is not one of ' + statuses.values.join(', ') + '.');
    }
  } else if (order.action !== 'clear') {
    throw new Error('"' + want.item + '": order action must be set or clear.');
  }

  targets.forEach(function (t, i) {
    const layout = layoutOf(t);
    const hit = findItem_(layout, want);
    if (!hit) {
      // The tab being edited must have the item; later tabs may not.
      if (i === 0) throw new Error('"' + want.item + '" is not on the ' + t.name + ' tab.');
      return;
    }
    const orderCell = t.sheet.getRange(hit.row, colOrThrow_(layout, 'order', t.name));
    const dateCol = layout.cols.deliverBy + 1;
    const statusCol = layout.cols.status + 1;

    plan.push({
      range: orderCell,
      run: function () {
        if (!isSet) {
          orderCell.clearContent().clearNote();
          if (dateCol > 0) t.sheet.getRange(hit.row, dateCol).clearContent();
          if (statusCol > 0) t.sheet.getRange(hit.row, statusCol).clearContent();
          return;
        }
        orderCell.setValue(qty);
        orderCell.setNote('Entered from Store Entry · ' + Utilities.formatDate(new Date(), TIME_ZONE, 'd MMM yyyy, HH:mm'));
        if (dateCol > 0) {
          const dateCell = t.sheet.getRange(hit.row, dateCol);
          dateCell.setValue(date);
          const fmt = dateCell.getNumberFormat();
          if (!/d/i.test(fmt) || !/y/i.test(fmt)) dateCell.setNumberFormat('M/d/yyyy');
        }
        if (statusCol > 0) t.sheet.getRange(hit.row, statusCol).setValue(status);
      },
    });
  });
}

/* -------------------------------- setup -------------------------------- */

/** Run once from the editor: checks it can read the sheet and shows what it found. */
function setup() {
  checkSecret_(SECRET);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const tab = latestTabUpToToday_(ss);
  const layout = readLayout_(tab.sheet);
  const cell = absenteesCell_(tab.sheet);
  const options = statusOptions_(tab.sheet, layout);
  const letter = function (i) {
    return i < 0 ? 'NOT FOUND' : String.fromCharCode(65 + i);
  };

  Logger.log('Latest day tab: ' + tab.name + ' (' + layout.items.length + ' items)');
  Object.keys(HEADERS).forEach(function (key) {
    Logger.log(HEADERS[key] + ': column ' + letter(layout.cols[key]));
  });
  Logger.log('Absentees cell: ' + (cell ? cell.getA1Notation() : 'NOT FOUND'));
  Logger.log('Status choices: ' + options.values.join(', ') + (options.strict ? ' (dropdown)' : ''));
  Logger.log('Now deploy as a web app (or Manage deployments → Edit → New version).');
}
