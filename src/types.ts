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

/* -------------------------------- transfers -------------------------------- */

/** A requisition from the requisition app with no transfer made against it yet. */
export type Requisition = {
  docNo: string;
  /** yyyy-mm-dd */
  date: string;
  salesman: string;
  route: string;
  notes: string;
  lines: { code: string; name: string; unit: string; quantity: number }[];
};

export type TransferLine = {
  code: string;
  name: string;
  unit: string;
  stockTransfer: number;
  physicalStock: number;
  systemStock: number;
  piecesReimbursed: number;
  variance: number;
};

/** A saved transfer, as the Transfers tab of the requisition sheet holds it. */
/**
 * Where the stock went: a salesman's route, a customer directly, a regional
 * warehouse, or nowhere — an internal adjustment, which takes stock off the
 * books without it leaving as a sale.
 */
export type TransferKindValue = "route" | "direct" | "warehouse" | "adjustment";

/** Why an internal adjustment was made. "other" carries typed text with it. */
export type AdjustReasonValue = "replaced" | "damaged" | "other";

export type Transfer = {
  kind: TransferKindValue;
  docNo: string;
  date: string;
  salesman: string;
  route: string;
  requisitionRef: string;
  /** Direct sales only; empty otherwise. */
  invoiceNo: string;
  /** Adjustments only: "replaced", "damaged", or "other". Empty otherwise. */
  adjustReason: AdjustReasonValue | "";
  notes: string;
  createdAt: string;
  lines: TransferLine[];
};

export type TransferData = {
  configured: boolean;
  items: { code: string; name: string; unit: string }[];
  salesmen: { route: string; name: string }[];
  units: string[];
  requisitions: Requisition[];
  transfers: Transfer[];
  error?: string;
};

/** Which day-tab row a transfer line's quantity is added to as Despatch. */
export type StoreTarget = { section: string; code: string; item: string };

export type TransferWrite = {
  kind: TransferKindValue;
  /** yyyy-mm-dd; Despatch goes to the day tab of this date. */
  date: string;
  route: string;
  salesman: string;
  requisitionRef: string;
  invoiceNo: string;
  /** Adjustments only. The readable wording goes in `salesman`. */
  adjustReason: AdjustReasonValue | "";
  notes: string;
  lines: (Omit<TransferLine, "variance"> & { target: StoreTarget | null })[];
};

export type TransferResult = {
  docNo: string;
  day: string;
  despatched: { item: string; added: number; despatch: number }[];
};

/** A month of day tabs and transfers, for the monthly report. */
export type MonthData = {
  /** yyyy-mm */
  month: string;
  days: { tab: string; absentees: string; production: number; despatch: number; error: string }[];
  /** Opening from the month's first day tab, closing from its last; production and despatch summed. */
  items: {
    section: string;
    code: string;
    item: string;
    opening: number | null;
    production: number;
    despatch: number;
    closing: number | null;
    /** Days with production or despatch. */
    days: number;
  }[];
  transfers: Transfer[];
};
