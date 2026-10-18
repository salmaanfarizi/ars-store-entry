import { fmt, shortDate } from "./api";
import { orderDue, pendingOrder, shortfall, stockSignal } from "./insights";
import type { DailyData, Transfer } from "./types";

const NAVY: [number, number, number] = [32, 35, 87];
const ORANGE: [number, number, number] = [245, 166, 35];
const LATE: [number, number, number] = [253, 226, 226];
const SOON: [number, number, number] = [255, 241, 214];

async function logoDataUrl(): Promise<string | null> {
  try {
    const blob = await (await fetch("/logo.png")).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const generatedAt = () =>
  new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

type Doc = import("jspdf").jsPDF;

/** Navy band with the logo on the left, the title and two lines on the right, an orange rule under it. */
function drawHeader(doc: Doc, logo: string | null, title: string, lines: [string, string]) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageWidth, 30, "F");
  if (logo) doc.addImage(logo, "PNG", margin, 4, 39, 22);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(title, pageWidth - margin, 12, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(lines[0], pageWidth - margin, 18.5, { align: "right" });
  doc.text(lines[1], pageWidth - margin, 24, { align: "right" });
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(0.8);
  doc.line(0, 30, pageWidth, 30);
  doc.setTextColor(30, 30, 30);
}

/** The day as saved in the sheet, as an A4 PDF: alerts first, then every item by section. */
export async function exportDayPdf(data: DailyData): Promise<void> {
  // Loaded on demand: the PDF library is larger than the rest of the app together.
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;

  drawHeader(doc, await logoDataUrl(), "Store Update - Finished Goods", [
    `ARS International Co SPC  |  Day ${data.tab}`,
    `Absentees: ${data.absentees || "none"}  |  Generated ${generatedAt()}`,
  ]);

  let y = 37;
  doc.setTextColor(30, 30, 30);

  const due = data.rows
    .map((r) => ({ r, due: orderDue(r.order) }))
    .filter((x) => x.due)
    .sort((a, b) => a.due!.days - b.due!.days);
  const lowMoving = data.rows.map((r) => ({ r, s: stockSignal(r) })).filter((x) => x.s.alert);

  const heading = (title: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    doc.text(title, margin, y);
    doc.setTextColor(30, 30, 30);
    y += 2;
  };
  const after = () => {
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  };

  heading(`Orders due within 2 days (${due.length})`);
  if (due.length) {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Item", "Code", "Order", "Deliver by", "When", "Status", "Closing", "Short by"]],
      body: due.map(({ r, due: d }) => [
        r.item,
        r.code,
        r.order?.text || "-",
        r.order?.deliverBy ? shortDate(r.order.deliverBy) : "-",
        d!.label,
        r.order?.status || "PENDING",
        fmt(r.closing),
        fmt(shortfall(r)),
      ]),
      styles: { fontSize: 8, cellPadding: 1.4 },
      headStyles: { fillColor: NAVY },
      didParseCell: (cell) => {
        if (cell.section !== "body") return;
        const d = due[cell.row.index]?.due;
        cell.cell.styles.fillColor = d?.kind === "late" ? LATE : SOON;
      },
    });
    after();
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("None.", margin, y + 4);
    y += 11;
  }

  heading(`Low stock, moving well (${lowMoving.length})`);
  if (lowMoving.length) {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Item", "Section", "Closing", "Minimum", "Avg / day", "Days of cover", "Moved on"]],
      body: lowMoving.map(({ r, s }) => [
        r.item,
        r.section,
        fmt(r.closing),
        fmt(r.mini),
        s.perDay == null ? "-" : s.perDay.toFixed(1),
        s.coverDays == null ? "-" : s.coverDays.toFixed(1),
        `${r.movement.active} of ${r.movement.days} days`,
      ]),
      styles: { fontSize: 8, cellPadding: 1.4 },
      headStyles: { fillColor: NAVY },
    });
    after();
  } else {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("None.", margin, y + 4);
    y += 11;
  }

  heading("All items");
  const sections = [...new Set(data.rows.map((r) => r.section))];
  type Row = (string | { content: string; colSpan: number; styles: Record<string, unknown> })[];
  const body: Row[] = [];
  const flags: ("late" | "soon" | "low" | null)[] = [];
  for (const section of sections) {
    body.push([{ content: section, colSpan: 10, styles: { fillColor: [232, 233, 243], fontStyle: "bold" } }]);
    flags.push(null);
    for (const r of data.rows.filter((x) => x.section === section)) {
      const d = orderDue(r.order);
      const s = stockSignal(r);
      // Met orders are done with; only pending ones are printed.
      const order = pendingOrder(r);
      body.push([
        r.code,
        r.item,
        fmt(r.opening),
        r.production == null ? "" : fmt(r.production),
        r.despatch == null ? "" : fmt(r.despatch),
        fmt(r.closing),
        fmt(r.mini),
        order?.text || "",
        order?.deliverBy ? shortDate(order.deliverBy) : "",
        order?.status || "",
      ]);
      flags.push(d?.kind === "late" ? "late" : d ? "soon" : s.alert ? "low" : null);
    }
  }
  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["Code", "Item", "Open", "Prod", "Desp", "Close", "Min", "Order", "Deliver by", "Status"]],
    body,
    styles: { fontSize: 7.5, cellPadding: 1.2 },
    headStyles: { fillColor: NAVY },
    columnStyles: {
      1: { cellWidth: 62 },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right", fontStyle: "bold" },
      6: { halign: "right" },
      7: { halign: "right" },
    },
    didParseCell: (cell) => {
      if (cell.section !== "body") return;
      const flag = flags[cell.row.index];
      if (flag === "late") cell.cell.styles.fillColor = LATE;
      else if (flag === "soon") cell.cell.styles.fillColor = SOON;
      else if (flag === "low" && cell.column.index === 5) cell.cell.styles.textColor = [190, 30, 30];
    },
  });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text(
      `Red rows: order late  |  Amber rows: order due within 2 days  |  Red closing: low stock, moving well   |   Page ${i} of ${pages}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 6,
      { align: "center" },
    );
  }

  const [m, d, yy] = data.tab.split("/");
  const stamp = yy && m && d ? `${yy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : "day";
  doc.save(`store-update-${stamp}.pdf`);
}

/** One stock transfer to a salesman, as an A4 PDF to hand over or file. */
export async function exportTransferPdf(t: Transfer): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  const title = t.kind === "direct" ? "Direct Sale" : t.kind === "warehouse" ? "Warehouse Transfer" : "Stock Transfer";
  const to =
    t.kind === "direct"
      ? `Customer: ${t.salesman || "-"}`
      : t.kind === "warehouse"
        ? `To: ${t.salesman || t.route || "-"}`
        : `${t.salesman || "-"}  |  ${t.route || "-"}`;
  drawHeader(doc, await logoDataUrl(), `${title} ${t.docNo}`, [
    `ARS International Co SPC  |  ${shortDate(t.date)} ${t.date.slice(0, 4)}`,
    `${to}${t.invoiceNo ? `  |  Invoice ${t.invoiceNo}` : ""}${t.requisitionRef ? `  |  Requisition ${t.requisitionRef}` : ""}`,
  ]);

  const sum = (k: "stockTransfer" | "physicalStock" | "systemStock" | "piecesReimbursed" | "variance") =>
    t.lines.reduce((n, l) => n + l[k], 0);
  autoTable(doc, {
    startY: 38,
    margin: { left: margin, right: margin },
    head: [["Code", "Item", "Unit", "Transfer", "Physical", "System", "Reimbursed", "Variance"]],
    body: t.lines.map((l) => [
      l.code,
      l.name,
      l.unit,
      fmt(l.stockTransfer),
      fmt(l.physicalStock),
      fmt(l.systemStock),
      fmt(l.piecesReimbursed),
      fmt(l.variance),
    ]),
    foot: [
      [
        "",
        "Total",
        "",
        ...(["stockTransfer", "physicalStock", "systemStock", "piecesReimbursed", "variance"] as const).map((k) => ({
          content: fmt(sum(k)),
          styles: { halign: "right" as const },
        })),
      ],
    ],
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: NAVY },
    footStyles: { fillColor: [232, 233, 243], textColor: [30, 30, 30], fontStyle: "bold" },
    columnStyles: { 1: { cellWidth: 70 }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right" }, 7: { halign: "right" } },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  if (t.notes) {
    doc.text(`Notes: ${t.notes}`, margin, y);
    y += 8;
  }
  doc.text("Variance = Physical - System.", margin, y);
  y += 22;
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.3);
  const w = (pageWidth - margin * 2 - 20) / 2;
  doc.line(margin, y, margin + w, y);
  doc.line(pageWidth - margin - w, y, pageWidth - margin, y);
  doc.text("Store keeper", margin, y + 5);
  const receiver = t.kind === "direct" ? "Customer" : t.kind === "warehouse" ? "Received at warehouse" : "Salesman";
  doc.text(`${receiver}${t.salesman && t.kind !== "warehouse" ? ` (${t.salesman})` : ""}`, pageWidth - margin - w, y + 5);

  doc.save(`${t.docNo || "transfer"}.pdf`);
}

/** Every transfer of one day, as an A4 PDF: each transfer, then the quantity per item by kind. */
export async function exportTransfersDayPdf(date: string, transfers: Transfer[]): Promise<void> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;
  const day = transfers.filter((t) => t.date === date);
  const qty = (t: Transfer) => t.lines.reduce((n, l) => n + l.stockTransfer, 0);
  const kindName = { route: "Route", direct: "Direct sale", warehouse: "Warehouse" } as const;
  const count = (k: Transfer["kind"]) => day.filter((t) => t.kind === k).length;

  drawHeader(doc, await logoDataUrl(), "Transfers of the Day", [
    `ARS International Co SPC  |  ${shortDate(date)} ${date.slice(0, 4)}`,
    `${day.length} ${day.length === 1 ? "transfer" : "transfers"}: ${count("route")} route, ${count("direct")} direct, ${count("warehouse")} warehouse  |  Generated ${generatedAt()}`,
  ]);

  let y = 37;
  const heading = (title: string) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...NAVY);
    doc.text(title, margin, y);
    doc.setTextColor(30, 30, 30);
    y += 2;
  };
  const after = () => {
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  };

  heading(`Transfers (${day.length})`);
  if (!day.length) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("No transfers on this day.", margin, y + 4);
  } else {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Doc no", "Type", "To", "Invoice / requisition", "Items", "Quantity"]],
      body: day.map((t) => [
        t.docNo,
        kindName[t.kind],
        t.kind === "route" ? `${t.salesman || "-"} (${t.route || "-"})` : t.salesman || t.route || "-",
        [t.invoiceNo && `Inv ${t.invoiceNo}`, t.requisitionRef].filter(Boolean).join("  ") || "-",
        String(t.lines.length),
        fmt(qty(t)),
      ]),
      foot: [["", "", "", "Total", "", { content: fmt(day.reduce((n, t) => n + qty(t), 0)), styles: { halign: "right" as const } }]],
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: NAVY },
      footStyles: { fillColor: [232, 233, 243], textColor: [30, 30, 30], fontStyle: "bold" },
      columnStyles: { 4: { halign: "right" }, 5: { halign: "right" } },
    });
    after();

    // The same item can go out on several transfers; one row per item, split by kind.
    type Sum = { code: string; name: string; unit: string; route: number; direct: number; warehouse: number };
    const sums = new Map<string, Sum>();
    for (const t of day) {
      for (const l of t.lines) {
        const key = `${l.code}|${l.name}|${l.unit}`;
        const s = sums.get(key) ?? { code: l.code, name: l.name, unit: l.unit, route: 0, direct: 0, warehouse: 0 };
        s[t.kind] += l.stockTransfer;
        sums.set(key, s);
      }
    }
    const items = [...sums.values()].sort((a, b) => a.name.localeCompare(b.name));
    const total = (k: "route" | "direct" | "warehouse") => items.reduce((n, s) => n + s[k], 0);
    heading(`By item (${items.length})`);
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [["Code", "Item", "Unit", "Route", "Direct", "Warehouse", "Total"]],
      body: items.map((s) => [
        s.code,
        s.name,
        s.unit,
        s.route ? fmt(s.route) : "",
        s.direct ? fmt(s.direct) : "",
        s.warehouse ? fmt(s.warehouse) : "",
        fmt(s.route + s.direct + s.warehouse),
      ]),
      foot: [
        [
          "",
          "Total",
          "",
          ...[total("route"), total("direct"), total("warehouse"), total("route") + total("direct") + total("warehouse")].map((n) => ({
            content: fmt(n),
            styles: { halign: "right" as const },
          })),
        ],
      ],
      styles: { fontSize: 8.5, cellPadding: 1.6 },
      headStyles: { fillColor: NAVY },
      footStyles: { fillColor: [232, 233, 243], textColor: [30, 30, 30], fontStyle: "bold" },
      columnStyles: { 1: { cellWidth: 78 }, 3: { halign: "right" }, 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right", fontStyle: "bold" } },
    });
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text(`Page ${i} of ${pages}`, pageWidth / 2, doc.internal.pageSize.getHeight() - 6, { align: "center" });
  }

  doc.save(`transfers-${date}.pdf`);
}
