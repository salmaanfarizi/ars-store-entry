/** A finished good's order, as held in the day tab's Specific Order / Deliver By / Order Status cells. */
export type OrderCell = {
  qty: number | null;
  /** The Specific Order cell as displayed, in case someone typed words. */
  text: string;
  /** yyyy-mm-dd, or "" when the cell isn't a real date. */
  deliverBy: string;
  status: string;
};

/** One finished good on a day tab, as the entry page edits it. */
export type DailyRow = {
  section: string;
  code: string;
  item: string;
  opening: number | null;
  production: number | null;
  despatch: number | null;
  closing: number | null;
  /** The Mini Level cell: below this the item is short. */
  mini: number | null;
  /** Despatch over the last two weeks of day tabs, up to this one. */
  movement: Movement;
  order: OrderCell | null;
};

export type Movement = {
  /** Day tabs looked at. */
  days: number;
  /** Days it was despatched at all. */
  active: number;
  /** Total despatched over those days. */
  total: number;
};

/** An item to add as a new row at the end of its section. */
export type NewItem = {
  section: string;
  code: string;
  item: string;
  opening: number;
  mini: number | null;
};

/** A day tab read live from the sheet, so an entry never starts from stale numbers. */
export type DailyData = {
  /** False until the Apps Script URL and secret are set on the site. */
  configured: boolean;
  tab: string;
  /** Recent day tabs, newest first, for back-filling a missed day. */
  tabs: string[];
  /** The "No. of Absentees (e.g. 2S 1O)" cell. */
  absentees: string;
  /** What the Order Status column accepts. */
  statuses: string[];
  rows: DailyRow[];
  error?: string;
};

export type OrderEdit =
  | { action: "set"; qty: number; /** yyyy-mm-dd */ deliverBy: string; status: string }
  | { action: "clear" };

/**
 * Changes to one day tab. An omitted field is left alone, a number is written, and null
 * clears the cell. Only what the person edited is sent, so a colleague's entry in another
 * cell is never overwritten by a form that was opened earlier.
 */
export type DailyWrite = {
  tab: string;
  absentees?: string;
  newItems?: NewItem[];
  entries: {
    section: string;
    code: string;
    item: string;
    production?: number | null;
    despatch?: number | null;
    order?: OrderEdit;
  }[];
};
