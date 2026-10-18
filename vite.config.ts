import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { DailyData, DailyWrite } from "./src/types.ts";

/**
 * In-memory stand-in for /api/daily during `npm run dev`, so the form can be exercised with
 * no Apps Script. Saves change the sample day and reset with the dev server; the passcode
 * is APP_PASSCODE or "dev".
 */
function devDailyApi(): Plugin {
  const passcode = process.env.APP_PASSCODE ?? "dev";
  const row = (section: string, code: string, item: string, opening: number, despatch: number | null) => ({
    section,
    code,
    item,
    opening,
    production: null,
    despatch,
    closing: opening - (despatch ?? 0),
    order: null,
  });
  const day: DailyData = {
    configured: true,
    tab: "10/18/2026",
    tabs: ["10/18/2026", "10/17/2026", "10/15/2026"],
    absentees: "",
    statuses: ["PENDING", "MET"],
    rows: [
      row("REGULAR SUNFLOWER SEEDS IN BUNDLES/BAGS/CARTON", "4402", "200 Grams Sunflower Seeds Bundles(10 Pieces x 5 Bags)", 722, 112),
      row("REGULAR SUNFLOWER SEEDS IN BUNDLES/BAGS/CARTON", "1126", "10kg Blue Sunflower Seeds DAMMAM SPL(STD)", 280, null),
      {
        ...row("RIYADH SUNFLOWER SEEDS IN BUNDLE/BAGS/CARTON", "1127", "10kg Orange Sunflower Seeds Riyadh(ECO)", 0, null),
        order: { qty: 200, text: "200", deliverBy: "2026-10-21", status: "PENDING" },
      },
      row("POPCORN IN CARTON", "1712", "PC- Salted-16 gm (8 x 8) Master Carton", 19, null),
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
        return send({ ok: true, tab: body.tab, cells });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devDailyApi()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
