import type { Config } from "@netlify/functions";
import type { MonthData } from "../../src/types";
import { callScript, json, scriptConfigured } from "../lib/script";

/** A month's day tabs and transfers, added up, for the monthly report. Read-only. */
export default async (req: Request) => {
  if (req.method !== "GET") return json({ message: `${req.method} not supported.` }, 405);
  const month = new URL(req.url).searchParams.get("month") ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ message: "Pick a month." }, 400);
  if (!scriptConfigured()) return json({ message: "The entry script isn't set up yet." }, 503);
  try {
    const reply = await callScript({ method: "GET", params: { view: "month", month } });
    const data: MonthData = {
      month: String(reply.month ?? month),
      days: (reply.days as MonthData["days"] | undefined) ?? [],
      items: (reply.items as MonthData["items"] | undefined) ?? [],
      transfers: (reply.transfers as MonthData["transfers"] | undefined) ?? [],
    };
    return json(data);
  } catch (err) {
    return json({ message: err instanceof Error ? err.message : String(err) }, 502);
  }
};

export const config: Config = { path: "/api/month" };
