import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardList, RefreshCw, Search, X } from "lucide-react";
import {
  fmt,
  getPasscode,
  loadDaily,
  parseQty,
  PasscodeError,
  rowKey,
  saveDaily,
  savePasscode,
  shortDate,
} from "./api";
import type { DailyData, DailyRow, DailyWrite, OrderEdit } from "./types";

type OrderDraft = { qty: string; deliverBy: string; status: string } | "clear";
type Draft = { production?: string; despatch?: string; order?: OrderDraft };
type Entry = DailyWrite["entries"][number];
type Filter = "all" | "edited" | "orders";

const shown = (n: number | null) => (n == null ? "" : String(n));

const inputClass =
  "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
const labelClass = "text-[0.66rem] font-medium uppercase tracking-wide text-muted-foreground";

/** What this draft would change on the row's order: an edit, nothing, or a reason it can't be saved. */
function orderChange(row: DailyRow, draft: OrderDraft | undefined): OrderEdit | undefined | string {
  if (draft === undefined) return undefined;
  if (draft === "clear") return row.order ? { action: "clear" } : undefined;
  const existing = row.order;
  const blank = !draft.qty.trim() && !draft.deliverBy;
  if (!existing && blank) return undefined;
  const qty = Number(draft.qty.trim());
  if (
    existing &&
    existing.qty === qty &&
    existing.deliverBy === draft.deliverBy &&
    existing.status === draft.status
  ) {
    return undefined;
  }
  if (!draft.qty.trim() || !Number.isFinite(qty) || qty <= 0) return "enter the order quantity";
  if (!draft.deliverBy) return "pick the deliver-by date";
  if (!draft.status) return "pick an order status";
  return { action: "set", qty, deliverBy: draft.deliverBy, status: draft.status };
}

/** The draft as an entry to send, and the first problem in it. */
function entryFor(row: DailyRow, draft: Draft | undefined): { entry: Entry | null; problem: string | null } {
  if (!draft) return { entry: null, problem: null };
  const entry: Entry = { section: row.section, code: row.code, item: row.item };
  let problem: string | null = null;
  for (const field of ["production", "despatch"] as const) {
    const input = draft[field];
    if (input === undefined || input.trim() === shown(row[field])) continue;
    const parsed = parseQty(input);
    if (parsed === "invalid") {
      problem ??= `"${row.item}": ${field} must be a number, zero or more.`;
      continue;
    }
    entry[field] = parsed;
  }
  const order = orderChange(row, draft.order);
  if (typeof order === "string") problem ??= `"${row.item}": ${order}.`;
  else if (order) entry.order = order;
  const changed = entry.production !== undefined || entry.despatch !== undefined || entry.order !== undefined;
  return { entry: changed ? entry : null, problem };
}

export function App() {
  const [tab, setTab] = useState("");
  const [data, setData] = useState<DailyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [absentees, setAbsentees] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(() => !getPasscode());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  // Only the latest read may land, so a slow answer for another day can't replace this one.
  const request = useRef(0);
  const load = useCallback(async (which: string) => {
    const id = ++request.current;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await loadDaily(which);
      if (id !== request.current) return;
      setData(next);
    } catch (err) {
      if (id !== request.current) return;
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 5000);
    return () => clearTimeout(t);
  }, [saved]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const activeTab = data?.tab || tab;

  const changes = useMemo(() => {
    const entries: Entry[] = [];
    const editedKeys = new Set<string>();
    let problem: string | null = null;
    for (const r of rows) {
      const { entry, problem: p } = entryFor(r, drafts[rowKey(r)]);
      problem ??= p;
      if (entry) {
        entries.push(entry);
        editedKeys.add(rowKey(r));
      }
    }
    const absenteesChanged = absentees !== null && absentees.trim() !== (data?.absentees ?? "");
    return { entries, editedKeys, problem, absenteesChanged };
  }, [rows, drafts, absentees, data?.absentees]);

  const dirty = changes.entries.length > 0 || changes.absenteesChanged;

  // Closing the tab with unsaved numbers loses a shift's entry; ask first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patch = (r: DailyRow, change: Partial<Draft>) => {
    setSaved(null);
    setSaveError(null);
    setDrafts((d) => ({ ...d, [rowKey(r)]: { ...d[rowKey(r)], ...change } }));
  };

  const discard = () => {
    setDrafts({});
    setAbsentees(null);
    setSaveError(null);
  };

  const submit = async () => {
    if (changes.problem || saving) return;
    if (needsPasscode) {
      if (!passcode.trim()) return;
      savePasscode(passcode.trim());
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await saveDaily({
        tab: activeTab,
        ...(changes.absenteesChanged ? { absentees: (absentees ?? "").trim() } : {}),
        entries: changes.entries,
      });
      setDrafts({});
      setAbsentees(null);
      setPasscode("");
      setNeedsPasscode(false);
      setSaved(`Saved to the ${activeTab} tab · ${res.cells} ${res.cells === 1 ? "change" : "changes"}`);
      await load(activeTab);
    } catch (err) {
      if (err instanceof PasscodeError) setNeedsPasscode(true);
      setSaveError(
        err instanceof PasscodeError && err.message === "Passcode required"
          ? "Enter the team passcode."
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setSaving(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (filter === "edited" && !changes.editedKeys.has(rowKey(r))) return false;
    if (filter === "orders" && !r.order && !drafts[rowKey(r)]?.order) return false;
    return (
      !needle ||
      r.item.toLowerCase().includes(needle) ||
      r.code.toLowerCase().includes(needle) ||
      r.section.toLowerCase().includes(needle)
    );
  });
  const sections = [...new Set(visible.map((r) => r.section))];
  const withOrders = rows.filter((r) => r.order).length;

  const saveLabel = [
    changes.entries.length
      ? `${changes.entries.length} ${changes.entries.length === 1 ? "item" : "items"}`
      : "",
    changes.absenteesChanged ? "absentees" : "",
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div className="min-h-screen bg-background pb-40">
      <header className="safe-top sticky top-0 z-10 border-b border-border bg-background/90 px-4 pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[0.68rem] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              ARS International Co SPC
            </p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight">Store Entry</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {activeTab ? `Packing and dispatch · ${activeTab}` : "Packing and dispatch"}
            </p>
          </div>
          <button
            onClick={() => void load(activeTab)}
            disabled={loading || dirty}
            aria-label="Read the sheet again"
            title={dirty ? "Save or discard first" : "Read the sheet again"}
            className="mt-1 shrink-0 rounded-full border border-border bg-card p-2.5 disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 pt-4">
        {!data && loading ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Reading the sheet…</p>
        ) : loadError && !data ? (
          <Notice tone="error" message={loadError} action={() => void load(tab)} />
        ) : data && !data.configured ? (
          <Notice
            tone="error"
            message="Not connected to the sheet yet. Set ENTRY_SCRIPT_URL and ENTRY_SCRIPT_SECRET on Netlify (see the README)."
          />
        ) : data?.error ? (
          <Notice tone="error" message={data.error} action={() => void load(activeTab)} />
        ) : data ? (
          <>
            {loadError ? <Notice tone="error" message={loadError} action={() => void load(activeTab)} /> : null}

            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className={labelClass}>Day</span>
                <select
                  value={activeTab}
                  disabled={dirty || loading}
                  onChange={(e) => setTab(e.target.value)}
                  className={`${inputClass} mt-1 disabled:opacity-60`}
                >
                  {(data.tabs.includes(activeTab) ? data.tabs : [activeTab, ...data.tabs]).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelClass}>Absentees (e.g. 2S 1O)</span>
                <input
                  value={absentees ?? data.absentees}
                  onChange={(e) => {
                    setSaved(null);
                    setAbsentees(e.target.value);
                  }}
                  placeholder="None"
                  className={`${inputClass} mt-1 ${changes.absenteesChanged ? "border-primary" : ""}`}
                />
              </label>
            </div>
            {dirty ? (
              <p className="mt-1 text-[0.68rem] text-muted-foreground">Save or discard to switch day.</p>
            ) : null}

            <div className="relative mt-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search item, code or category"
                className={`${inputClass} pl-9`}
              />
              {q ? (
                <button
                  onClick={() => setQ("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>

            <div className="mt-2 flex gap-2 overflow-x-auto">
              {(
                [
                  ["all", `All (${rows.length})`],
                  ["edited", `Edited (${changes.editedKeys.size})`],
                  ["orders", `With orders (${withOrders})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
                    filter === value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className="card-surface mt-3 p-6 text-center text-sm text-muted-foreground">
                {filter === "edited" ? "Nothing edited yet." : "No items match."}
              </p>
            ) : null}

            {sections.map((section) => (
              <section key={section}>
                <h2 className="mb-2 mt-5 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {section}
                </h2>
                <div className="card-surface divide-y divide-border">
                  {visible
                    .filter((r) => r.section === section)
                    .map((r) => (
                      <ItemCard
                        key={rowKey(r)}
                        row={r}
                        draft={drafts[rowKey(r)]}
                        edited={changes.editedKeys.has(rowKey(r))}
                        statuses={data.statuses}
                        onChange={(change) => patch(r, change)}
                      />
                    ))}
                </div>
              </section>
            ))}
          </>
        ) : null}
      </main>

      {dirty || saved || saveError || changes.problem ? (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 pt-3 backdrop-blur">
          <div className="mx-auto max-w-2xl">
            {changes.problem || saveError ? (
              <p className="mb-2 text-[0.75rem] text-destructive">{changes.problem ?? saveError}</p>
            ) : null}
            {saved && !dirty ? (
              <p className="mb-1 inline-flex items-center gap-1.5 text-[0.8rem] font-medium text-success">
                <Check className="size-4" />
                {saved}
              </p>
            ) : null}
            {dirty ? (
              <>
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
                  <button
                    onClick={discard}
                    disabled={saving}
                    className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium disabled:opacity-60"
                  >
                    Discard
                  </button>
                  <button
                    onClick={() => void submit()}
                    disabled={saving || Boolean(changes.problem) || (needsPasscode && !passcode.trim())}
                    className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
                  >
                    {saving ? "Saving…" : `Save ${saveLabel} to ${activeTab}`}
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Notice({ tone, message, action }: { tone: "error"; message: string; action?: () => void }) {
  return (
    <div
      className={`card-surface mb-3 flex items-center justify-between gap-3 p-3 text-sm ${
        tone === "error" ? "text-destructive" : ""
      }`}
    >
      <span>{message}</span>
      {action ? (
        <button onClick={action} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground">
          Try again
        </button>
      ) : null}
    </div>
  );
}

function ItemCard({
  row,
  draft,
  edited,
  statuses,
  onChange,
}: {
  row: DailyRow;
  draft: Draft | undefined;
  edited: boolean;
  statuses: string[];
  onChange: (change: Partial<Draft>) => void;
}) {
  const [orderOpen, setOrderOpen] = useState(false);
  const prodInput = draft?.production ?? shown(row.production);
  const despInput = draft?.despatch ?? shown(row.despatch);
  const prod = parseQty(prodInput);
  const desp = parseQty(despInput);
  // The sheet computes Closing = Opening + Production − Despatch; mirror it while typing.
  const closing =
    prod === "invalid" || desp === "invalid" ? null : (row.opening ?? 0) + (prod ?? 0) - (desp ?? 0);

  const order = draft?.order;
  const clearing = order === "clear";
  const form = order && order !== "clear" ? order : null;
  // Keep a status the sheet already holds selectable, even if the dropdown has changed.
  const choices =
    row.order?.status && !statuses.includes(row.order.status) ? [row.order.status, ...statuses] : statuses;

  const openOrder = () => {
    setOrderOpen(true);
    if (form) return;
    onChange({
      order: {
        qty: row.order?.qty != null ? String(row.order.qty) : "",
        deliverBy: row.order?.deliverBy ?? "",
        status: row.order?.status || choices[0] || "",
      },
    });
  };

  return (
    <div className={`p-3 ${edited ? "bg-primary/5" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-snug">{row.item}</p>
          <p className="text-[0.62rem] text-muted-foreground">
            #{row.code} · opening <span className="num">{fmt(row.opening)}</span>
          </p>
        </div>
        <button
          onClick={() => (orderOpen ? setOrderOpen(false) : openOrder())}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[0.66rem] font-medium ${
            row.order || form ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground"
          }`}
        >
          <ClipboardList className="size-3.5" />
          {clearing
            ? "Removing order"
            : row.order
              ? `Order ${row.order.text || "—"}${row.order.status ? ` · ${row.order.status}` : ""}`
              : "Order"}
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 items-end gap-2">
        <QtyBox label="Produced" value={prodInput} bad={prod === "invalid"} onChange={(v) => onChange({ production: v })} />
        <QtyBox label="Despatched" value={despInput} bad={desp === "invalid"} onChange={(v) => onChange({ despatch: v })} />
        <div className="text-right">
          <span className={labelClass}>Closing</span>
          <p className={`num mt-1 py-2.5 text-sm font-semibold ${closing != null && closing < 0 ? "text-destructive" : ""}`}>
            {closing == null ? "—" : fmt(closing)}
          </p>
        </div>
      </div>

      {orderOpen ? (
        <div className="mt-3 rounded-xl border border-border bg-surface p-3">
          {clearing ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-[0.75rem] text-muted-foreground">The order will be removed when you save.</p>
              <button
                onClick={() => onChange({ order: undefined })}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
              >
                Keep it
              </button>
            </div>
          ) : form ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className={labelClass}>Order qty</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={form.qty}
                    onChange={(e) => onChange({ order: { ...form, qty: e.target.value } })}
                    className={`${inputClass} num mt-1`}
                  />
                </label>
                <label className="block">
                  <span className={labelClass}>Deliver by</span>
                  <input
                    type="date"
                    value={form.deliverBy}
                    onChange={(e) => onChange({ order: { ...form, deliverBy: e.target.value } })}
                    className={`${inputClass} mt-1`}
                  />
                </label>
              </div>
              <label className="mt-2 block">
                <span className={labelClass}>Status</span>
                <select
                  value={form.status}
                  onChange={(e) => onChange({ order: { ...form, status: e.target.value } })}
                  className={`${inputClass} mt-1`}
                >
                  {choices.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[0.66rem] text-muted-foreground">
                  {row.order?.deliverBy ? `Now: deliver by ${shortDate(row.order.deliverBy)}` : "Also copied to later day tabs that exist."}
                </p>
                {row.order ? (
                  <button
                    onClick={() => onChange({ order: "clear" })}
                    className="shrink-0 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive"
                  >
                    Remove order
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function QtyBox({
  label,
  value,
  bad,
  onChange,
}: {
  label: string;
  value: string;
  bad: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} num mt-1 px-2 text-right ${bad ? "border-destructive" : ""}`}
      />
    </label>
  );
}
