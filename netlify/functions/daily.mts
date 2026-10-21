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
    const reply = await callScript({ method: "POST", body: parsed });
    return json({ ok: true, tab: reply.tab, cells: reply.cells ?? 0 });
  } catch (err) {
    return json({ message: err instanceof Error ? err.message : String(err) }, 502);
  }
};

export const config: Config = { path: "/api/daily" };
