import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { inspectPngAlpha } from "./imageAssetValidation.js";

export interface ContactSheetSource { path: string; label: string; buffer: Buffer }
export interface ContactSheetReceipt {
  version: 1;
  sources: Array<{ path: string; label: string; hash: string; sizeBytes: number }>;
  outputHash: string;
  width: number;
  height: number;
}

/** Render the actual images, not a model's imagined redraw of the asset set. */
export function composeAssetContactSheet(sources: ContactSheetSource[], title: string): { buffer: Buffer; receipt: ContactSheetReceipt } {
  if (sources.length < 1 || sources.length > 32 || new Set(sources.map((s) => s.path)).size !== sources.length)
    throw new Error("Contact sheet requires 1–32 unique PNG sources.");
  const columns = 4, cell = 240, width = columns * cell, height = 96 + Math.ceil(sources.length / columns) * 270;
  const receipts: ContactSheetReceipt["sources"] = [];
  let total = 0;
  const tiles = sources.map((source, i) => {
    total += source.buffer.length;
    if (total > 20 * 1024 * 1024) throw new Error("Contact sheet source bytes exceed 20 MiB.");
    const dimensions = inspectPngAlpha(source.buffer, source.path);
    const ratio = Math.min(208 / dimensions.width, 208 / dimensions.height);
    const w = dimensions.width * ratio, h = dimensions.height * ratio;
    const x = (i % columns) * cell, y = 90 + Math.floor(i / columns) * 270;
    receipts.push({ path: source.path, label: source.label, hash: hash(source.buffer), sizeBytes: source.buffer.length });
    return `<rect x="${x + 8}" y="${y}" width="224" height="224" rx="12" fill="url(#checker)"/>
      <image x="${x + 120 - w / 2}" y="${y + 112 - h / 2}" width="${w}" height="${h}" href="data:image/png;base64,${source.buffer.toString("base64")}"/>
      <text x="${x + 120}" y="${y + 246}" text-anchor="middle" font-size="18">${escape(source.label.slice(0,60))}</text>
      <text x="${x + 120}" y="${y + 266}" text-anchor="middle" font-size="12" fill="#66756f">${dimensions.width} × ${dimensions.height} · ${Math.ceil(source.buffer.length / 1024)} KB</text>`;
  }).join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="checker" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#edf0ec"/><path d="M0 0h8v8H0zM8 8h8v8H8z" fill="#d7dfd9"/></pattern></defs>
    <rect width="100%" height="100%" fill="#f7f9f5"/>
    <g font-family="PingFang SC, Noto Sans CJK SC, sans-serif" fill="#193a31"><text x="24" y="40" font-size="26">${escape(title.slice(0,100))}</text>
    <text x="24" y="67" font-size="15">真实运行素材 / Actual runtime pixels · ${sources.length} assets</text>${tiles}</g></svg>`;
  const buffer = Buffer.from(new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
  return { buffer, receipt: { version: 1, sources: receipts, outputHash: hash(buffer), width, height } };
}
function escape(text: string): string { return text.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]!)); }
function hash(buffer: Buffer): string { return createHash("sha256").update(buffer).digest("hex"); }
