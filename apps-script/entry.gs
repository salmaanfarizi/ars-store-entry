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
 *   1. Paste this file into a new Apps Script project. In Project Settings → Script Properties
 *      add SECRET with a long random value. Keep it there, never in this file: the repository
 *      is shared, and the site's build refuses to deploy a secret it finds in the code.
 *   2. Run `setup` once from the editor and allow access when Google asks. The log shows the
 *      tab and the columns it found.
 *   3. Deploy → New deployment → Web app. Execute as: Me. Who has access: Anyone. Copy the
 *      web app URL into the site's ENTRY_SCRIPT_URL setting.
 *
 * After editing this file, deploy again with Manage deployments → Edit → New version, so
 * the URL stays the same.
 */

const SHEET_ID = '1l1YuOxJ5W-lWxD-xgC2ZlfatNxDN4HuVAbaf4SL4vxU';

/** "salesman requisition and transfer": the requisition app's sheet, where transfers are kept too. */
const REQ_SHEET_ID = '1_4gVRDumT2YYDYAQFGZMR8FdJRI1MvV7rVkUoVWLFlg';

/** Same columns, in the same order, as the old stock-transfer app wrote them. */
const TRANSFER_HEADER = [
  'doc_no', 'trf_date', 'salesman', 'route', 'requisition_ref',
  'item_code', 'item_name', 'unit',
  'stock_transfer', 'physical_stock', 'system_stock', 'pieces_reimbursed', 'variance',
  'notes', 'created_at',
];

const TRANSFER_UNITS = ['Bag', 'Bundle', 'Box', 'Carton'];

/** How many past transfers the app lists. */
const RECENT_TRANSFERS = 40;

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
  mini: 'Mini Level',
  required: 'Required Qty',
};

/** The cell above the absentees entry; its value sits just right of the label's merged cells. */
const ABSENTEES_LABEL = 'no. of absentees';

/** The sheet's own Order Status dropdown; offered if a tab is missing it. Blank = pending. */
const DEFAULT_STATUSES = ['PENDING', 'MET'];

/** How many recent day tabs the app offers for back-filling. */
const PICKABLE_TABS = 8;

/** Despatch history read for each item, to tell fast movers from slow ones. */
const HISTORY_TABS = 14;

/** Past day tabs barely change, so their despatch figures are cached this long (seconds). */
const HISTORY_CACHE_SECONDS = 6 * 60 * 60;

/* ------------------------------- web app ------------------------------- */

function doGet(e) {
  return respond_(function () {
    const params = (e && e.parameter) || {};
    checkSecret_(params.secret);
    if (params.view === 'transfers') return readTransfers_();
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
      return body.action === 'transfer' ? writeTransfer_(body) : writeDaily_(body);
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

/** The shared secret, from Script Properties (Project Settings → Script Properties → SECRET). */
function secret_() {
  return String(PropertiesService.getScriptProperties().getProperty('SECRET') || '').trim();
}

function checkSecret_(given) {
  const secret = secret_();
  if (!secret) throw new Error('The entry script has no SECRET in its Script Properties yet.');
  if (given !== secret) throw new Error('unauthorized');
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
      mini: num_(cell(r, cols.mini)),
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
  const history = despatchHistory_(ss, tab, layout);
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
        mini: x.mini,
        movement: history.movement(x),
        order: hasOrder
          ? { qty: num_(x.orderText), text: x.orderText, deliverBy: x.deliverBy, status: x.status }
          : null,
      };
    }),
  };
}

/** Section + code + item as one string, the way the app tells items apart. */
function itemKey_(x) {
  return norm_(x.section) + '|' + norm_(x.code) + '|' + norm_(x.item);
}

/**
 * Despatch over the last HISTORY_TABS day tabs up to and including `tab`: on how many days
 * each item went out, and how much in total. Past tabs come from the script cache.
 */
function despatchHistory_(ss, tab, layout) {
  const today = todayTime_();
  const tabs = datedTabs_(ss)
    .filter(function (t) {
      return t.t <= tab.t;
    })
    .slice(-HISTORY_TABS);
  const cache = CacheService.getScriptCache();
  const perTab = tabs.map(function (t) {
    if (t.name === tab.name) return despatchMap_(layout);
    const key = 'despatch:' + t.name;
    const cached = t.t < today ? cache.get(key) : null;
    if (cached) return JSON.parse(cached);
    let map = {};
    try {
      map = despatchMap_(readLayout_(t.sheet));
    } catch (err) {
      map = {}; // an odd old tab shouldn't stop today's entry
    }
    if (t.t < today) {
      try {
        cache.put(key, JSON.stringify(map), HISTORY_CACHE_SECONDS);
      } catch (err) {
        /* too large to cache; read again next time */
      }
    }
    return map;
  });

  return {
    movement: function (x) {
      const k = itemKey_(x);
      let active = 0;
      let total = 0;
      perTab.forEach(function (m) {
        const v = m[k];
        if (v > 0) {
          active++;
          total += v;
        }
      });
      return { days: perTab.length, active: active, total: total };
    },
  };
}

function despatchMap_(layout) {
  const map = {};
  layout.items.forEach(function (x) {
    if (x.despatch) map[itemKey_(x)] = x.despatch;
  });
  return map;
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

  const newItems = (body.newItems || []).map(function (spec) {
    return checkNewItem_(spec, layout, name);
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
  // Inserting rows moves everything below, so it comes after every other write.
  newItems.forEach(function (spec) {
    addItem_(tab.sheet, spec);
  });
  SpreadsheetApp.flush();
  return {
    ok: true,
    tab: name,
    cells: plan.length + (absenteesCell ? 1 : 0) + newItems.length,
    added: newItems.length,
  };
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

/* ------------------------------- new items ------------------------------- */

function checkNewItem_(spec, layout, tabName) {
  const want = {
    section: required_(spec.section, 'section for the new item'),
    code: String(spec.code == null ? '' : spec.code).trim(),
    item: required_(spec.item, 'item name'),
  };
  const inSection = layout.items.filter(function (x) {
    return norm_(x.section) === norm_(want.section);
  });
  if (!inSection.length) throw new Error('There is no "' + want.section + '" section on the ' + tabName + ' tab.');
  const same = inSection.filter(function (x) {
    return norm_(x.code) === norm_(want.code) && norm_(x.item) === norm_(want.item);
  });
  if (same.length) throw new Error('"' + want.item + '" is already in ' + want.section + '.');
  const opening = Number(spec.opening == null ? 0 : spec.opening);
  if (!isFinite(opening) || opening < 0) throw new Error('"' + want.item + '": opening stock must be zero or more.');
  let mini = null;
  if (spec.mini != null && spec.mini !== '') {
    mini = Number(spec.mini);
    if (!isFinite(mini) || mini < 0) throw new Error('"' + want.item + '": minimum level must be zero or more.');
  }
  ['opening', 'production', 'despatch', 'closing'].forEach(function (key) {
    colOrThrow_(layout, key, tabName);
  });
  return { section: want.section, code: want.code, item: want.item, opening: opening, mini: mini };
}

function colLetter_(i) {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Adds an item as a new row at the end of its section, formatted like the row above it,
 * with the same Closing and Required Qty formulas the sheet uses. Opening is typed in, since
 * there is no row for it on the previous day. Items are then renumbered 1, 2, 3… as before.
 */
function addItem_(sheet, spec) {
  const layout = readLayout_(sheet);
  const c = layout.cols;
  const inSection = layout.items.filter(function (x) {
    return norm_(x.section) === norm_(spec.section);
  });
  const above = inSection[inSection.length - 1].row;
  const r = above + 1;
  sheet.insertRowAfter(above);

  const width = sheet.getLastColumn();
  const source = sheet.getRange(above, 1, 1, width);
  const target = sheet.getRange(r, 1, 1, width);
  source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  source.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);

  const L = function (key) {
    return colLetter_(c[key]) + r;
  };
  sheet.getRange(r, 2).setValue(spec.code);
  sheet.getRange(r, 3).setValue(spec.item);
  sheet.getRange(r, c.opening + 1).setValue(spec.opening);
  sheet.getRange(r, c.closing + 1).setFormula('=' + L('opening') + '+' + L('production') + '-' + L('despatch'));
  if (c.mini >= 0 && spec.mini != null) sheet.getRange(r, c.mini + 1).setValue(spec.mini);
  if (c.required >= 0 && c.mini >= 0) {
    sheet
      .getRange(r, c.required + 1)
      .setFormula('=IF($' + L('mini') + '="","",' + L('mini') + '-' + L('closing') + ')');
  }
  const note = 'Added from Store Entry · ' + Utilities.formatDate(new Date(), TIME_ZONE, 'd MMM yyyy, HH:mm');
  sheet.getRange(r, 3).setNote(note);

  // Renumber every item row, so the No column keeps counting 1, 2, 3… down the tab.
  sheet.getRange(r, 1).setValue(0);
  SpreadsheetApp.flush();
  readLayout_(sheet).items.forEach(function (x, i) {
    const cell = sheet.getRange(x.row, 1);
    if (Number(cell.getValue()) !== i + 1) cell.setValue(i + 1);
  });
}

/* ------------------------------- transfers ------------------------------- */

function reqSheet_(name) {
  const sheet = SpreadsheetApp.openById(REQ_SHEET_ID).getSheetByName(name);
  if (!sheet) throw new Error('The requisition sheet has no "' + name + '" tab.');
  return sheet;
}

/** A tab's rows as display text, header included. */
function rowsOf_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return [];
  return sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
}

/** First column whose header contains one of the needles (as the old apps read Items and Salesmen). */
function colOf_(header, needles, fallback) {
  const lower = header.map(norm_);
  for (let n = 0; n < needles.length; n++) {
    const i = lower.findIndex(function (h) {
      return h.indexOf(needles[n]) >= 0;
    });
    if (i >= 0) return i;
  }
  return fallback;
}

/** "2026-06-22", or a date cell shown some other way, as yyyy-mm-dd. */
function isoOf_(text) {
  const t = String(text || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
  return t;
}

/**
 * What the transfer screen needs: open requisitions (no transfer made against them yet) with
 * their lines, recent transfers, the item list with units, and the salesmen by route.
 */
function readTransfers_() {
  const itemRows = rowsOf_(reqSheet_('Items'));
  const ih = itemRows[0] || [];
  const codeI = colOf_(ih, ['code'], 0);
  const nameI = colOf_(ih, ['name', 'item', 'description'], 1);
  const unitI = colOf_(ih, ['uom', 'unit'], -1);
  const items = itemRows
    .slice(1)
    .map(function (r) {
      return {
        code: String(r[codeI] || '').trim(),
        name: String(r[nameI] || '').trim(),
        unit: unitI >= 0 ? String(r[unitI] || '').trim() : '',
      };
    })
    .filter(function (i) {
      return i.name;
    });

  const smRows = rowsOf_(reqSheet_('Salesmen'));
  const sh = smRows[0] || [];
  const routeI = colOf_(sh, ['route', 'area'], 0);
  const smI = colOf_(sh, ['salesman', 'sales', 'name', 'man'], 1);
  const salesmen = smRows
    .slice(1)
    .map(function (r) {
      return { route: String(r[routeI] || '').trim(), name: String(r[smI] || '').trim() };
    })
    .filter(function (s) {
      return s.route || s.name;
    });

  const trfRows = rowsOf_(reqSheet_('Transfers'));
  const used = {};
  const transfers = {};
  const order = [];
  trfRows.slice(1).forEach(function (r) {
    const doc = String(r[0] || '').trim();
    if (!doc) return;
    if (r[4]) used[String(r[4]).trim()] = doc;
    if (!transfers[doc]) {
      transfers[doc] = {
        docNo: doc,
        date: isoOf_(r[1]),
        salesman: String(r[2] || ''),
        route: String(r[3] || ''),
        requisitionRef: String(r[4] || ''),
        notes: String(r[13] || ''),
        createdAt: String(r[14] || ''),
        lines: [],
      };
      order.push(doc);
    }
    transfers[doc].lines.push({
      code: String(r[5] || ''),
      name: String(r[6] || ''),
      unit: String(r[7] || ''),
      stockTransfer: num_(r[8]) || 0,
      physicalStock: num_(r[9]) || 0,
      systemStock: num_(r[10]) || 0,
      piecesReimbursed: num_(r[11]) || 0,
      variance: num_(r[12]) || 0,
    });
  });

  const reqRows = rowsOf_(reqSheet_('Requisitions'));
  const reqs = {};
  const reqOrder = [];
  reqRows.slice(1).forEach(function (r) {
    const doc = String(r[0] || '').trim();
    if (!doc || used[doc]) return;
    if (!reqs[doc]) {
      reqs[doc] = {
        docNo: doc,
        date: isoOf_(r[1]),
        salesman: String(r[2] || ''),
        route: String(r[3] || ''),
        notes: String(r[8] || ''),
        lines: [],
      };
      reqOrder.push(doc);
    }
    reqs[doc].lines.push({
      code: String(r[4] || ''),
      name: String(r[5] || ''),
      unit: String(r[6] || ''),
      quantity: num_(r[7]) || 0,
    });
  });

  const newestFirst = function (a, b) {
    return a < b ? 1 : a > b ? -1 : 0;
  };
  return {
    ok: true,
    items: items,
    salesmen: salesmen,
    units: TRANSFER_UNITS,
    requisitions: reqOrder.sort(newestFirst).map(function (d) {
      return reqs[d];
    }),
    transfers: order
      .sort(newestFirst)
      .slice(0, RECENT_TRANSFERS)
      .map(function (d) {
        return transfers[d];
      }),
  };
}

/** TRF-<year>-0001, one more than the highest number used this year (as the old app numbered). */
function nextTransferNo_(rows) {
  const year = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy');
  const prefix = 'TRF-' + year + '-';
  let max = 0;
  rows.slice(1).forEach(function (r) {
    const dn = String(r[0] || '');
    if (dn.indexOf(prefix) !== 0) return;
    const n = parseInt(dn.slice(prefix.length), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return prefix + ('000' + (max + 1)).slice(-4);
}

function amount_(v, label, item) {
  const n = Number(v == null || v === '' ? 0 : v);
  if (!isFinite(n) || n < 0) throw new Error('"' + item + '": ' + label + ' must be zero or more.');
  return n;
}

/**
 * Saves a stock transfer to a salesman. Rows go to the Transfers tab of the requisition sheet,
 * exactly as the old transfer app wrote them, and each line's quantity is added to Despatch on
 * the day tab for the transfer's date, against the store row the person chose for it.
 * Everything is checked before anything is written.
 */
function writeTransfer_(body) {
  const date = String(body.date || '').trim();
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('Pick the transfer date.');
  const route = String(body.route || '').trim();
  const salesman = String(body.salesman || '').trim();
  if (!route && !salesman) throw new Error('Pick the route or salesman.');
  const ref = String(body.requisitionRef || '').trim();
  const notes = String(body.notes || '').trim().slice(0, 300);

  const trfSheet = reqSheet_('Transfers');
  const existing = rowsOf_(trfSheet);
  if (ref) {
    const dup = existing.slice(1).filter(function (r) {
      return String(r[4] || '').trim() === ref;
    })[0];
    if (dup) throw new Error(ref + ' was already transferred as ' + dup[0] + '.');
  }

  const lines = (body.lines || []).map(function (l) {
    const item = required_(l.name || l.code, 'item');
    const line = {
      code: String(l.code || '').trim(),
      name: String(l.name || '').trim(),
      unit: String(l.unit || '').trim(),
      stockTransfer: amount_(l.stockTransfer, 'transfer quantity', item),
      physicalStock: amount_(l.physicalStock, 'physical stock', item),
      systemStock: amount_(l.systemStock, 'system stock', item),
      piecesReimbursed: amount_(l.piecesReimbursed, 'pieces reimbursed', item),
      target: l.target || null,
    };
    if (!line.code) throw new Error('"' + item + '" has no item code.');
    return line;
  });
  if (!lines.length) throw new Error('Add at least one item.');

  // Despatch: the day tab for the transfer's date, and the store row for each line.
  const dayName = Number(m[2]) + '/' + Number(m[3]) + '/' + m[1];
  const despatch = lines.filter(function (l) {
    return l.target && l.stockTransfer > 0;
  });
  const plan = [];
  if (despatch.length) {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const day = datedTabs_(ss).filter(function (t) {
      return t.name === dayName;
    })[0];
    if (!day) {
      throw new Error('There is no ' + dayName + ' tab in the store sheet yet, so Despatch has nowhere to go. Make the day with ➕ Next Day first.');
    }
    const layout = readLayout_(day.sheet);
    const col = colOrThrow_(layout, 'despatch', dayName);
    const added = {};
    despatch.forEach(function (l) {
      const hit = findItem_(layout, {
        section: required_(l.target.section, 'store section'),
        code: String(l.target.code || '').trim(),
        item: required_(l.target.item, 'store item'),
      });
      if (!hit) throw new Error('"' + l.target.item + '" is not on the ' + dayName + ' tab.');
      const range = day.sheet.getRange(hit.row, col);
      if (range.getFormula()) throw new Error('"' + l.target.item + '": Despatch is calculated on the sheet.');
      // Two lines can land on the same store row; add them up rather than overwrite.
      const key = String(hit.row);
      if (!added[key]) {
        added[key] = { range: range, item: hit.item, start: Number(range.getValue()) || 0, plus: 0 };
        plan.push(added[key]);
      }
      added[key].plus += l.stockTransfer;
    });
  }

  const docNo = nextTransferNo_(existing.length ? existing : [TRANSFER_HEADER]);
  const createdAt = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
  const rows = lines.map(function (l) {
    return [
      docNo, date, salesman, route, ref,
      l.code, l.name, l.unit,
      l.stockTransfer, l.physicalStock, l.systemStock, l.piecesReimbursed, l.physicalStock - l.systemStock,
      notes, createdAt,
    ];
  });

  if (!existing.length) {
    trfSheet.getRange(1, 1, 1, TRANSFER_HEADER.length).setValues([TRANSFER_HEADER]);
  }
  const start = trfSheet.getLastRow() + 1;
  const block = trfSheet.getRange(start, 1, rows.length, TRANSFER_HEADER.length);
  // Text columns stay text (no date or number guessing), as the old app's RAW writes left them.
  trfSheet.getRange(start, 1, rows.length, 8).setNumberFormat('@');
  trfSheet.getRange(start, 14, rows.length, 2).setNumberFormat('@');
  block.setValues(rows);

  plan.forEach(function (p) {
    p.range.setValue(p.start + p.plus);
  });
  SpreadsheetApp.flush();

  return {
    ok: true,
    docNo: docNo,
    day: dayName,
    despatched: plan.map(function (p) {
      return { item: p.item, added: p.plus, despatch: p.start + p.plus };
    }),
  };
}

/* -------------------------------- setup -------------------------------- */

/** Run once from the editor: checks it can read the sheet and shows what it found. */
function setup() {
  checkSecret_(secret_());
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
