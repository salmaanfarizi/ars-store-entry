import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CalendarRange,
  ClipboardList,
  FileDown,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  TrendingDown,
  X,
} from "lucide-react";
import {
  fmt,
  createDay,
  getPasscode,
  loadDaily,
  loadMonth,
  parseQty,
  PasscodeError,
  rowKey,
  saveDaily,
  savePasscode,
  shortDate,
} from "./api";
import { DUE_SOON_DAYS, orderDue, pendingOrder, shortfall, stockSignal, type Due } from "./insights";
import { Transfers } from "./Transfers";
import { isoToTab, tabToIso } from "./transfers-api";
import type { DailyData, DailyRow, DailyWrite, NewItem, OrderEdit } from "./types";

type OrderForm = { qty: string; deliverBy: string; status: string };
type OrderDraft = OrderForm | "clear";
type Draft = { production?: string; despatch?: string; order?: OrderDraft };
type Entry = DailyWrite["entries"][number];
type Filter = "all" | "due" | "low" | "edited" | "orders";

const shown = (n: number | null) => (n == null ? "" : String(n));

const inputClass =
  "w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20";
const labelClass = "text-[0.66rem] font-medium uppercase tracking-wide text-muted-foreground";

const DUE_CLASS: Record<Due["kind"], string> = {
  late: "border-destructive/30 bg-destructive/10 text-destructive",
  today: "border-warning/50 bg-warning/20 text-warning-foreground",
  soon: "border-warning/50 bg-warning/20 text-warning-foreground",
};

/** What this draft would change on the row's order: an edit, nothing, or a reason it can't be saved. */
function orderChange(row: DailyRow, draft: OrderDraft | undefined): OrderEdit | undefined | string {
  if (draft === undefined) return undefined;
  if (draft === "clear") return row.order ? { action: "clear" } : undefined;
  const existing = row.order;
  const blank = !draft.qty.trim() && !draft.deliverBy;
  // A met order is done with: an untouched blank form over it is no change.
  if ((!existing || !pendingOrder(row)) && blank) return undefined;
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

const emptyOrder = (row: DailyRow | undefined, statuses: string[]): OrderForm => {
  // A met order isn't shown, so a new order starts blank rather than from it.
  const open = row ? pendingOrder(row) : null;
  return {
    qty: open?.qty != null ? String(open.qty) : "",
    deliverBy: open?.deliverBy ?? "",
    status: open?.status || statuses[0] || "",
  };
};

export function App() {
  const [tab, setTab] = useState("");
  const [data, setData] = useState<DailyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [absentees, setAbsentees] = useState<string | null>(null);
  const [newItems, setNewItems] = useState<NewItem[]>([]);
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(() => !getPasscode());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sheet, setSheet] = useState<"order" | "item" | "month" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [openOrderKey, setOpenOrderKey] = useState<string | null>(null);
  const [view, setView] = useState<"daily" | "transfers">("daily");

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
    const t = setTimeout(() => setSaved(null), 6000);
    return () => clearTimeout(t);
  }, [saved]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const statuses = data?.statuses ?? [];
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

  const dirty = changes.entries.length > 0 || changes.absenteesChanged || newItems.length > 0;

  const signals = useMemo(() => {
    const due = new Map<string, Due>();
    const low = new Set<string>();
    for (const r of rows) {
      const d = orderDue(r.order);
      if (d) due.set(rowKey(r), d);
      if (stockSignal(r).alert) low.add(rowKey(r));
    }
    return { due, low };
  }, [rows]);

  // Closing the tab with unsaved numbers loses a shift's entry; ask first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patch = (key: string, change: Partial<Draft>) => {
    setSaved(null);
    setSaveError(null);
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...change } }));
  };

  const discard = () => {
    setDrafts({});
    setAbsentees(null);
    setNewItems([]);
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
        ...(newItems.length ? { newItems } : {}),
        entries: changes.entries,
      });
      setDrafts({});
      setAbsentees(null);
      setNewItems([]);
      setPasscode("");
      setNeedsPasscode(false);
      setOpenOrderKey(null);
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

  const exportPdf = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const { exportDayPdf } = await import("./pdf");
      await exportDayPdf(data);
    } catch (err) {
      setSaveError(`Couldn't make the PDF: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => {
    const key = rowKey(r);
    if (filter === "edited" && !changes.editedKeys.has(key)) return false;
    if (filter === "orders" && !pendingOrder(r) && !drafts[key]?.order) return false;
    if (filter === "due" && !signals.due.has(key)) return false;
    if (filter === "low" && !signals.low.has(key)) return false;
    return (
      !needle ||
      r.item.toLowerCase().includes(needle) ||
      r.code.toLowerCase().includes(needle) ||
      r.section.toLowerCase().includes(needle)
    );
  });
  const sections = [...new Set(rows.map((r) => r.section))];
  const visibleSections = sections.filter((s) => visible.some((r) => r.section === s));
  const withOrders = rows.filter((r) => pendingOrder(r)).length;

  const saveLabel = [
    changes.entries.length ? `${changes.entries.length} ${changes.entries.length === 1 ? "item" : "items"}` : "",
    newItems.length ? `${newItems.length} new` : "",
    changes.absenteesChanged ? "absentees" : "",
  ]
    .filter(Boolean)
    .join(" + ");

  const ready = data && data.configured && !data.error;

  return (
    <div className="min-h-screen bg-background pb-40">
      <header className="safe-top sticky top-0 z-10 bg-brand px-4 pb-3 text-white shadow-md">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/logo.png" alt="Abu Salim" className="h-11 w-auto shrink-0 rounded-md" />
            <div className="min-w-0">
              <h1 className="text-lg font-semibold leading-tight tracking-tight">Store Entry</h1>
              <p className="truncate text-[0.7rem] text-white/70">
                {activeTab ? `Packing and dispatch · ${activeTab}` : "Packing and dispatch"}
              </p>
            </div>
          </div>
          <button
            onClick={() => void load(activeTab)}
            disabled={loading || dirty}
            aria-label="Read the sheet again"
            title={dirty ? "Save or discard first" : "Read the sheet again"}
            className="shrink-0 rounded-full border border-white/25 bg-white/10 p-2.5 disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </header>
      <div className="h-1 bg-brand-accent" />
      {ready ? (
        <div className="mx-auto max-w-2xl px-4 pt-3">
          <div className="grid grid-cols-2 rounded-xl border border-border bg-card p-1">
            {(
              [
                ["daily", "Daily entry"],
                ["transfers", "Transfers"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => {
                  // Leaving the day with unsaved numbers would hide them behind the other screen.
                  if (value === "transfers" && dirty) {
                    setSaveError("Save or discard the day's changes before switching to Transfers.");
                    return;
                  }
                  setView(value);
                }}
                className={`rounded-lg py-2 text-sm font-medium ${
                  view === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <main className="mx-auto max-w-2xl px-4 pt-4">
        {!data && loading ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Reading the sheet…</p>
        ) : loadError && !data ? (
          <Notice message={loadError} action={() => void load(tab)} />
        ) : data && !data.configured ? (
          <Notice message="Not connected to the sheet yet. Set ENTRY_SCRIPT_URL and ENTRY_SCRIPT_SECRET on Netlify (see the README)." />
        ) : data?.error ? (
          <Notice message={data.error} action={() => void load(activeTab)} />
        ) : ready && view === "transfers" ? (
          <Transfers dayRows={rows} dayTab={activeTab} onDespatched={() => void load(activeTab)} />
        ) : ready ? (
          <>
            {loadError ? <Notice message={loadError} action={() => void load(activeTab)} /> : null}

            <NewDayCard
              latestTab={data?.tabs[0] ?? activeTab}
              dirty={dirty}
              onCreated={(made, message) => {
                setSaved(message);
                setTab(made);
              }}
            />

            <div className="grid grid-cols-2 gap-2">
              <AlertCard
                tone="warn"
                icon={<CalendarClock className="size-5" />}
                count={signals.due.size}
                title={`Orders due ≤ ${DUE_SOON_DAYS} days`}
                hint={
                  [...signals.due.values()].some((d) => d.kind === "late")
                    ? `${[...signals.due.values()].filter((d) => d.kind === "late").length} late`
                    : "incl. today"
                }
                active={filter === "due"}
                onClick={() => setFilter((f) => (f === "due" ? "all" : "due"))}
              />
              <AlertCard
                tone="danger"
                icon={<TrendingDown className="size-5" />}
                count={signals.low.size}
                title="Low stock, moving well"
                hint="make these next"
                active={filter === "low"}
                onClick={() => setFilter((f) => (f === "low" ? "all" : "low"))}
              />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <ToolButton icon={<Plus className="size-4" />} label="New order" onClick={() => setSheet("order")} />
              <ToolButton icon={<PackagePlus className="size-4" />} label="New item" onClick={() => setSheet("item")} />
              <ToolButton
                icon={<FileDown className="size-4" />}
                label={exporting ? "Making…" : "Day PDF"}
                disabled={exporting}
                onClick={() => void exportPdf()}
              />
              <ToolButton icon={<CalendarRange className="size-4" />} label="Month report" onClick={() => setSheet("month")} />
            </div>
            {dirty ? (
              <p className="mt-1 text-[0.66rem] text-muted-foreground">
                The PDF shows the day as saved in the sheet; unsaved changes aren't in it.
              </p>
            ) : null}

            <div className="mt-3 grid grid-cols-2 gap-2">
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
            {dirty ? <p className="mt-1 text-[0.68rem] text-muted-foreground">Save or discard to switch day.</p> : null}

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

            <div className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-1">
              {(
                [
                  ["all", `All (${rows.length})`],
                  ["due", `Due soon (${signals.due.size})`],
                  ["low", `Low & moving (${signals.low.size})`],
                  ["edited", `Edited (${changes.editedKeys.size})`],
                  ["orders", `With orders (${withOrders})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
                    filter === value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {newItems.length ? (
              <section>
                <h2 className="mb-2 mt-5 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-primary">
                  New items · added when you save
                </h2>
                <div className="card-surface divide-y divide-border">
                  {newItems.map((n, i) => (
                    <div key={`${n.section}-${n.item}-${i}`} className="flex items-start justify-between gap-3 bg-primary/5 p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{n.item}</p>
                        <p className="text-[0.65rem] text-muted-foreground">
                          {n.section} · #{n.code || "—"} · opening <span className="num">{fmt(n.opening)}</span>
                          {n.mini != null ? ` · min ${fmt(n.mini)}` : ""}
                        </p>
                      </div>
                      <button
                        onClick={() => setNewItems((list) => list.filter((_, j) => j !== i))}
                        aria-label={`Don't add ${n.item}`}
                        className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {visible.length === 0 ? (
              <p className="card-surface mt-3 p-6 text-center text-sm text-muted-foreground">
                {filter === "edited"
                  ? "Nothing edited yet."
                  : filter === "due"
                    ? `No open orders due in the next ${DUE_SOON_DAYS} days.`
                    : filter === "low"
                      ? "No fast-moving item is low on stock."
                      : "No items match."}
              </p>
            ) : null}

            {visibleSections.map((section) => (
              <section key={section}>
                <h2 className="mb-2 mt-5 text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {section}
                </h2>
                <div className="card-surface divide-y divide-border overflow-hidden">
                  {visible
                    .filter((r) => r.section === section)
                    .map((r) => {
                      const key = rowKey(r);
                      return (
                        <ItemCard
                          key={key}
                          row={r}
                          draft={drafts[key]}
                          edited={changes.editedKeys.has(key)}
                          statuses={statuses}
                          due={signals.due.get(key) ?? null}
                          orderOpen={openOrderKey === key}
                          onToggleOrder={(open) => {
                            setOpenOrderKey(open ? key : null);
                            if (open && !drafts[key]?.order) patch(key, { order: emptyOrder(r, statuses) });
                          }}
                          onChange={(change) => patch(key, change)}
                        />
                      );
                    })}
                </div>
              </section>
            ))}
          </>
        ) : null}
      </main>

      {sheet === "order" && ready && view === "daily" ? (
        <NewOrderSheet
          rows={rows}
          statuses={statuses}
          onClose={() => setSheet(null)}
          onAdd={(key, form) => {
            patch(key, { order: form });
            setSheet(null);
            setFilter("all");
            setOpenOrderKey(key);
            requestAnimationFrame(() =>
              document.getElementById(`item-${key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
            );
          }}
        />
      ) : null}
      {sheet === "month" ? <MonthSheet dayTab={activeTab} onClose={() => setSheet(null)} /> : null}
      {sheet === "item" && ready ? (
        <NewItemSheet
          sections={sections}
          rows={rows}
          pending={newItems}
          onClose={() => setSheet(null)}
          onAdd={(item) => {
            setNewItems((list) => [...list, item]);
            setSaved(null);
            setSheet(null);
          }}
        />
      ) : null}

      {view === "daily" && (dirty || saved || saveError || changes.problem) ? (
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

/* --------------------------------- pieces ---------------------------------- */

function Notice({ message, action }: { message: string; action?: () => void }) {
  return (
    <div className="card-surface mb-3 flex items-center justify-between gap-3 p-3 text-sm text-destructive">
      <span>{message}</span>
      {action ? (
        <button onClick={action} className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground">
          Try again
        </button>
      ) : null}
    </div>
  );
}

function AlertCard({
  tone,
  icon,
  count,
  title,
  hint,
  active,
  onClick,
}: {
  tone: "warn" | "danger";
  icon: ReactNode;
  count: number;
  title: string;
  hint: string;
  active: boolean;
  onClick: () => void;
}) {
  const lit = count > 0;
  const colors = !lit
    ? "border-border bg-card text-muted-foreground"
    : tone === "warn"
      ? "border-warning/60 bg-warning/20 text-warning-foreground"
      : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border p-3 text-left transition-shadow ${colors} ${active ? "ring-2 ring-ring/40" : ""}`}
    >
      <div className="flex items-center justify-between">
        {icon}
        <span className="num text-2xl font-semibold leading-none">{count}</span>
      </div>
      <p className="mt-2 text-[0.78rem] font-semibold leading-tight">{title}</p>
      <p className="text-[0.65rem] opacity-80">{lit ? hint : "nothing to flag"}</p>
    </button>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-2 py-2.5 text-[0.78rem] font-medium disabled:opacity-60"
    >
      {icon}
      {label}
    </button>
  );
}

function ItemCard({
  row,
  draft,
  edited,
  statuses,
  due,
  orderOpen,
  onToggleOrder,
  onChange,
}: {
  row: DailyRow;
  draft: Draft | undefined;
  edited: boolean;
  statuses: string[];
  due: Due | null;
  orderOpen: boolean;
  onToggleOrder: (open: boolean) => void;
  onChange: (change: Partial<Draft>) => void;
}) {
  const prodInput = draft?.production ?? shown(row.production);
  const despInput = draft?.despatch ?? shown(row.despatch);
  const prod = parseQty(prodInput);
  const desp = parseQty(despInput);
  // The sheet computes Closing = Opening + Production − Despatch; mirror it while typing.
  const closing = prod === "invalid" || desp === "invalid" ? null : (row.opening ?? 0) + (prod ?? 0) - (desp ?? 0);
  const signal = stockSignal(row);
  const short = shortfall(row);

  const pending = pendingOrder(row);
  const order = draft?.order;
  const clearing = order === "clear";
  const form = order && order !== "clear" ? order : null;
  const orderEdited = orderChange(row, order) !== undefined;
  // Keep a status the sheet already holds selectable, even if the dropdown has changed.
  const choices = pending?.status && !statuses.includes(pending.status) ? [pending.status, ...statuses] : statuses;

  const chip = clearing
    ? "Removing order"
    : form && orderEdited
      ? `Order ${form.qty || "?"} · unsaved`
      : pending
        ? `Order ${pending.text || "—"}${pending.status ? ` · ${pending.status}` : ""}`
        : "Order";

  return (
    <div
      id={`item-${rowKey(row)}`}
      className={`p-3 ${edited ? "bg-primary/5" : ""} ${due?.kind === "late" ? "border-l-4 border-l-destructive" : due ? "border-l-4 border-l-warning" : signal.alert ? "border-l-4 border-l-destructive/60" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium leading-snug">{row.item}</p>
          <p className="text-[0.62rem] text-muted-foreground">
            #{row.code} · opening <span className="num">{fmt(row.opening)}</span>
            {row.mini != null ? (
              <>
                {" "}
                · min <span className="num">{fmt(row.mini)}</span>
              </>
            ) : null}
          </p>
        </div>
        <button
          onClick={() => onToggleOrder(!orderOpen)}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-[0.66rem] font-medium ${
            pending || orderEdited ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted-foreground"
          }`}
        >
          <ClipboardList className="size-3.5" />
          {chip}
        </button>
      </div>

      {due || signal.alert ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {due ? (
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.65rem] font-semibold ${DUE_CLASS[due.kind]}`}>
              <CalendarClock className="size-3" />
              {due.label}
              {row.order?.deliverBy ? ` · ${shortDate(row.order.deliverBy)}` : ""}
              {short ? ` · short ${fmt(short)}` : ""}
            </span>
          ) : null}
          {signal.alert ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[0.65rem] font-semibold text-destructive">
              <AlertTriangle className="size-3" />
              Low stock, moving well
              {signal.perDay ? ` · ~${signal.perDay.toFixed(signal.perDay < 10 ? 1 : 0)}/day` : ""}
              {signal.coverDays != null ? ` · ${signal.coverDays < 1 ? "<1" : Math.floor(signal.coverDays)} days left` : ""}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 grid grid-cols-3 items-end gap-2">
        <QtyBox label="Produced" value={prodInput} bad={prod === "invalid"} onChange={(v) => onChange({ production: v })} />
        <QtyBox label="Despatched" value={despInput} bad={desp === "invalid"} onChange={(v) => onChange({ despatch: v })} />
        <div className="text-right">
          <span className={labelClass}>Closing</span>
          <p
            className={`num mt-1 py-2.5 text-sm font-semibold ${
              closing != null && closing < 0 ? "text-destructive" : signal.alert ? "text-destructive" : ""
            }`}
          >
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
                onClick={() => onChange({ order: emptyOrder(row, statuses) })}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium"
              >
                Keep it
              </button>
            </div>
          ) : form ? (
            <>
              <OrderFields form={form} choices={choices} onChange={(next) => onChange({ order: next })} />
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-[0.66rem] text-muted-foreground">
                  {pending?.deliverBy ? `Now: deliver by ${shortDate(pending.deliverBy)}` : "Also copied to later day tabs that exist."}
                </p>
                {pending ? (
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

function OrderFields({
  form,
  choices,
  onChange,
}: {
  form: OrderForm;
  choices: string[];
  onChange: (form: OrderForm) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={labelClass}>Order qty</span>
          <input
            type="text"
            inputMode="decimal"
            value={form.qty}
            onChange={(e) => onChange({ ...form, qty: e.target.value })}
            placeholder="Qty"
            className={`${inputClass} num mt-1`}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Deliver by</span>
          <input
            type="date"
            value={form.deliverBy}
            onChange={(e) => onChange({ ...form, deliverBy: e.target.value })}
            className={`${inputClass} mt-1`}
          />
        </label>
      </div>
      <label className="mt-2 block">
        <span className={labelClass}>Status</span>
        <select value={form.status} onChange={(e) => onChange({ ...form, status: e.target.value })} className={`${inputClass} mt-1`}>
          {choices.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </>
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

/* --------------------------------- sheets ---------------------------------- */

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="safe-bottom max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-card px-4 pt-4 shadow-xl sm:rounded-3xl sm:pb-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full border border-border p-1.5">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Today's date in Saudi Arabia, as yyyy-mm-dd: the day changes at midnight there. */
const saudiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(new Date());

/** When today has no day tab yet, a button that runs the sheet's own ➕ Next Day for it. */
function NewDayCard({
  latestTab,
  dirty,
  onCreated,
}: {
  latestTab: string;
  dirty: boolean;
  onCreated: (tab: string, message: string) => void;
}) {
  const today = saudiToday();
  const latest = tabToIso(latestTab);
  const [busy, setBusy] = useState(false);
  /** Seconds the queued run has been going, so the button is visibly alive. */
  const [waited, setWaited] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [askPasscode, setAskPasscode] = useState(() => !getPasscode());
  if (!latest || latest >= today) return null;
  const name = isoToTab(today);

  const make = async () => {
    if (askPasscode) {
      if (!passcode.trim()) return setError("Enter the team passcode.");
      savePasscode(passcode.trim());
    }
    setBusy(true);
    setWaited(0);
    setError(null);
    const started = Date.now();
    try {
      // The sheet queues the work and we poll, so this takes the better part
      // of a minute. A button that says nothing for that long reads as broken
      // and gets pressed again.
      const r = await createDay(today, () => setWaited(Math.round((Date.now() - started) / 1000)));
      onCreated(
        r.tab,
        `Made the ${r.tab} tab from ${r.from} · ${r.ordersKept} pending ${r.ordersKept === 1 ? "order" : "orders"} carried` +
          (r.ordersDropped ? `, ${r.ordersDropped} closed` : ""),
      );
    } catch (err) {
      if (err instanceof PasscodeError) setAskPasscode(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-surface mb-3 border-l-4 border-l-primary p-3">
      <p className="text-sm font-semibold">Today ({shortDate(today)}) has no tab yet</p>
      <p className="mt-0.5 text-[0.72rem] text-muted-foreground">
        The newest is {latestTab}. This runs the sheet's ➕ Next Day for {name}: Opening from {latestTab}'s Closing,
        Suggested Mini from despatch history, open orders carried. {latestTab} needs its absentees first.
      </p>
      {askPasscode ? (
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Team passcode"
          className={`${inputClass} mt-2`}
        />
      ) : null}
      {error ? <p className="mt-2 text-[0.72rem] text-destructive">{error}</p> : null}
      <button
        onClick={() => void make()}
        disabled={busy || dirty}
        title={dirty ? "Save or discard this day's changes first" : undefined}
        className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        <Plus className="size-4" />
        {busy
          ? waited > 3
            ? `Making the tab… ${waited}s`
            : "Making the tab…"
          : dirty
            ? "Save this day's changes first"
            : `Create the ${name} tab`}
      </button>
    </div>
  );
}

/** Pick a month and download its report: every day tab added up, and the month's transfers. */
function MonthSheet({ dayTab, onClose }: { dayTab: string; onClose: () => void }) {
  const initial = (() => {
    const [m, , y] = dayTab.split("/");
    if (m && y) return `${y}-${m.padStart(2, "0")}`;
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  })();
  const [month, setMonth] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await loadMonth(month);
      const { exportMonthPdf } = await import("./pdf");
      await exportMonthPdf(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Monthly report" onClose={onClose}>
      <label className="block">
        <span className="text-[0.66rem] font-medium uppercase tracking-wide text-muted-foreground">Month</span>
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${inputClass} mt-1`} />
      </label>
      <p className="mt-2 text-[0.72rem] text-muted-foreground">
        One PDF covering every day tab of the month: each item's opening, production, despatch and closing, the daily
        totals, and all the month's transfers (route, direct sale and warehouse), by item and one by one.
      </p>
      {error ? <p className="mt-2 text-[0.75rem] text-destructive">{error}</p> : null}
      <button
        onClick={() => void make()}
        disabled={busy || !month}
        className="mb-4 mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        <FileDown className="size-4" />
        {busy ? "Reading the month… (can take ~20 s)" : "Make the PDF"}
      </button>
    </Sheet>
  );
}

function NewOrderSheet({
  rows,
  statuses,
  onClose,
  onAdd,
}: {
  rows: DailyRow[];
  statuses: string[];
  onClose: () => void;
  onAdd: (key: string, form: OrderForm) => void;
}) {
  const [key, setKey] = useState("");
  const row = rows.find((r) => rowKey(r) === key);
  const [form, setForm] = useState<OrderForm>(() => emptyOrder(undefined, statuses));
  const [problem, setProblem] = useState<string | null>(null);
  const sections = [...new Set(rows.map((r) => r.section))];

  const add = () => {
    if (!row) return setProblem("Pick the item.");
    const qty = Number(form.qty);
    if (!form.qty.trim() || !Number.isFinite(qty) || qty <= 0) return setProblem("Enter the order quantity.");
    if (!form.deliverBy) return setProblem("Pick the date it must be delivered by.");
    onAdd(key, form);
  };

  return (
    <Sheet title="New specific order" onClose={onClose}>
      <label className="block">
        <span className={labelClass}>Item</span>
        <select
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setProblem(null);
          }}
          className={`${inputClass} mt-1`}
        >
          <option value="">Choose an item…</option>
          {sections.map((s) => (
            <optgroup key={s} label={s}>
              {rows
                .filter((r) => r.section === s)
                .map((r) => (
                  <option key={rowKey(r)} value={rowKey(r)}>
                    {r.item} (#{r.code}){pendingOrder(r) ? " · has an order" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      {row ? (
        <p className="mt-1 text-[0.68rem] text-muted-foreground">
          Closing stock <span className="num">{fmt(row.closing)}</span>
          {pendingOrder(row) ? ` · replaces the current order of ${pendingOrder(row)?.text}` : ""}
        </p>
      ) : null}
      <div className="mt-3">
        <OrderFields form={form} choices={statuses} onChange={setForm} />
      </div>
      {problem ? <p className="mt-2 text-[0.75rem] text-destructive">{problem}</p> : null}
      <button onClick={add} className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">
        Add order
      </button>
      <p className="mb-3 mt-2 text-center text-[0.66rem] text-muted-foreground">It goes into the sheet when you tap Save.</p>
    </Sheet>
  );
}

function NewItemSheet({
  sections,
  rows,
  pending,
  onClose,
  onAdd,
}: {
  sections: string[];
  rows: DailyRow[];
  pending: NewItem[];
  onClose: () => void;
  onAdd: (item: NewItem) => void;
}) {
  const [section, setSection] = useState(sections[0] ?? "");
  const [code, setCode] = useState("");
  const [item, setItem] = useState("");
  const [opening, setOpening] = useState("0");
  const [mini, setMini] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const add = () => {
    const name = item.trim();
    if (!section) return setProblem("Pick the section.");
    if (!name) return setProblem("Enter the item name.");
    const same = (x: { section: string; code: string; item: string }) =>
      x.section === section &&
      x.code.trim().toLowerCase() === code.trim().toLowerCase() &&
      x.item.trim().toLowerCase() === name.toLowerCase();
    if (rows.some(same) || pending.some(same)) return setProblem("That item is already in this section.");
    const o = parseQty(opening);
    if (o === "invalid") return setProblem("Opening stock must be zero or more.");
    const m = parseQty(mini);
    if (m === "invalid") return setProblem("Minimum level must be zero or more.");
    onAdd({ section, code: code.trim(), item: name, opening: o ?? 0, mini: m });
  };

  return (
    <Sheet title="New item" onClose={onClose}>
      <label className="block">
        <span className={labelClass}>Section</span>
        <select value={section} onChange={(e) => setSection(e.target.value)} className={`${inputClass} mt-1`}>
          {sections.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="block">
          <span className={labelClass}>Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 4410" className={`${inputClass} num mt-1`} />
        </label>
        <label className="col-span-2 block">
          <span className={labelClass}>Item name</span>
          <input
            value={item}
            onChange={(e) => setItem(e.target.value)}
            placeholder="e.g. 50 Grams Sunflower Seeds Carton"
            className={`${inputClass} mt-1`}
          />
        </label>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className={labelClass}>Opening stock</span>
          <input
            inputMode="decimal"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
            className={`${inputClass} num mt-1`}
          />
        </label>
        <label className="block">
          <span className={labelClass}>Minimum level</span>
          <input
            inputMode="decimal"
            value={mini}
            onChange={(e) => setMini(e.target.value)}
            placeholder="Optional"
            className={`${inputClass} num mt-1`}
          />
        </label>
      </div>
      {problem ? <p className="mt-2 text-[0.75rem] text-destructive">{problem}</p> : null}
      <button onClick={add} className="mt-4 w-full rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground">
        Add item
      </button>
      <p className="mb-3 mt-2 text-center text-[0.66rem] text-muted-foreground">
        Added as a new row at the end of the section on this day's tab when you tap Save. Next Day carries it on.
      </p>
    </Sheet>
  );
}
