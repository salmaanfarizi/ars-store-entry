import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Check, ChevronDown, ChevronUp, FileDown, Plus, RefreshCw, Trash2, Truck, X } from "lucide-react";
import { fmt, getPasscode, PasscodeError, savePasscode, shortDate } from "./api";
import { ItemPicker } from "./ItemPicker";
import {
  isoToTab,
  KIND_LABEL,
  loadTransfers,
  regionOf,
  saveTransfer,
  sectionShort,
  storeCandidates,
  storeRow,
  suggestTarget,
  tabToIso,
  targetKey,
  WAREHOUSES,
  warehouseRegion,
  type Region,
  type TransferKind,
  type Warehouse,
} from "./transfers";
import type { DailyRow, Requisition, StoreTarget, Transfer, TransferData, TransferResult } from "./types";

const inputClass =
  "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
const smallInput =
  "w-full rounded-lg border border-border bg-background px-2 py-2 text-right text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
const labelClass = "text-[0.66rem] font-medium uppercase tracking-wide text-muted-foreground";

type Line = {
  id: number;
  code: string;
  name: string;
  unit: string;
  /** The item's own unit in the requisition sheet; Despatch on the store sheet is counted in it. */
  baseUnit: string;
  requested: number | null;
  stockTransfer: string;
  physicalStock: string;
  systemStock: string;
  piecesReimbursed: string;
  target: StoreTarget | null;
};

type Draft = {
  kind: TransferKind;
  requisitionRef: string;
  date: string;
  /** kind "route": the salesman's route and name. */
  route: string;
  salesman: string;
  /** kind "direct": who bought it. */
  customer: string;
  /** kind "direct": the customer's invoice number, if there is one. */
  invoiceNo: string;
  /** kind "warehouse": where it went. */
  warehouse: Warehouse;
  notes: string;
  lines: Line[];
};

/** The store section a draft draws on: Riyadh for Riyadh routes and the Riyadh warehouse. */
const regionOfDraft = (d: Pick<Draft, "kind" | "route" | "warehouse">): Region =>
  d.kind === "warehouse" ? warehouseRegion(d.warehouse) : d.kind === "direct" ? "regular" : regionOf(d.route);

/** What goes in the sheet's route and salesman columns for each kind of transfer. */
function destination(d: Draft): { route: string; salesman: string } {
  if (d.kind === "direct") return { route: "Direct sale", salesman: d.customer.trim() };
  if (d.kind === "warehouse") return { route: `${d.warehouse} warehouse`, salesman: `${d.warehouse} warehouse` };
  return { route: d.route, salesman: d.salesman };
}

const KIND_CLASS: Record<TransferKind, string> = {
  route: "bg-primary/10 text-primary",
  direct: "bg-accent/25 text-accent-foreground",
  warehouse: "bg-success/12 text-success",
};

export function KindBadge({ kind }: { kind: TransferKind }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide ${KIND_CLASS[kind]}`}>
      {kind === "route" ? "Route" : kind === "direct" ? "Direct sale" : "Warehouse"}
    </span>
  );
}

/** Open requisitions older than this many days are hidden: they were dealt with some other way. */
const OPEN_REQUISITION_DAYS = 2;

/** Whole days since a yyyy-mm-dd date; negative for a date ahead (a requisition for tomorrow). */
function daysAgo(iso: string): number | null {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - new Date(y, m - 1, d).getTime()) / 86_400_000);
}

let nextId = 1;
const n = (s: string) => {
  const v = Number(s.trim() || 0);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * Stock transfers to salesmen, merged in from the old stock-transfer app. Pick an open
 * requisition (or start from nothing), enter what was handed over, and on save the transfer
 * is written to the requisition sheet's Transfers tab and its quantities are added to that
 * day's Despatch on the store sheet.
 */
export function Transfers({
  dayRows,
  dayTab,
  onDespatched,
}: {
  dayRows: DailyRow[];
  dayTab: string;
  onDespatched: () => void;
}) {
  const [data, setData] = useState<TransferData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [done, setDone] = useState<{ result: TransferResult; transfer: Transfer } | null>(null);
  const [showOlder, setShowOlder] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setData(await loadTransfers());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const itemUnit = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of data?.items ?? []) if (!m.has(i.code)) m.set(i.code, i.unit);
    return m;
  }, [data]);

  const lineFor = (code: string, name: string, unit: string, region: Region, requested: number | null): Line => ({
    id: nextId++,
    code,
    name,
    unit: unit || itemUnit.get(code) || "",
    baseUnit: itemUnit.get(code) || unit,
    requested,
    stockTransfer: requested != null ? String(requested) : "",
    physicalStock: "",
    systemStock: "",
    piecesReimbursed: "",
    target: suggestTarget(dayRows, code, name, region),
  });

  const start = (req: Requisition | null) => {
    setDone(null);
    setDraft({
      kind: "route",
      requisitionRef: req?.docNo ?? "",
      date: tabToIso(dayTab) || new Date().toISOString().slice(0, 10),
      route: req?.route ?? "",
      salesman: req?.salesman ?? "",
      customer: "",
      invoiceNo: "",
      warehouse: "Riyadh",
      notes: "",
      lines: req ? req.lines.map((l) => lineFor(l.code, l.name, l.unit, regionOf(req.route), l.quantity)) : [],
    });
  };

  if (loading && !data) return <p className="py-16 text-center text-sm text-muted-foreground">Reading requisitions…</p>;
  if (loadError && !data) return <ErrorCard message={loadError} retry={() => void load()} />;
  if (!data) return null;
  if (!data.configured) return <ErrorCard message="Not connected to the sheet yet (ENTRY_SCRIPT_URL)." />;
  if (data.error) return <ErrorCard message={data.error} retry={() => void load()} />;

  if (done) {
    return (
      <SavedCard
        result={done.result}
        transfer={done.transfer}
        onAnother={() => {
          setDone(null);
          void load();
        }}
      />
    );
  }

  if (draft) {
    return (
      <TransferForm
        data={data}
        draft={draft}
        dayRows={dayRows}
        dayTab={dayTab}
        lineFor={lineFor}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSaved={(result, transfer) => {
          setDraft(null);
          setDone({ result, transfer });
          if (result.despatched.length) onDespatched();
        }}
      />
    );
  }

  // Recent ones only: today, the last two days, and any dated ahead. A requisition with an
  // unreadable date stays listed rather than vanish.
  const recent = data.requisitions.filter((r) => {
    const age = daysAgo(r.date);
    return age === null || age <= OPEN_REQUISITION_DAYS;
  });
  const older = data.requisitions.length - recent.length;
  const listed = showOlder ? data.requisitions : recent;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Open requisitions ({listed.length})
        </h2>
        <button
          onClick={() => void load()}
          disabled={loading}
          aria-label="Read requisitions again"
          className="rounded-full border border-border p-1.5 disabled:opacity-50"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="card-surface mt-2 divide-y divide-border">
        {listed.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">
            {older ? "No requisitions from the last two days." : "Every requisition has been transferred."}
          </p>
        ) : (
          listed.map((r) => (
            <button key={r.docNo} onClick={() => start(r)} className="flex w-full items-center justify-between gap-3 p-3 text-left">
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {r.docNo} <span className="font-normal text-muted-foreground">· {shortDate(r.date)}</span>
                </p>
                <p className="truncate text-[0.72rem] text-muted-foreground">
                  {r.salesman || "—"} · {r.route || "—"} · {r.lines.length} {r.lines.length === 1 ? "item" : "items"}
                </p>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-[0.72rem] font-medium text-primary-foreground">
                <ArrowRightLeft className="size-3.5" />
                Transfer
              </span>
            </button>
          ))
        )}
      </div>
      {older ? (
        <button onClick={() => setShowOlder((s) => !s)} className="mt-1.5 w-full text-center text-[0.72rem] font-medium text-muted-foreground underline-offset-2 hover:underline">
          {showOlder ? "Hide older requisitions" : `Show ${older} older ${older === 1 ? "requisition" : "requisitions"}`}
        </button>
      ) : null}
      <button
        onClick={() => start(null)}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-medium"
      >
        <Plus className="size-4" />
        New transfer · direct sale · warehouse
      </button>

      <DayPdf transfers={data.transfers} initial={tabToIso(dayTab) || todayIso()} />

      <h2 className="mb-2 mt-6 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Recent transfers
      </h2>
      <div className="card-surface divide-y divide-border">
        {data.transfers.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No transfers yet.</p>
        ) : (
          data.transfers.slice(0, RECENT_LISTED).map((t) => <TransferRow key={t.docNo} transfer={t} />)
        )}
      </div>
    </>
  );
}

function ErrorCard({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="card-surface flex items-center justify-between gap-3 p-3 text-sm text-destructive">
      <span>{message}</span>
      {retry ? (
        <button onClick={retry} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground">
          Try again
        </button>
      ) : null}
    </div>
  );
}

function TransferRow({ transfer: t }: { transfer: Transfer }) {
  const [open, setOpen] = useState(false);
  const total = t.lines.reduce((s, l) => s + l.stockTransfer, 0);
  return (
    <div className="p-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            {t.docNo} <span className="font-normal text-muted-foreground">· {shortDate(t.date)}</span>
            <KindBadge kind={t.kind} />
          </p>
          <p className="truncate text-[0.72rem] text-muted-foreground">
            {t.kind === "route" ? `${t.salesman || "—"} · ${t.route || "—"}` : t.salesman || t.route || "—"}
            {t.requisitionRef ? ` · from ${t.requisitionRef}` : ""}
            {t.invoiceNo ? ` · Inv ${t.invoiceNo}` : ""} · {fmt(total)} total
          </p>
        </div>
        {open ? <ChevronUp className="size-4 shrink-0" /> : <ChevronDown className="size-4 shrink-0" />}
      </button>
      {open ? (
        <div className="mt-2">
          <table className="w-full text-left text-[0.72rem]">
            <thead className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Item</th>
                <th className="py-1 text-right font-medium">Qty</th>
                <th className="py-1 text-right font-medium">Var.</th>
              </tr>
            </thead>
            <tbody>
              {t.lines.map((l, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1 pr-2">
                    {l.name} <span className="text-muted-foreground">({l.unit})</span>
                  </td>
                  <td className="num py-1 text-right">{fmt(l.stockTransfer)}</td>
                  <td className={`num py-1 text-right ${l.variance < 0 ? "text-destructive" : ""}`}>{fmt(l.variance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <PdfButton transfer={t} />
        </div>
      ) : null}
    </div>
  );
}

/** The script sends a month of transfers for the day PDF; the list shows the newest of them. */
const RECENT_LISTED = 40;

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Pick a day and download every transfer made on it as one PDF. */
function DayPdf({ transfers, initial }: { transfers: Transfer[]; initial: string }) {
  const [date, setDate] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDate(initial), [initial]);
  const count = transfers.filter((t) => t.date === date).length;
  return (
    <div className="card-surface mt-6 p-3">
      <p className="inline-flex items-center gap-1.5 text-sm font-semibold">
        <FileDown className="size-4" />
        Day's transfers PDF
      </p>
      <div className="mt-2 flex items-center gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${inputClass} flex-1`} />
        <button
          disabled={busy || !date || count === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const { exportTransfersDayPdf } = await import("./pdf");
              await exportTransfersDayPdf(date, transfers);
            } catch (err) {
              setError(`Couldn't make the PDF: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Making…" : "PDF"}
        </button>
      </div>
      <p className="mt-1 text-[0.7rem] text-muted-foreground">
        {date ? `${count} ${count === 1 ? "transfer" : "transfers"} on ${shortDate(date)}.` : "Pick a day."} Covers the last 31 days.
      </p>
      {error ? <p className="mt-1 text-[0.72rem] text-destructive">{error}</p> : null}
    </div>
  );
}

function PdfButton({ transfer }: { transfer: Transfer }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { exportTransferPdf } = await import("./pdf");
          await exportTransferPdf(transfer);
        } finally {
          setBusy(false);
        }
      }}
      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
    >
      <FileDown className="size-3.5" />
      {busy ? "Making…" : "PDF"}
    </button>
  );
}

function TransferForm({
  data,
  draft,
  dayRows,
  dayTab,
  lineFor,
  onChange,
  onCancel,
  onSaved,
}: {
  data: TransferData;
  draft: Draft;
  dayRows: DailyRow[];
  dayTab: string;
  lineFor: (code: string, name: string, unit: string, region: Region, requested: number | null) => Line;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSaved: (result: TransferResult, transfer: Transfer) => void;
}) {
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(() => !getPasscode());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const region = regionOfDraft(draft);
  const set = (patch: Partial<Draft>) => {
    setError(null);
    const next = { ...draft, ...patch };
    // A different destination can mean a different store section (Riyadh vs regular):
    // suggest each line's Despatch row again.
    const nextRegion = regionOfDraft(next);
    if (nextRegion !== region && !patch.lines) {
      next.lines = next.lines.map((l) => ({ ...l, target: suggestTarget(dayRows, l.code, l.name, nextRegion) }));
    }
    onChange(next);
  };
  const setLine = (id: number, patch: Partial<Line>) =>
    set({ lines: draft.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });

  const dayName = isoToTab(draft.date);
  const sameDay = dayName === dayTab;
  const toDespatch = draft.lines.filter((l) => l.target && n(l.stockTransfer) > 0);

  const problem = (() => {
    if (draft.kind === "route" && !draft.route && !draft.salesman) return "Pick the route.";
    if (draft.kind === "direct" && !draft.customer.trim()) return "Enter the customer's name.";
    if (!draft.date) return "Pick the transfer date.";
    if (!draft.lines.length) return "Add at least one item.";
    for (const l of draft.lines) {
      for (const [label, v] of [
        ["transfer quantity", l.stockTransfer],
        ["physical stock", l.physicalStock],
        ["system stock", l.systemStock],
        ["pieces reimbursed", l.piecesReimbursed],
      ] as const) {
        const x = n(v);
        if (Number.isNaN(x) || x < 0) return `"${l.name}": ${label} must be a number, zero or more.`;
      }
    }
    if (!draft.lines.some((l) => n(l.stockTransfer) > 0)) return "Enter at least one transfer quantity.";
    return null;
  })();

  const submit = async () => {
    if (problem || saving) return;
    if (needsPasscode) {
      if (!passcode.trim()) return setError("Enter the team passcode.");
      savePasscode(passcode.trim());
    }
    setSaving(true);
    setError(null);
    const lines = draft.lines.map((l) => ({
      code: l.code,
      name: l.name,
      unit: l.unit,
      stockTransfer: n(l.stockTransfer),
      physicalStock: n(l.physicalStock),
      systemStock: n(l.systemStock),
      piecesReimbursed: n(l.piecesReimbursed),
      target: n(l.stockTransfer) > 0 ? l.target : null,
    }));
    try {
      const to = destination(draft);
      const result = await saveTransfer({
        kind: draft.kind,
        date: draft.date,
        route: to.route,
        salesman: to.salesman,
        requisitionRef: draft.requisitionRef,
        invoiceNo: draft.kind === "direct" ? draft.invoiceNo.trim() : "",
        notes: draft.notes,
        lines,
      });
      onSaved(result, {
        kind: draft.kind,
        docNo: result.docNo,
        date: draft.date,
        salesman: to.salesman,
        route: to.route,
        requisitionRef: draft.requisitionRef,
        invoiceNo: draft.kind === "direct" ? draft.invoiceNo.trim() : "",
        notes: draft.notes,
        createdAt: "",
        lines: lines.map(({ target: _t, ...l }) => ({ ...l, variance: l.physicalStock - l.systemStock })),
      });
    } catch (err) {
      if (err instanceof PasscodeError) setNeedsPasscode(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const routes = data.salesmen;

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {draft.requisitionRef ? `Transfer for ${draft.requisitionRef}` : "New transfer"}
        </h2>
        <button onClick={onCancel} aria-label="Cancel" className="rounded-full border border-border p-1.5">
          <X className="size-4" />
        </button>
      </div>

      {draft.requisitionRef ? null : (
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-xl border border-border bg-card p-1">
          {(["route", "direct", "warehouse"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => set({ kind: k })}
              className={`rounded-lg px-1 py-2 text-[0.74rem] font-semibold leading-tight ${
                draft.kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className={labelClass}>Date</span>
          <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
        {draft.kind === "direct" ? (
          <label className="block">
            <span className={labelClass}>Customer</span>
            <input
              value={draft.customer}
              onChange={(e) => set({ customer: e.target.value })}
              placeholder="Customer or shop name"
              className={`${inputClass} mt-1`}
            />
          </label>
        ) : draft.kind === "warehouse" ? (
          <div className="block">
            <span className={labelClass}>Warehouse</span>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {WAREHOUSES.map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => set({ warehouse: w })}
                  className={`rounded-xl border px-2 py-2.5 text-sm font-medium ${
                    draft.warehouse === w ? "border-primary bg-primary/10 text-primary" : "border-border bg-background"
                  }`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        ) : (
        <label className="block">
          <span className={labelClass}>Route</span>
          <select
            value={draft.route}
            onChange={(e) => {
              const route = e.target.value;
              const s = routes.find((x) => x.route === route);
              set({ route, salesman: s?.name ?? draft.salesman });
            }}
            className={`${inputClass} mt-1`}
          >
            <option value="">Choose…</option>
            {(routes.some((s) => s.route === draft.route) || !draft.route ? routes : [{ route: draft.route, name: draft.salesman }, ...routes]).map(
              (s) => (
                <option key={`${s.route}-${s.name}`} value={s.route}>
                  {s.route} — {s.name}
                </option>
              ),
            )}
          </select>
        </label>
        )}
      </div>
      {draft.kind === "direct" ? (
        <label className="mt-2 block">
          <span className={labelClass}>Invoice no.</span>
          <input
            value={draft.invoiceNo}
            onChange={(e) => set({ invoiceNo: e.target.value })}
            placeholder="Optional"
            className={`${inputClass} mt-1`}
          />
        </label>
      ) : null}
      <p className="mt-1 text-[0.68rem] text-muted-foreground">
        {draft.kind === "route" ? (
          <>
            Salesman: <span className="font-medium text-foreground">{draft.salesman || "—"}</span>
          </>
        ) : (
          <>
            Stock from the <span className="font-medium text-foreground">{region === "riyadh" ? "Riyadh" : "regular"}</span> section
          </>
        )}
        {toDespatch.length ? (
          <>
            {" "}
            · Despatch goes to the <span className="font-medium text-foreground">{dayName}</span> tab
            {sameDay ? "" : " (not the day you're viewing)"}
          </>
        ) : null}
      </p>

      <div className="card-surface mt-3 divide-y divide-border">
        {draft.lines.map((l) => {
          const candidates = storeCandidates(dayRows, l.code);
          const phys = n(l.physicalStock);
          const sys = n(l.systemStock);
          const variance = Number.isNaN(phys) || Number.isNaN(sys) ? null : phys - sys;
          const unitDiffers = l.target && l.baseUnit && l.unit && l.unit !== l.baseUnit;
          return (
            <div key={l.id} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug">{l.name}</p>
                  <p className="text-[0.62rem] text-muted-foreground">
                    #{l.code}
                    {l.requested != null ? ` · requested ${fmt(l.requested)}` : ""}
                  </p>
                </div>
                <button
                  onClick={() => set({ lines: draft.lines.filter((x) => x.id !== l.id) })}
                  aria-label={`Remove ${l.name}`}
                  className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>

              <div className="mt-2 grid grid-cols-4 gap-2">
                <label className="block">
                  <span className={labelClass}>Unit</span>
                  <select value={l.unit} onChange={(e) => setLine(l.id, { unit: e.target.value })} className={`${smallInput} mt-1 text-left`}>
                    {[...new Set([l.unit, ...data.units].filter(Boolean))].map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
                <Num label={draft.kind === "route" ? "Transfer" : "Quantity"} value={l.stockTransfer} onChange={(v) => setLine(l.id, { stockTransfer: v })} strong />
                {draft.kind === "route" ? (
                  <>
                    <Num label="Physical" value={l.physicalStock} onChange={(v) => setLine(l.id, { physicalStock: v })} />
                    <Num label="System" value={l.systemStock} onChange={(v) => setLine(l.id, { systemStock: v })} />
                  </>
                ) : (
                <label className="col-span-2 block">
                  <span className={labelClass}>Add to Despatch</span>
                  <select
                    value={targetKey(l.target)}
                    onChange={(e) => {
                      const r = candidates.find((c) => targetKey(c) === e.target.value);
                      setLine(l.id, { target: r ? { section: r.section, code: r.code, item: r.item } : null });
                    }}
                    className={`${smallInput} mt-1 text-left`}
                  >
                    <option value="">Don't add</option>
                    {candidates.map((c) => (
                      <option key={targetKey(c)} value={targetKey(c)}>
                        {sectionShort(c.section)} · {fmt(c.closing)} in stock · {c.item}
                      </option>
                    ))}
                  </select>
                </label>
                )}
              </div>
              {draft.kind === "route" ? (
              <div className="mt-2 grid grid-cols-4 items-end gap-2">
                <Num label="Reimbursed" value={l.piecesReimbursed} onChange={(v) => setLine(l.id, { piecesReimbursed: v })} />
                <div className="text-right">
                  <span className={labelClass}>Variance</span>
                  <p
                    className={`num mt-1 py-2 text-sm font-semibold ${
                      variance != null && variance < 0 ? "text-destructive" : variance ? "text-success" : ""
                    }`}
                  >
                    {variance == null ? "—" : fmt(variance)}
                  </p>
                </div>
                <label className="col-span-2 block">
                  <span className={labelClass}>Add to Despatch</span>
                  <select
                    value={targetKey(l.target)}
                    onChange={(e) => {
                      const r = candidates.find((c) => targetKey(c) === e.target.value);
                      setLine(l.id, { target: r ? { section: r.section, code: r.code, item: r.item } : null });
                    }}
                    className={`${smallInput} mt-1 text-left`}
                  >
                    <option value="">Don't add</option>
                    {candidates.map((c) => (
                      <option key={targetKey(c)} value={targetKey(c)}>
                        {sectionShort(c.section)} · {fmt(c.closing)} in stock · {c.item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              ) : null}
              {!candidates.length ? (
                <p className="mt-1 text-[0.66rem] text-muted-foreground">Code #{l.code} isn't on the store sheet, so it can't go to Despatch.</p>
              ) : unitDiffers ? (
                <p className="mt-1 text-[0.66rem] text-warning-foreground">
                  The store counts this item in {l.baseUnit}s; {l.stockTransfer || 0} {l.unit} will be added as {l.stockTransfer || 0}.
                </p>
              ) : null}
            </div>
          );
        })}
        {draft.lines.length === 0 ? <p className="p-4 text-center text-sm text-muted-foreground">No items yet.</p> : null}
      </div>

      <ItemPicker
        items={data.items.map((i, idx) => ({
          key: String(idx),
          code: i.code,
          name: i.name,
          unit: i.unit,
          stock: storeRow(dayRows, suggestTarget(dayRows, i.code, i.name, region))?.closing ?? null,
          added: draft.lines.some((l) => l.code === i.code && l.name === i.name),
        }))}
        onPick={(key) => {
          const i = data.items[Number(key)];
          if (i) set({ lines: [...draft.lines, lineFor(i.code, i.name, i.unit, region, null)] });
        }}
      />

      <label className="mt-3 block">
        <span className={labelClass}>Notes</span>
        <input value={draft.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Optional" className={`${inputClass} mt-1`} />
      </label>

      <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 pt-3 backdrop-blur">
        <div className="mx-auto max-w-2xl">
          {problem || error ? <p className="mb-2 text-[0.75rem] text-destructive">{error ?? problem}</p> : null}
          {needsPasscode ? (
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Team passcode (asked once on this phone)"
              className={`${inputClass} mb-2`}
            />
          ) : null}
          <div className="flex gap-2">
            <button onClick={onCancel} disabled={saving} className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium disabled:opacity-60">
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={saving || Boolean(problem)}
              className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {saving
                ? "Saving…"
                : toDespatch.length
                  ? `Save transfer · add ${toDespatch.length} to Despatch`
                  : "Save transfer"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function Num({ label, value, onChange, strong }: { label: string; value: string; onChange: (v: string) => void; strong?: boolean }) {
  const bad = Number.isNaN(n(value)) || n(value) < 0;
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className={`${smallInput} num mt-1 ${strong ? "font-semibold" : ""} ${bad ? "border-destructive" : ""}`}
      />
    </label>
  );
}

function SavedCard({ result, transfer, onAnother }: { result: TransferResult; transfer: Transfer; onAnother: () => void }) {
  return (
    <div className="card-surface p-4">
      <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-success">
        <Check className="size-4" />
        Saved as {result.docNo}
        <KindBadge kind={transfer.kind} />
      </p>
      <p className="mt-1 text-[0.75rem] text-muted-foreground">
        {transfer.kind === "route" ? `${transfer.salesman} · ${transfer.route}` : transfer.salesman || transfer.route}
        {transfer.requisitionRef ? ` · from ${transfer.requisitionRef}` : ""}
        {transfer.invoiceNo ? ` · Inv ${transfer.invoiceNo}` : ""}
      </p>
      {result.despatched.length ? (
        <div className="mt-3 rounded-xl bg-surface p-3">
          <p className="inline-flex items-center gap-1.5 text-[0.72rem] font-semibold">
            <Truck className="size-3.5" />
            Added to Despatch on {result.day}
          </p>
          <ul className="mt-1 space-y-0.5 text-[0.72rem]">
            {result.despatched.map((d, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span className="truncate">{d.item}</span>
                <span className="num shrink-0">
                  +{fmt(d.added)} → {fmt(d.despatch)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-[0.72rem] text-muted-foreground">Nothing was added to Despatch.</p>
      )}
      <div className="mt-3 flex gap-2">
        <PdfButton transfer={transfer} />
        <button onClick={onAnother} className="mt-2 flex-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
          Done
        </button>
      </div>
    </div>
  );
}
