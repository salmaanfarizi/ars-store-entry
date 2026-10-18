import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Check, ChevronDown, ChevronUp, FileDown, Plus, RefreshCw, Trash2, Truck, X } from "lucide-react";
import { fmt, getPasscode, PasscodeError, savePasscode, shortDate } from "./api";
import {
  isoToTab,
  loadTransfers,
  saveTransfer,
  sectionShort,
  storeCandidates,
  suggestTarget,
  tabToIso,
  targetKey,
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
  requisitionRef: string;
  date: string;
  route: string;
  salesman: string;
  notes: string;
  lines: Line[];
};

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

  const lineFor = (code: string, name: string, unit: string, route: string, requested: number | null): Line => ({
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
    target: suggestTarget(dayRows, code, name, route),
  });

  const start = (req: Requisition | null) => {
    setDone(null);
    setDraft({
      requisitionRef: req?.docNo ?? "",
      date: tabToIso(dayTab) || new Date().toISOString().slice(0, 10),
      route: req?.route ?? "",
      salesman: req?.salesman ?? "",
      notes: "",
      lines: req ? req.lines.map((l) => lineFor(l.code, l.name, l.unit, req.route, l.quantity)) : [],
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

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Open requisitions ({data.requisitions.length})
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
        {data.requisitions.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">Every requisition has been transferred.</p>
        ) : (
          data.requisitions.map((r) => (
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
      <button
        onClick={() => start(null)}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-medium"
      >
        <Plus className="size-4" />
        Transfer without a requisition
      </button>

      <h2 className="mb-2 mt-6 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Recent transfers
      </h2>
      <div className="card-surface divide-y divide-border">
        {data.transfers.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">No transfers yet.</p>
        ) : (
          data.transfers.map((t) => <TransferRow key={t.docNo} transfer={t} />)
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
          <p className="text-sm font-semibold">
            {t.docNo} <span className="font-normal text-muted-foreground">· {shortDate(t.date)}</span>
          </p>
          <p className="truncate text-[0.72rem] text-muted-foreground">
            {t.salesman || "—"} · {t.route || "—"}
            {t.requisitionRef ? ` · from ${t.requisitionRef}` : ""} · {fmt(total)} total
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
  lineFor: (code: string, name: string, unit: string, route: string, requested: number | null) => Line;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSaved: (result: TransferResult, transfer: Transfer) => void;
}) {
  const [addKey, setAddKey] = useState("");
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(() => !getPasscode());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Draft>) => {
    setError(null);
    onChange({ ...draft, ...patch });
  };
  const setLine = (id: number, patch: Partial<Line>) =>
    set({ lines: draft.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });

  const dayName = isoToTab(draft.date);
  const sameDay = dayName === dayTab;
  const toDespatch = draft.lines.filter((l) => l.target && n(l.stockTransfer) > 0);

  const problem = (() => {
    if (!draft.route && !draft.salesman) return "Pick the route.";
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
      const result = await saveTransfer({
        date: draft.date,
        route: draft.route,
        salesman: draft.salesman,
        requisitionRef: draft.requisitionRef,
        notes: draft.notes,
        lines,
      });
      onSaved(result, {
        docNo: result.docNo,
        date: draft.date,
        salesman: draft.salesman,
        route: draft.route,
        requisitionRef: draft.requisitionRef,
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

      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block">
          <span className={labelClass}>Date</span>
          <input type="date" value={draft.date} onChange={(e) => set({ date: e.target.value })} className={`${inputClass} mt-1`} />
        </label>
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
      </div>
      <p className="mt-1 text-[0.68rem] text-muted-foreground">
        Salesman: <span className="font-medium text-foreground">{draft.salesman || "—"}</span>
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
                <Num label="Transfer" value={l.stockTransfer} onChange={(v) => setLine(l.id, { stockTransfer: v })} strong />
                <Num label="Physical" value={l.physicalStock} onChange={(v) => setLine(l.id, { physicalStock: v })} />
                <Num label="System" value={l.systemStock} onChange={(v) => setLine(l.id, { systemStock: v })} />
              </div>
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
                        {sectionShort(c.section)} · {c.item}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
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

      <div className="mt-2 flex gap-2">
        <select value={addKey} onChange={(e) => setAddKey(e.target.value)} className={`${inputClass} min-w-0 flex-1`}>
          <option value="">Add an item…</option>
          {data.items.map((i, idx) => (
            <option key={`${i.code}-${idx}`} value={String(idx)}>
              {i.name} (#{i.code})
            </option>
          ))}
        </select>
        <button
          disabled={!addKey}
          onClick={() => {
            const i = data.items[Number(addKey)];
            if (!i) return;
            set({ lines: [...draft.lines, lineFor(i.code, i.name, i.unit, draft.route, null)] });
            setAddKey("");
          }}
          className="shrink-0 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Add
        </button>
      </div>

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
      </p>
      <p className="mt-1 text-[0.75rem] text-muted-foreground">
        {transfer.salesman} · {transfer.route}
        {transfer.requisitionRef ? ` · from ${transfer.requisitionRef}` : ""}
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
