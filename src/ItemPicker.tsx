import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";

export type PickerItem = {
  key: string;
  code: string;
  name: string;
  unit: string;
  /** Store closing stock for this transfer's region; null when the store sheet doesn't carry it. */
  stock: number | null;
  /** Already a line on this transfer. */
  added: boolean;
};

const GROUPS: { name: string; test: (n: string) => boolean }[] = [
  { name: "Sunflower seeds", test: (n) => /sunflower/i.test(n) && !/combo/i.test(n) },
  { name: "Pumpkin & melon seeds", test: (n) => /pumpkin|melon/i.test(n) && !/combo/i.test(n) },
  { name: "Combos", test: (n) => /combo/i.test(n) },
  { name: "Popcorn", test: (n) => /^pc\b|popcorn/i.test(n) },
  { name: "Peanuts", test: (n) => /peanut/i.test(n) },
  { name: "Cotton candy", test: (n) => /cotton/i.test(n) },
];
const groupOf = (name: string) => GROUPS.find((g) => g.test(name))?.name ?? "Other";
const rank = (g: string) => {
  const i = GROUPS.findIndex((x) => x.name === g);
  return i < 0 ? GROUPS.length : i;
};

/** Below this the stock badge turns amber. */
const LOW_STOCK = 20;

function StockBadge({ stock }: { stock: number | null }) {
  if (stock === null) {
    return <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[0.68rem] text-muted-foreground">not on store sheet</span>;
  }
  if (stock <= 0) {
    return <span className="shrink-0 rounded-full bg-destructive/10 px-2.5 py-1 text-[0.72rem] font-semibold text-destructive">out of stock</span>;
  }
  return (
    <span
      className={`num shrink-0 rounded-full px-2.5 py-1 text-[0.72rem] font-semibold ${
        stock < LOW_STOCK ? "bg-warning/20 text-warning-foreground" : "bg-success/12 text-success"
      }`}
    >
      {stock}
      <span className="font-normal opacity-80"> {stock < LOW_STOCK ? "left" : "in stock"}</span>
    </span>
  );
}

/**
 * "Add an item": a searchable list grouped by product, with code and unit tags and the
 * store's closing stock. A dropdown on wide screens, a bottom sheet on phones.
 */
export function ItemPicker({ items, onPick }: { items: PickerItem[]; onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.code.toLowerCase().includes(needle))
      .map((i, n) => ({ ...i, group: groupOf(i.name), n }))
      .sort((a, b) => rank(a.group) - rank(b.group) || a.n - b.n);
  }, [items, q]);

  useEffect(() => {
    if (!open) return;
    setActive(0);
    const wide = window.matchMedia("(min-width: 641px)").matches;
    if (wide) search.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    list.current?.querySelector("[data-active=true]")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (key: string) => {
    onPick(key);
    setOpen(false);
    setQ("");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[active];
      if (item) pick(item.key);
    }
  };

  let lastGroup = "";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 px-3 py-3 text-sm font-semibold text-primary"
      >
        <Plus className="size-4" />
        Add an item
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onMouseDown={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label="Add an item"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={onKey}
            className="flex max-h-[82vh] w-full max-w-xl flex-col overflow-hidden rounded-t-3xl bg-card shadow-2xl sm:rounded-3xl"
          >
            <div className="border-b border-border p-3">
              <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border sm:hidden" />
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    ref={search}
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setActive(0);
                    }}
                    placeholder="Search item or code"
                    className="w-full rounded-xl border border-border bg-background py-2.5 pl-9 pr-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                  />
                </div>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="rounded-full border border-border p-2">
                  <X className="size-4" />
                </button>
              </div>
            </div>

            <div ref={list} role="listbox" className="overflow-y-auto overscroll-contain px-2 pb-3">
              {shown.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">No item matches “{q}”.</p>
              ) : (
                shown.map((i, n) => {
                  const header =
                    i.group !== lastGroup ? (
                      <div
                        key={`g-${i.group}`}
                        className="sticky top-0 z-10 mt-2 flex items-center justify-between bg-card/95 px-2 py-1.5 text-[0.66rem] font-bold uppercase tracking-[0.12em] text-muted-foreground backdrop-blur"
                      >
                        {i.group}
                        <span className="font-semibold normal-case tracking-normal">{shown.filter((x) => x.group === i.group).length}</span>
                      </div>
                    ) : null;
                  lastGroup = i.group;
                  return (
                    <div key={i.key}>
                      {header}
                      <button
                        type="button"
                        role="option"
                        aria-selected={n === active}
                        data-active={n === active}
                        onMouseEnter={() => setActive(n)}
                        onClick={() => pick(i.key)}
                        className={`flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2.5 text-left ${
                          n === active ? "bg-primary/8" : ""
                        }`}
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium leading-snug">{i.name}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span className="num rounded-full bg-muted px-2 py-0.5 text-[0.64rem] font-semibold text-muted-foreground">#{i.code}</span>
                            {i.unit ? (
                              <span className="rounded-full bg-accent/20 px-2 py-0.5 text-[0.64rem] font-semibold text-accent-foreground">{i.unit}</span>
                            ) : null}
                            {i.added ? (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[0.64rem] font-semibold text-primary">added</span>
                            ) : null}
                          </span>
                        </span>
                        <StockBadge stock={i.stock} />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
