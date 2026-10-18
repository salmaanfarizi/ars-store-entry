import { fmt, shortDate } from "./api";
import { orderDue, shortfall, stockSignal } from "./insights";
import type { DailyData } from "./types";

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

/** The day as saved in the sheet, as an A4 PDF: alerts first, then every item by section. */
export async function exportDayPdf(data: DailyData): Promise<void> {
  // Loaded on demand: the PDF library is larger than the rest of the app together.
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 10;

  // Header band with the logo.
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, pageWidth, 30, "F");
  const logo = await logoDataUrl();
  if (logo) doc.addImage(logo, "PNG", margin, 4, 39, 22);
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text("Store Update - Finished Goods", pageWidth - margin, 12, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(`ARS International Co SPC  |  Day ${data.tab}`, pageWidth - margin, 18.5, { align: "right" });
  doc.text(
    `Absentees: ${data.absentees || "none"}  |  Generated ${new Date().toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`,
    pageWidth - margin,
    24,
    { align: "right" },
  );
  doc.setDrawColor(...ORANGE);
  doc.setLineWidth(0.8);
  doc.line(0, 30, pageWidth, 30);

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
      body.push([
        r.code,
        r.item,
        fmt(r.opening),
        r.production == null ? "" : fmt(r.production),
        r.despatch == null ? "" : fmt(r.despatch),
        fmt(r.closing),
        fmt(r.mini),
        r.order?.text || "",
        r.order?.deliverBy ? shortDate(r.order.deliverBy) : "",
        r.order?.status || "",
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
