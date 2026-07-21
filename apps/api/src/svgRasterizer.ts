import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Resvg } from "@resvg/resvg-js";

export interface SvgRasterizeResult {
  hash: string;
  sizeBytes: number;
  width: number;
  height: number;
}

export function rasterizeSvgFile(sourcePath: string, outputPath: string, width?: number): SvgRasterizeResult {
  if (!sourcePath.toLowerCase().endsWith(".svg")) {
    throw new Error(`SVG 位图渲染只接受 .svg 源文件：${sourcePath}`);
  }
  if (!outputPath.toLowerCase().endsWith(".png")) {
    throw new Error(`SVG 位图渲染必须输出 .png 文件：${outputPath}`);
  }
  const svg = readFileSync(sourcePath, "utf8");
  if (Buffer.byteLength(svg, "utf8") > 5 * 1024 * 1024) {
    throw new Error("单个 SVG 源文件不能超过 5 MB。");
  }
  if (!/^\s*<svg\b[\s\S]*<\/svg>\s*$/i.test(svg) || /<script\b|\bon\w+\s*=|javascript:/i.test(svg)) {
    throw new Error(`SVG 内容无效或包含脚本：${sourcePath}`);
  }
  const targetWidth = width === undefined ? undefined : Math.max(1, Math.min(4096, Math.round(width)));
  const renderer = new Resvg(svg, {
    ...(targetWidth ? { fitTo: { mode: "width", value: targetWidth } as const } : {})
  });
  const rendered = renderer.render();
  const png = rendered.asPng();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, png);
  const stats = statSync(outputPath);
  return {
    hash: createHash("sha256").update(png).digest("hex"),
    sizeBytes: stats.size,
    width: rendered.width,
    height: rendered.height
  };
}
