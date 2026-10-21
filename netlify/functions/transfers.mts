import type { Config } from "@netlify/functions";
import type { TransferData, TransferWrite } from "../../src/types";
import { authorize, callScript, json, scriptConfigured, text } from "../lib/script";

/**
 * Stock transfers to salesmen: reads open requisitions and past transfers from the requisition
 * app's sheet, and saves a transfer there while adding its quantities to the store's Despatch.
 * Reads are open; saving needs APP_PASSCODE.
 */

const amount = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? n : null;
};

const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Accepts only the fields the script needs, so nothing else reaches the sheet. */
function parseWrite(body: unknown): TransferWrite | string {
  if (!body || typeof body !== "object") return "Expected a JSON body.";
  const b = body as Record<string, unknown>;
  if (!isIsoDate(b.date)) return "Pick the transfer date.";
  const kind =
    b.kind === "direct" || b.kind === "warehouse" || b.kind === "adjustment" ? b.kind : "route";
  const reason = b.adjustReason;
  const adjustReason =
    kind === "adjustment" && (reason === "replaced" || reason === "damaged" || reason === "other")
      ? reason
      : "";
  const write: TransferWrite = {
    kind,
    date: b.date,
    route: text(b.route, 80),
    salesman: text(b.salesman, 80),
    requisitionRef: text(b.requisitionRef, 40),
    invoiceNo: kind === "direct" ? text(b.invoiceNo, 60) : "",
    adjustReason,
    notes: text(b.notes, 300),
    lines: [],
  };
  if (kind === "adjustment" && !adjustReason) return "Pick a reason for the adjustment.";
  if (!write.route && !write.salesman) {
    return kind === "direct"
      ? "Enter the customer's name."
      : kind === "warehouse"
        ? "Pick the warehouse."
        : kind === "adjustment"
          ? "Say what the adjustment is for."
          : "Pick the route or salesman.";
  }
  if (!Array.isArray(b.lines) || b.lines.length === 0) return "Add at least one item.";
  if (b.lines.length > 100) return "Too many items in one transfer.";

  for (const raw of b.lines) {
    const l = (raw ?? {}) as Record<string, unknown>;
    const name = text(l.name, 200);
    const code = text(l.code, 40);
    if (!code) return `"${name || "An item"}" has no item code.`;
    const numbers = {
      stockTransfer: amount(l.stockTransfer),
      physicalStock: amount(l.physicalStock),
      systemStock: amount(l.systemStock),
      piecesReimbursed: amount(l.piecesReimbursed),
    };
    if (Object.values(numbers).some((n) => n === null)) return `"${name}": quantities must be zero or more.`;
    const t = l.target as Record<string, unknown> | null | undefined;
    const target =
      t && typeof t === "object"
        ? { section: text(t.section), code: text(t.code, 40), item: text(t.item) }
        : null;
    if (target && (!target.section || !target.item)) return `"${name}": pick the store row for Despatch.`;
    write.lines.push({ code, name, unit: text(l.unit, 20), ...(numbers as Record<keyof typeof numbers, number>), target });
  }
  return write;
}

export default async (req: Request) => {
  const configured = scriptConfigured();

  if (req.method === "GET") {
    const empty: TransferData = { configured, items: [], salesmen: [], units: [], requisitions: [], transfers: [] };
    if (!configured) return json(empty);
    try {
      const reply = await callScript({ method: "GET", params: { view: "transfers" } });
      const { ok: _ok, ...data } = reply;
      return json({ ...empty, ...data, configured: true });
    } catch (err) {
      return json({ ...empty, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (req.method !== "POST") return json({ message: `${req.method} not supported.` }, 405);

  const denied = authorize(req);
  if (denied) return denied;
  if (!configured) {
    return json({ message: "Entry isn't connected to the sheet yet (ENTRY_SCRIPT_URL is not set)." }, 503);
  }

  let parsed: TransferWrite | string;
  try {
    parsed = parseWrite(await req.json());
  } catch {
    parsed = "Expected a JSON body.";
  }
  if (typeof parsed === "string") return json({ message: parsed }, 400);

  try {
    const reply = await callScript({ method: "POST", body: { action: "transfer", ...parsed } });
    return json({ docNo: reply.docNo, day: reply.day, despatched: reply.despatched ?? [] });
  } catch (err) {
    return json({ message: err instanceof Error ? err.message : String(err) }, 502);
  }
};

export const config: Config = { path: "/api/transfers" };
