import type { DailyRow, OrderCell } from "./types";

/** An open order due within this many days (or already late) is flagged. */
export const DUE_SOON_DAYS = 2;

/** Stock that covers fewer days than this at the recent despatch rate counts as low. */
export const LOW_COVER_DAYS = 7;

/** "Good movement": despatched on at least this many of the last two weeks' day tabs. */
export const MOVING_MIN_DAYS = 4;

/** MET is the sheet's word for delivered; these states no longer need chasing. */
export const isClosedStatus = (status: string) =>
  /^met$|deliver|cancel|done|complet|closed/i.test(status.trim());

const startOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

export type Due = { kind: "late" | "today" | "soon"; days: number; label: string };

/** How urgent an open order is; null when it isn't due within DUE_SOON_DAYS. */
export function orderDue(order: OrderCell | null): Due | null {
  if (!order || !order.deliverBy || isClosedStatus(order.status)) return null;
  const [y, m, d] = order.deliverBy.split("-").map(Number);
  if (!y || !m || !d) return null;
  const days = Math.round((new Date(y, m - 1, d).getTime() - startOfToday().getTime()) / 86_400_000);
  if (days < 0) return { kind: "late", days, label: days === -1 ? "1 day late" : `${-days} days late` };
  if (days === 0) return { kind: "today", days, label: "Due today" };
  if (days <= DUE_SOON_DAYS) return { kind: "soon", days, label: days === 1 ? "Due tomorrow" : `Due in ${days} days` };
  return null;
}

/** How many more are needed to fill an open order from closing stock, if any. */
export function shortfall(row: DailyRow): number | null {
  if (!row.order || row.order.qty == null || isClosedStatus(row.order.status)) return null;
  const gap = row.order.qty - Math.max(0, row.closing ?? 0);
  return gap > 0 ? gap : null;
}

export type StockSignal = {
  /** Average despatched per day over the days looked at. */
  perDay: number | null;
  /** Days the closing stock lasts at that rate. */
  coverDays: number | null;
  low: boolean;
  moving: boolean;
  /** Low and moving well: the items to make next. */
  alert: boolean;
};

export function stockSignal(row: DailyRow): StockSignal {
  const closing = row.closing ?? 0;
  const { days, active, total } = row.movement ?? { days: 0, active: 0, total: 0 };
  const perDay = days > 0 && total > 0 ? total / days : null;
  const coverDays = perDay ? Math.max(0, closing) / perDay : null;
  const low = (row.mini != null && row.mini > 0 && closing < row.mini) || (coverDays != null && coverDays < LOW_COVER_DAYS);
  const moving = active >= MOVING_MIN_DAYS;
  return { perDay, coverDays, low, moving, alert: low && moving };
}
