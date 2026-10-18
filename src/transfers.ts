import { getPasscode, PasscodeError } from "./api";
import type { DailyRow, StoreTarget, TransferData, TransferResult, TransferWrite } from "./types";

export async function loadTransfers(): Promise<TransferData> {
  const res = await fetch("/api/transfers", { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't read transfers (HTTP ${res.status})`);
  return (await res.json()) as TransferData;
}

export async function saveTransfer(write: TransferWrite): Promise<TransferResult> {
  const passcode = getPasscode();
  if (!passcode) throw new PasscodeError("Passcode required");
  const res = await fetch("/api/transfers", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-passcode": passcode },
    body: JSON.stringify(write),
  });
  if (res.status === 401) throw new PasscodeError("That passcode wasn't accepted");
  const body = (await res.json().catch(() => ({}))) as Partial<TransferResult> & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `Couldn't save the transfer (HTTP ${res.status})`);
  return { docNo: body.docNo ?? "", day: body.day ?? "", despatched: body.despatched ?? [] };
}

/* ------------------------------ store matching ----------------------------- */

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[×]/g, " x ")
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/** Share of words two item names have in common: the sheets spell the same item slightly differently. */
function likeness(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  let both = 0;
  A.forEach((w) => B.has(w) && both++);
  return both / Math.max(1, A.size + B.size - both);
}

/** The store section a route's stock normally comes from. */
function regionOf(route: string): "riyadh" | "qatar" | "regular" {
  const r = route.toLowerCase();
  if (/qatar|doha/.test(r)) return "qatar";
  if (/riyadh|ryadh|kharj|qaseem|qassim/.test(r)) return "riyadh";
  return "regular";
}

const sectionRegion = (section: string) => {
  const s = section.toLowerCase();
  return s.includes("riyadh") ? "riyadh" : s.includes("qatar") ? "qatar" : "regular";
};

/** Every day-tab row a line could be despatched from: same item code. */
export function storeCandidates(rows: DailyRow[], code: string): DailyRow[] {
  const c = code.trim();
  return c ? rows.filter((r) => r.code.trim() === c) : [];
}

/**
 * The row a line's quantity most likely leaves from: same code, then the closest name
 * (1126 is two different 10kg bags), then the section that serves the route's region
 * (4402 is in both Regular and Riyadh). Null when the store sheet has no such code.
 */
export function suggestTarget(rows: DailyRow[], code: string, name: string, route: string): StoreTarget | null {
  const candidates = storeCandidates(rows, code);
  if (!candidates.length) return null;
  const region = regionOf(route);
  let best = candidates[0]!;
  let bestScore = -1;
  for (const r of candidates) {
    const score = likeness(r.item, name) * 10 + (sectionRegion(r.section) === region ? 3 : 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return { section: best.section, code: best.code, item: best.item };
}

/** "REGULAR SUNFLOWER SEEDS IN BUNDLES…" → "Regular". */
export const sectionShort = (section: string) => {
  const first = section.trim().split(/\s+/)[0] ?? section;
  return first.charAt(0) + first.slice(1).toLowerCase();
};

export const targetKey = (t: StoreTarget | null) => (t ? `${t.section}|${t.code}|${t.item}` : "");

/** "10/18/2026" → "2026-10-18". */
export function tabToIso(tab: string): string {
  const m = tab.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : "";
}

/** "2026-10-18" → "10/18/2026", the day tab's name. */
export function isoToTab(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? `${m}/${d}/${y}` : iso;
}
