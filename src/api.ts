import type { DailyData, DailyWrite, MonthData } from "./types";

/** Section + code + item: the same code appears once per destination section. */
export const rowKey = (r: { section: string; code: string; item: string }) =>
  `${r.section}|${r.code}|${r.item}`;

/* --------------------------------- passcode -------------------------------- */

const PASSCODE_KEY = "ars-store-entry/passcode";

const storage = {
  get: () => {
    try {
      return localStorage.getItem(PASSCODE_KEY) ?? "";
    } catch {
      return "";
    }
  },
  set: (v: string) => {
    try {
      localStorage.setItem(PASSCODE_KEY, v);
    } catch {
      /* private mode: asked again next time */
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(PASSCODE_KEY);
    } catch {
      /* nothing stored */
    }
  },
};

export const getPasscode = storage.get;
export const savePasscode = storage.set;

export class PasscodeError extends Error {}

/* ---------------------------------- calls ---------------------------------- */

/** Read live every time: an entry form that starts from old numbers overwrites other people's work. */
export async function loadDaily(tab: string): Promise<DailyData> {
  const res = await fetch(`/api/daily${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Couldn't read the sheet (HTTP ${res.status})`);
  return (await res.json()) as DailyData;
}

/** A month (yyyy-mm) added up from its day tabs, with its transfers. */
export async function loadMonth(month: string): Promise<MonthData> {
  const res = await fetch(`/api/month?month=${encodeURIComponent(month)}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as MonthData & { message?: string };
  if (!res.ok) throw new Error(body.message || `Couldn't read the month (HTTP ${res.status})`);
  return body;
}

export async function saveDaily(write: DailyWrite): Promise<{ cells: number }> {
  const passcode = getPasscode();
  if (!passcode) throw new PasscodeError("Passcode required");

  const res = await fetch("/api/daily", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-passcode": passcode },
    body: JSON.stringify(write),
  });
  if (res.status === 401) {
    storage.clear();
    throw new PasscodeError("That passcode wasn't accepted");
  }
  const body = (await res.json().catch(() => ({}))) as { message?: string; cells?: number };
  if (!res.ok) throw new Error(body.message ?? `Couldn't save (HTTP ${res.status})`);
  return { cells: body.cells ?? 0 };
}

/* --------------------------------- parsing --------------------------------- */

/** What a quantity box holds → what to send. "" clears the cell. */
export function parseQty(input: string): number | null | "invalid" {
  const t = input.trim();
  if (t === "") return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

export const fmt = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** yyyy-mm-dd → "Tue 20 Oct". */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
