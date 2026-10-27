import type { Config } from "@netlify/functions";
import type { DailyData, DailyWrite, NewItem, OrderEdit } from "../../src/types";
import { authorize, callScript, env, json, scriptConfigured, text } from "../lib/script";

/**
 * Reads a day tab live and writes Production, Despatch, Absentees and orders into it.
 * Reads are open, like the sheet's published figures; writes need APP_PASSCODE.
 */

const DEFAULT_STATUSES = ["PENDING", "MET"];

/** A quantity, or null to clear the cell. Returns undefined when the field was omitted. */
function quantity(v: unknown): number | null | undefined | "bad" {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? n : "bad";
}

const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function parseOrder(raw: unknown): OrderEdit | string {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.action === "clear") return { action: "clear" };
  if (o.action !== "set") return "Order action must be set or clear.";
  const qty = typeof o.qty === "number" ? o.qty : Number.NaN;
  if (!Number.isFinite(qty) || qty <= 0) return "Order quantity must be above zero.";
  if (!isIsoDate(o.deliverBy)) return "Pick a deliver-by date for the order.";
  const status = text(o.status, 60);
  if (!status) return "Pick an order status.";
  return { action: "set", qty, deliverBy: o.deliverBy, status };
}

function parseNewItem(raw: unknown): NewItem | string {
  const n = (raw ?? {}) as Record<string, unknown>;
  const item: NewItem = {
    section: text(n.section),
    code: text(n.code, 40),
    item: text(n.item),
    opening: 0,
    mini: null,
  };
  if (!item.section) return "Pick the section for the new item.";
  if (!item.item) return "Give the new item a name.";
  const opening = quantity(n.opening ?? 0);
  if (opening === "bad" || opening === undefined) return `"${item.item}": opening stock must be zero or more.`;
  item.opening = opening ?? 0;
  const mini = quantity(n.mini ?? null);
  if (mini === "bad") return `"${item.item}": minimum level must be zero or more.`;
  item.mini = mini ?? null;
  return item;
}

/** The bulk check is a different web app; don't let a slow one hold a save open. */
const BULK_TIMEOUT_MS = 20_000;

/**
 * Ask the stock alert whether these production figures fit the bulk, BEFORE anything
 * is written. Returns null to allow the save, or the message to refuse it with.
 *
 * The sheet has had this check since September, as an onEdit trigger. onEdit fires
 * only when a person edits a cell in the browser — never when a script writes one —
 * so every entry made through this app went straight past it. On 25 October a typed
 * entry of 16 units was refused and left its note on the cell; the 194 that ended up
 * in the same cell, and the 110 on the 27th, came through here and were never
 * checked. 10 KG ECO reached -1,178 kg.
 *
 * The rule is NOT reimplemented here. Which bulk an item draws on, whether the
 * quantity fits, and the wording of the refusal all come from the alert's own
 * guardcheck action, because a second copy of those rules is how the peanut and
 * pumpkin columns went wrong twice. This only asks, and relays the answer.
 *
 * It fails CLOSED: if the check cannot be reached, nothing is saved. That is the
 * deliberate choice — an unchecked entry is what put ECO 1,178 kg under. The escape
 * hatch is in the sheet, not here: PACKING GUARD on the BULK STOCK tab set to OFF
 * turns the check off, or WARN lets entries through with a note.
 */
async function bulkRefusal(write: DailyWrite): Promise<string | null> {
  const wanted = write.entries.filter((e) => typeof e.production === "number" && e.production > 0);
  if (!wanted.length) return null;

  const url = env("SEED_ALERT_URL");
  const token = env("SEED_ALERT_TOKEN");
  if (!url || !token) {
    return "Bulk stock can't be checked yet, so nothing was saved — SEED_ALERT_URL and SEED_ALERT_TOKEN are not set on this site.";
  }

  let items: { section: string; item: string; added: number }[];
  try {
    // The INCREASE, not the figure being written. The cell may already hold
    // production for the day, and re-saving an unchanged figure must not be refused
    // for bulk that the first save already spent.
    const day = await callScript({ method: "GET", params: { tab: write.tab } });
    const rows = (day.rows as DailyData["rows"] | undefined) ?? [];
    items = wanted
      .map((e) => {
        const was = rows.find((r) => r.section === e.section && r.code === e.code && r.item === e.item);
        return {
          section: e.section,
          item: e.item,
          added: (e.production as number) - (was?.production ?? 0),
        };
      })
      .filter((x) => x.added > 0);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `Couldn't read the ${write.tab} tab to check bulk stock, so nothing was saved. ${why}`;
  }
  if (!items.length) return null;

  const ask = new URL(url);
  ask.searchParams.set("token", token);
  ask.searchParams.set("action", "guardcheck");
  ask.searchParams.set("items", JSON.stringify(items));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BULK_TIMEOUT_MS);
  try {
    const res = await fetch(ask, { redirect: "follow", signal: controller.signal });
    const body = await res.text();
    let reply: {
      ok?: boolean;
      error?: string;
      mode?: string;
      message?: string;
      blocked?: { text?: string }[];
    };
    try {
      reply = JSON.parse(body) as typeof reply;
    } catch {
      return "Bulk stock couldn't be checked, so nothing was saved — the stock alert didn't answer properly. Check it is deployed as a web app with access for Anyone.";
    }
    if (reply.ok !== true) {
      return `Bulk stock couldn't be checked, so nothing was saved: ${reply.error ?? "the stock alert refused the request"}.`;
    }
    if (reply.blocked?.length) {
      const detail = reply.message || reply.blocked.map((b) => b.text ?? "").filter(Boolean).join("\n");
      return `Not enough bulk stock — nothing was saved.\n${detail}\n\nCount the taste on the dashboard if the bulk is really there, or set PACKING GUARD to WARN on the BULK STOCK tab.`;
    }
    return null;
  } catch (err) {
    const why = err instanceof Error && err.name === "AbortError"
      ? "it took too long to answer"
      : "it could not be reached";
    return `Bulk stock couldn't be checked (${why}), so nothing was saved. Try again in a moment — or set PACKING GUARD to OFF on the BULK STOCK tab to allow entry without the check.`;
  } finally {
    clearTimeout(timer);
  }
}

/** Accepts only the fields the script needs, so nothing else reaches the sheet. */
function parseWrite(body: unknown): DailyWrite | string {
  if (!body || typeof body !== "object") return "Expected a JSON body.";
  const b = body as Record<string, unknown>;
  const tab = text(b.tab, 40);
  if (!tab) return "Which day is this for?";
  if (!Array.isArray(b.entries)) return "Nothing to save.";
  if (b.entries.length > 200) return "Too many items in one save.";

  const entries: DailyWrite["entries"] = [];
  for (const raw of b.entries) {
    const e = (raw ?? {}) as Record<string, unknown>;
    const entry: DailyWrite["entries"][number] = {
      section: text(e.section),
      code: text(e.code, 40),
      item: text(e.item),
    };
    if (!entry.section || !entry.item) return "Which item is this for?";

    const production = quantity(e.production);
    const despatch = quantity(e.despatch);
    if (production === "bad" || despatch === "bad") {
      return `Quantities for "${entry.item}" must be zero or more.`;
    }
    if (production !== undefined) entry.production = production;
    if (despatch !== undefined) entry.despatch = despatch;
    if (e.order !== undefined) {
      const order = parseOrder(e.order);
      if (typeof order === "string") return `"${entry.item}": ${order}`;
      entry.order = order;
    }
    if (production === undefined && despatch === undefined && entry.order === undefined) continue;
    entries.push(entry);
  }

  const write: DailyWrite = { tab, entries };
  if (b.absentees !== undefined) write.absentees = text(b.absentees, 60);
  if (Array.isArray(b.newItems) && b.newItems.length) {
    if (b.newItems.length > 20) return "Too many new items in one save.";
    const items: NewItem[] = [];
    for (const raw of b.newItems) {
      const parsed = parseNewItem(raw);
      if (typeof parsed === "string") return parsed;
      items.push(parsed);
    }
    write.newItems = items;
  }
  if (entries.length === 0 && write.absentees === undefined && !write.newItems) return "Nothing to save.";
  return write;
}

export default async (req: Request) => {
  const configured = scriptConfigured();

  if (req.method === "GET") {
    const empty: DailyData = {
      configured,
      tab: "",
      tabs: [],
      absentees: "",
      statuses: DEFAULT_STATUSES,
      rows: [],
    };
    if (!configured) return json(empty);
    try {
      const tab = text(new URL(req.url).searchParams.get("tab"), 40);
      const reply = await callScript({ method: "GET", params: tab ? { tab } : {} });
      const statuses = reply.statuses as string[] | undefined;
      const data: DailyData = {
        configured: true,
        tab: String(reply.tab ?? ""),
        tabs: (reply.tabs as string[] | undefined) ?? [],
        absentees: String(reply.absentees ?? ""),
        statuses: statuses?.length ? statuses : DEFAULT_STATUSES,
        rows: (reply.rows as DailyData["rows"] | undefined) ?? [],
      };
      return json(data);
    } catch (err) {
      return json({ ...empty, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.method !== "POST") return json({ message: `${req.method} not supported.` }, 405);

  const denied = authorize(req);
  if (denied) return denied;
  if (!configured) {
    return json(
      { message: "Entry isn't connected to the sheet yet (ENTRY_SCRIPT_URL is not set)." },
      503,
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }

  // Make the next day tab (what ➕ Next Day does in the sheet).
  if (raw && typeof raw === "object" && (raw as { action?: unknown }).action === "nextDay") {
    const date = (raw as { date?: unknown }).date;
    if (!isIsoDate(date)) return json({ message: "Pick the date of the new day." }, 400);
    if (!env("NEXTDAY_SCRIPT_URL")) {
      return json(
        { message: "Creating a day from the app isn't set up yet (NEXTDAY_SCRIPT_URL). Use ➕ Next Day in the sheet." },
        503,
      );
    }
    try {
      // The sheet's own Next Day makes the tab, so the app and the menu build identical
      // days. It only QUEUES here: the work reads every tab and writes a new one, which
      // does not fit in the 25 seconds we wait. The client polls nextDayStatus.
      const reply = await callScript({ method: "POST", body: { action: "nextDay", date } }, "NEXTDAY_SCRIPT_URL");
      return json({ ok: true, queued: reply.queued !== false, pending: true, date: reply.date ?? date });
    } catch (err) {
      return json({ message: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // How the queued day is getting on.
  if (raw && typeof raw === "object" && (raw as { action?: unknown }).action === "nextDayStatus") {
    if (!env("NEXTDAY_SCRIPT_URL")) return json({ message: "Not set up (NEXTDAY_SCRIPT_URL)." }, 503);
    try {
      const reply = await callScript({ method: "POST", body: { action: "nextDayStatus" } }, "NEXTDAY_SCRIPT_URL");
      return json({
        ok: true,
        state: reply.state ?? "idle",
        tab: reply.tab,
        from: reply.from,
        ordersKept: reply.ordersKept ?? 0,
        ordersDropped: reply.ordersDropped ?? 0,
        error: reply.error,
      });
    } catch (err) {
      return json({ message: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  const parsed: DailyWrite | string = raw === null ? "Expected a JSON body." : parseWrite(raw);
  if (typeof parsed === "string") return json({ message: parsed }, 400);

  try {
    const refusal = await bulkRefusal(parsed);
    if (refusal) return json({ message: refusal }, 409);
    const reply = await callScript({ method: "POST", body: parsed });
    return json({ ok: true, tab: reply.tab, cells: reply.cells ?? 0 });
  } catch (err) {
    return json({ message: err instanceof Error ? err.message : String(err) }, 502);
  }
};

export const config: Config = { path: "/api/daily" };
