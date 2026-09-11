import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { inspectPngAlpha } from "./imageAssetValidation.js";

export interface RasterNormalization {
  width: number;
  height: number;
  alpha: "preserve" | "opaque" | "remove_white";
}

export interface RasterNormalizationReceipt {
  version: 1;
  rawHash: string;
  rawSizeBytes: number;
  rawWidth: number;
  rawHeight: number;
  options: RasterNormalization;
  removedPixels: number;
  outputHash: string;
}

export function parseRasterNormalization(value: unknown): RasterNormalization | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("normalization must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !["width", "height", "alpha"].includes(key)) ||
      !Number.isInteger(v.width) || !Number.isInteger(v.height) ||
      Number(v.width) < 1 || Number(v.height) < 1 || Number(v.width) > 4096 || Number(v.height) > 4096 ||
      !["preserve", "opaque", "remove_white"].includes(String(v.alpha))) {
    throw new Error("normalization requires width/height 1–4096 and alpha preserve|opaque|remove_white");
  }
  return { width: Number(v.width), height: Number(v.height), alpha: v.alpha as RasterNormalization["alpha"] };
}

/** Deterministic production transform, not a visual quality approval. */
export function normalizeGeneratedRaster(raw: Buffer, options: RasterNormalization): { buffer: Buffer; receipt: RasterNormalizationReceipt } {
  parseRasterNormalization(options);
  // Bound and validate decompression before pngjs allocates decoded storage.
  inspectPngAlpha(raw);
  const source = PNG.sync.read(raw);
  const { width: sw, height: sh, data } = source;
  let removedPixels = 0;
  if (options.alpha === "remove_white") {
    // Only edge-connected near-white pixels: enclosed white highlights survive.
    const seen = new Uint8Array(sw * sh);
    const queue = new Int32Array(sw * sh);
    let head = 0, tail = 0;
    const visit = (pixel: number) => {
      if (seen[pixel]) return;
      seen[pixel] = 1;
      const offset = pixel * 4;
      if (data[offset + 3]! > 0 && Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!) < 225) return;
      queue[tail++] = pixel;
    };
    for (let x = 0; x < sw; x++) { visit(x); visit((sh - 1) * sw + x); }
    for (let y = 0; y < sh; y++) { visit(y * sw); visit(y * sw + sw - 1); }
    while (head < tail) {
      const pixel = queue[head++]!;
      if (data[pixel * 4 + 3]! > 0) removedPixels++;
      data[pixel * 4 + 3] = 0;
      const x = pixel % sw, y = Math.floor(pixel / sw);
      if (x > 0) visit(pixel - 1);
      if (x + 1 < sw) visit(pixel + 1);
      if (y > 0) visit(pixel - sw);
      if (y + 1 < sh) visit(pixel + sw);
    }
  }
  const output = new PNG({ width: options.width, height: options.height });
  const scale = Math.min(options.width / sw, options.height / sh);
  const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
  const ox = Math.floor((options.width - dw) / 2), oy = Math.floor((options.height - dh) / 2);
  if (options.alpha === "opaque") output.data.fill(255);
  // Box downsampling with premultiplied alpha prevents white/dark halos.
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let r = 0, g = 0, b = 0, a = 0, count = 0;
    for (let sy = Math.floor(y * sh / dh); sy < Math.min(sh, Math.ceil((y + 1) * sh / dh)); sy++) {
      for (let sx = Math.floor(x * sw / dw); sx < Math.min(sw, Math.ceil((x + 1) * sw / dw)); sx++) {
        const i = (sy * sw + sx) * 4, alpha = data[i + 3]! / 255;
        r += data[i]! * alpha; g += data[i + 1]! * alpha; b += data[i + 2]! * alpha; a += alpha; count++;
      }
    }
    const o = ((y + oy) * options.width + x + ox) * 4;
    const opaque = options.alpha === "opaque";
    output.data[o] = opaque ? Math.round((r + (count - a) * 255) / count) : a ? Math.round(r / a) : 0;
    output.data[o + 1] = opaque ? Math.round((g + (count - a) * 255) / count) : a ? Math.round(g / a) : 0;
    output.data[o + 2] = opaque ? Math.round((b + (count - a) * 255) / count) : a ? Math.round(b / a) : 0;
    output.data[o + 3] = opaque ? 255 : Math.round(a / count * 255);
  }
  const buffer = PNG.sync.write(output);
  return { buffer, receipt: {
    version: 1, rawHash: hash(raw), rawSizeBytes: raw.length, rawWidth: sw, rawHeight: sh,
    options, removedPixels, outputHash: hash(buffer)
  } };
}

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
