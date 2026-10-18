import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { DailyData, DailyWrite, TransferData, TransferWrite } from "./src/types.ts";

/**
 * In-memory stand-in for /api/daily during `npm run dev`, so the form can be exercised with
 * no Apps Script. Saves change the sample day and reset with the dev server; the passcode
 * is APP_PASSCODE or "dev".
 */
function devDailyApi(): Plugin {
  const passcode = process.env.APP_PASSCODE ?? "dev";
  const row = (
    section: string,
    code: string,
    item: string,
    opening: number,
    despatch: number | null,
    mini: number | null,
    active: number,
    total: number,
  ) => ({
    section,
    code,
    item,
    opening,
    production: null,
    despatch,
    closing: opening - (despatch ?? 0),
    mini,
    movement: { days: 14, active, total },
    order: null as DailyData["rows"][number]["order"],
  });
  const inDays = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const day: DailyData = {
    configured: true,
    tab: "10/18/2026",
    tabs: ["10/18/2026", "10/17/2026", "10/15/2026"],
    absentees: "",
    statuses: ["PENDING", "MET"],
    rows: [
      row("REGULAR SUNFLOWER SEEDS IN BUNDLES/BAGS/CARTON", "4402", "200 Grams Sunflower Seeds Bundles(10 Pieces x 5 Bags)", 722, 112, 800, 12, 1400),
      row("REGULAR SUNFLOWER SEEDS IN BUNDLES/BAGS/CARTON", "1126", "10kg Blue Sunflower Seeds DAMMAM SPL(STD)", 280, null, 300, 2, 40),
      {
        ...row("RIYADH SUNFLOWER SEEDS IN BUNDLE/BAGS/CARTON", "1127", "10kg Orange Sunflower Seeds Riyadh(ECO)", 0, null, 600, 6, 300),
        order: { qty: 200, text: "200", deliverBy: inDays(1), status: "PENDING" },
      },
      {
        ...row("RIYADH SUNFLOWER SEEDS IN BUNDLE/BAGS/CARTON", "4407", "20 Grams Sunflower Seeds (6x 30) Master Carton", 218, null, 300, 3, 60),
        order: { qty: 50, text: "50", deliverBy: inDays(-1), status: "PENDING" },
      },
      row("POPCORN IN CARTON", "1712", "PC- Salted-16 gm (8 x 8) Master Carton", 19, null, 100, 1, 4),
    ],
  };

  return {
    name: "dev-daily-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/daily", async (req, res) => {
        const send = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(body));
        };

        if (req.method === "GET") return send(day);
        if (req.method !== "POST") return send({ message: `${req.method} not supported.` }, 405);
        if (req.headers["x-app-passcode"] !== passcode) return send({ message: "Wrong passcode." }, 401);

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as DailyWrite;
        let cells = 0;
        for (const e of body.entries) {
          const r = day.rows.find((x) => x.section === e.section && x.code === e.code && x.item === e.item);
          if (!r) return send({ message: `"${e.item}" is not on the ${body.tab} tab.` }, 502);
          if (e.production !== undefined) (r.production = e.production), cells++;
          if (e.despatch !== undefined) (r.despatch = e.despatch), cells++;
          if (e.order) {
            r.order =
              e.order.action === "clear"
                ? null
                : { qty: e.order.qty, text: String(e.order.qty), deliverBy: e.order.deliverBy, status: e.order.status };
            cells++;
          }
          r.closing = (r.opening ?? 0) + (r.production ?? 0) - (r.despatch ?? 0);
        }
        if (body.absentees !== undefined) (day.absentees = body.absentees), cells++;
        for (const n of body.newItems ?? []) {
          const at = day.rows.map((r) => r.section).lastIndexOf(n.section);
          const added = row(n.section, n.code, n.item, n.opening, null, n.mini, 0, 0);
          day.rows.splice(at + 1, 0, added);
          cells++;
        }
        return send({ ok: true, tab: body.tab, cells });
      });
    },
  };
}

/**
 * In-memory stand-in for /api/transfers: two open requisitions from the real sheet's shape,
 * and saves that answer as the script would (despatch is reported, not written anywhere).
 */
function devTransfersApi(): Plugin {
  const passcode = process.env.APP_PASSCODE ?? "dev";
  const transfers: TransferData["transfers"] = [];
  const requisitions: TransferData["requisitions"] = [
    {
      docNo: "REQ-2026-0042",
      date: "2026-10-18",
      salesman: "Jaseel",
      route: "Al Ahsa 3",
      notes: "",
      lines: [
        { code: "4402", name: "200 Grams Sunflower Seeds (10 Pieces × 5 Bags)", unit: "Bundle", quantity: 15 },
        { code: "1126", name: "10kg Blue Sunflower Seeds DAMMAM SPL (STD)", unit: "Bag", quantity: 4 },
        { code: "1901", name: "Mango Cotton Candy", unit: "Carton", quantity: 2 },
      ],
    },
    {
      docNo: "REQ-2026-0041",
      date: "2026-10-17",
      salesman: "Khalid",
      route: "Riyadh 3",
      notes: "",
      lines: [{ code: "4401", name: "100 Grams Sunflower Seeds (12 Pieces × 5 Bags)", unit: "Bundle", quantity: 10 }],
    },
  ];
  const data = (): TransferData => ({
    configured: true,
    items: [
      { code: "4402", name: "200 Grams Sunflower Seeds (10 Pieces × 5 Bags)", unit: "Bundle" },
      { code: "4401", name: "100 Grams Sunflower Seeds (12 Pieces × 5 Bags)", unit: "Bundle" },
      { code: "1126", name: "10kg Blue Sunflower Seeds DAMMAM SPL (STD)", unit: "Bag" },
      { code: "1712", name: "PC – Salted 16 gm (8 × 8)", unit: "Carton" },
      { code: "1901", name: "Mango Cotton Candy", unit: "Carton" },
    ],
    salesmen: [
      { route: "Al Ahsa 3", name: "Jaseel" },
      { route: "Riyadh 3", name: "Khalid" },
    ],
    units: ["Bag", "Bundle", "Box", "Carton"],
    requisitions: requisitions.filter((r) => !transfers.some((t) => t.requisitionRef === r.docNo)),
    transfers,
  });

  return {
    name: "dev-transfers-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/api/transfers", async (req, res) => {
        const send = (body: unknown, status = 200) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(body));
        };
        if (req.method === "GET") return send(data());
        if (req.method !== "POST") return send({ message: `${req.method} not supported.` }, 405);
        if (req.headers["x-app-passcode"] !== passcode) return send({ message: "Wrong passcode." }, 401);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as TransferWrite;
        const docNo = `TRF-2026-${String(transfers.length + 101).padStart(4, "0")}`;
        transfers.unshift({
          kind: body.kind ?? "route",
          docNo,
          date: body.date,
          salesman: body.salesman,
          route: body.route,
          requisitionRef: body.requisitionRef,
          notes: body.notes,
          createdAt: new Date().toISOString(),
          lines: body.lines.map(({ target: _t, ...l }) => ({ ...l, variance: l.physicalStock - l.systemStock })),
        });
        const [y, m, d] = body.date.split("-").map(Number);
        return send({
          docNo,
          day: `${m}/${d}/${y}`,
          despatched: body.lines
            .filter((l) => l.target && l.stockTransfer > 0)
            .map((l) => ({ item: l.target!.item, added: l.stockTransfer, despatch: l.stockTransfer })),
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devDailyApi(), devTransfersApi()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
