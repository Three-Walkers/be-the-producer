import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  parseAssetManifest,
  type AssetAlphaPolicy,
  type AssetAlphaPolicySource
} from "@game-pipeline/shared-schemas";
import { readFileSync } from "node:fs";
import { resolveWorkspacePathTarget } from "./workspaceWriter.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 33_554_432;
// Cache measurements, never acceptance. Always hash the current bytes, not a
// filename/mtime, and bound memory without retaining compressed image buffers.
const alphaMeasurements = new Map<string, PngAlphaInspectionReceipt>();
const MAX_ALPHA_MEASUREMENTS = 256;

export type PngAlphaSource = "none" | "channel" | "palette" | "color_key";

export interface PngAlphaInspectionReceipt {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
  alphaSource: PngAlphaSource;
  hasAlphaInformation: boolean;
  totalPixels: number;
  opaquePixels: number;
  transparentPixels: number;
  fullyTransparentPixels: number;
  semiTransparentPixels: number;
  visiblePixels: number;
  transparentRatio: number;
  edgePixels: number;
  transparentEdgePixels: number;
  transparentEdgeRatio: number;
  minimumAlpha: number;
  maximumAlpha: number;
}

export interface RuntimeAssetAlphaValidationReceipt extends PngAlphaInspectionReceipt {
  runtimePath: string;
  assetId: string;
  alphaPolicy: AssetAlphaPolicy;
  alphaPolicySource: AssetAlphaPolicySource;
  migrationRequired: boolean;
}

export class ImageAssetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAssetValidationError";
  }
}

/**
 * Re-reads and decodes every manifest runtime PNG. The returned receipts are
 * measurements, not model claims; callers may store/log them if desired.
 */
export function validateManifestRuntimeAssetAlphaPolicies(
  projectId: string,
  manifestValue: unknown,
  options: { requireCurrentSchema?: boolean; enforcePolicy?: boolean } = {}
): RuntimeAssetAlphaValidationReceipt[] {
  const manifest = parseAssetManifest(manifestValue);
  if (options.requireCurrentSchema !== false && manifest.migrationRequired) {
    throw new ImageAssetValidationError(
      "Stage 2 asset manifest 必须迁移到 schemaVersion=2.0.0，并为每个 runtimePath 显式声明 alphaPolicy。"
    );
  }
  return manifest.runtimeAssets.map((asset) => {
    if (!asset.runtimePath.toLowerCase().endsWith(".png")) {
      throw new ImageAssetValidationError(`runtime 美术资产必须是 PNG：${asset.runtimePath}`);
    }
    const target = resolveWorkspacePathTarget(projectId, asset.runtimePath);
    if (!target.exists || target.type !== "file") {
      throw new ImageAssetValidationError(`runtime PNG 不存在或不是普通文件：${asset.runtimePath}`);
    }
    const inspection = inspectPngAlpha(readFileSync(target.absolutePath), asset.runtimePath);
    // A negative review must be able to describe a real, decodable but invalid
    // image. Acceptance and build callers retain the strict default.
    if (options.enforcePolicy !== false) assertPngAlphaPolicy(inspection, asset.alphaPolicy, asset.runtimePath);
    return {
      runtimePath: asset.runtimePath,
      assetId: asset.id,
      alphaPolicy: asset.alphaPolicy,
      alphaPolicySource: asset.alphaPolicySource,
      migrationRequired: manifest.migrationRequired,
      ...inspection
    };
  });
}

export function assertPngAlphaPolicy(
  receipt: PngAlphaInspectionReceipt,
  policy: AssetAlphaPolicy,
  label = "PNG"
): void {
  if (policy === "required") {
    if (receipt.transparentPixels === 0) {
      throw new ImageAssetValidationError(
        `${label} 声明 alphaPolicy=required，但所有像素均完全不透明。`
      );
    }
    if (receipt.visiblePixels === 0) {
      throw new ImageAssetValidationError(
        `${label} 声明 alphaPolicy=required，但整张图片完全透明，没有可见像素。`
      );
    }
    if (receipt.minimumAlpha > 0.95) {
      throw new ImageAssetValidationError(
        `${label} 声明 alphaPolicy=required，但最小 alpha=${receipt.minimumAlpha.toFixed(4)}，只有近不透明噪声，没有有效透明区域。`
      );
    }
  } else if (policy === "opaque" && receipt.transparentPixels > 0) {
    throw new ImageAssetValidationError(
      `${label} 声明 alphaPolicy=opaque，但检测到 ${receipt.transparentPixels}/${receipt.totalPixels} 个非全不透明像素。`
    );
  }
}

/** Decode PNG image data and measure effective per-pixel alpha. */
export function inspectPngAlpha(body: Buffer, label = "PNG"): PngAlphaInspectionReceipt {
  const hash = createHash("sha256").update(body).digest("hex");
  const cached = alphaMeasurements.get(hash);
  if (cached) {
    alphaMeasurements.delete(hash);
    alphaMeasurements.set(hash, cached);
    return { ...cached };
  }
  const receipt = decodePngAlpha(body, label);
  alphaMeasurements.set(hash, { ...receipt });
  if (alphaMeasurements.size > MAX_ALPHA_MEASUREMENTS) {
    alphaMeasurements.delete(alphaMeasurements.keys().next().value!);
  }
  return receipt;
}

function decodePngAlpha(body: Buffer, label: string): PngAlphaInspectionReceipt {
  const parsed = parsePng(body, label);
  const passes = parsed.interlace === 0
    ? [{ startX: 0, startY: 0, stepX: 1, stepY: 1 }]
    : [
        { startX: 0, startY: 0, stepX: 8, stepY: 8 },
        { startX: 4, startY: 0, stepX: 8, stepY: 8 },
        { startX: 0, startY: 4, stepX: 4, stepY: 8 },
        { startX: 2, startY: 0, stepX: 4, stepY: 4 },
        { startX: 0, startY: 2, stepX: 2, stepY: 4 },
        { startX: 1, startY: 0, stepX: 2, stepY: 2 },
        { startX: 0, startY: 1, stepX: 1, stepY: 2 }
      ];
  const channels = channelsForColorType(parsed.colorType);
  const bitsPerPixel = channels * parsed.bitDepth;
  const expectedInflatedBytes = passes.reduce((total, pass) => {
    const passWidth = passSize(parsed.width, pass.startX, pass.stepX);
    const passHeight = passSize(parsed.height, pass.startY, pass.stepY);
    if (passWidth === 0 || passHeight === 0) return total;
    return total + passHeight * (1 + Math.ceil(passWidth * bitsPerPixel / 8));
  }, 0);
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(parsed.idat), { maxOutputLength: expectedInflatedBytes });
  } catch (error) {
    throw new ImageAssetValidationError(
      `${label} 的 IDAT zlib 数据无法按声明尺寸解压：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (inflated.byteLength !== expectedInflatedBytes) {
    throw new ImageAssetValidationError(
      `${label} 的 IDAT 解压长度 ${inflated.byteLength} 与预期 ${expectedInflatedBytes} 不一致。`
    );
  }

  const alphaScale = alphaScaleFor(parsed);
  const transparentKey = transparencyKeyFor(parsed, label);
  let offset = 0;
  let opaquePixels = 0;
  let fullyTransparentPixels = 0;
  let semiTransparentPixels = 0;
  let visiblePixels = 0;
  let edgePixels = 0;
  let transparentEdgePixels = 0;
  let minimumAlpha = alphaScale;
  let maximumAlpha = 0;

  for (const pass of passes) {
    const passWidth = passSize(parsed.width, pass.startX, pass.stepX);
    const passHeight = passSize(parsed.height, pass.startY, pass.stepY);
    if (passWidth === 0 || passHeight === 0) continue;
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);
    const filterBytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
    let previous: Buffer<ArrayBufferLike> = Buffer.alloc(rowBytes);
    for (let passY = 0; passY < passHeight; passY += 1) {
      const filterType = inflated[offset];
      if (filterType === undefined || filterType > 4) {
        throw new ImageAssetValidationError(`${label} 包含非法 PNG filter type：${String(filterType)}`);
      }
      const filtered = inflated.subarray(offset + 1, offset + 1 + rowBytes);
      if (filtered.byteLength !== rowBytes) {
        throw new ImageAssetValidationError(`${label} 的 IDAT scanline 被截断。`);
      }
      const row = unfilterRow(filtered, previous, filterType, filterBytesPerPixel);
      offset += rowBytes + 1;
      previous = row;

      for (let passX = 0; passX < passWidth; passX += 1) {
        const x = pass.startX + passX * pass.stepX;
        const y = pass.startY + passY * pass.stepY;
        const alpha = effectiveAlpha(row, passX, parsed, transparentKey, label);
        minimumAlpha = Math.min(minimumAlpha, alpha);
        maximumAlpha = Math.max(maximumAlpha, alpha);
        if (alpha === alphaScale) opaquePixels += 1;
        else if (alpha === 0) fullyTransparentPixels += 1;
        else semiTransparentPixels += 1;
        if (alpha > 0) visiblePixels += 1;
        if (x === 0 || y === 0 || x === parsed.width - 1 || y === parsed.height - 1) {
          edgePixels += 1;
          if (alpha < alphaScale) transparentEdgePixels += 1;
        }
      }
    }
  }
  if (offset !== inflated.byteLength) {
    throw new ImageAssetValidationError(`${label} 的 IDAT 含有未消费的 scanline 数据。`);
  }
  const totalPixels = parsed.width * parsed.height;
  const transparentPixels = fullyTransparentPixels + semiTransparentPixels;
  if (opaquePixels + transparentPixels !== totalPixels) {
    throw new ImageAssetValidationError(`${label} 的 PNG 像素计数与 IHDR 尺寸不一致。`);
  }
  return {
    width: parsed.width,
    height: parsed.height,
    bitDepth: parsed.bitDepth,
    colorType: parsed.colorType,
    interlaced: parsed.interlace === 1,
    alphaSource: alphaSourceFor(parsed),
    hasAlphaInformation: alphaSourceFor(parsed) !== "none",
    totalPixels,
    opaquePixels,
    transparentPixels,
    fullyTransparentPixels,
    semiTransparentPixels,
    visiblePixels,
    transparentRatio: ratio(transparentPixels, totalPixels),
    edgePixels,
    transparentEdgePixels,
    transparentEdgeRatio: ratio(transparentEdgePixels, edgePixels),
    minimumAlpha: ratio(minimumAlpha, alphaScale),
    maximumAlpha: ratio(maximumAlpha, alphaScale)
  };
}

interface ParsedPng {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  paletteEntries?: number;
  transparency?: Buffer;
  idat: Buffer[];
}

function parsePng(body: Buffer, label: string): ParsedPng {
  if (body.byteLength < 45 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageAssetValidationError(`${label} 不是合法 PNG 文件。`);
  }
  let offset = 8;
  let parsed: ParsedPng | undefined;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  while (offset < body.byteLength) {
    if (offset + 12 > body.byteLength) throw new ImageAssetValidationError(`${label} 的 PNG chunk header 被截断。`);
    const length = body.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > body.byteLength) {
      throw new ImageAssetValidationError(`${label} 的 PNG chunk 长度越界。`);
    }
    const typeBytes = body.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageAssetValidationError(`${label} 含非法 PNG chunk type。`);
    if ((typeBytes[2] ?? 0) >= 97 && (typeBytes[2] ?? 0) <= 122) {
      throw new ImageAssetValidationError(`${label} 的 ${type} chunk 使用了非法 reserved bit。`);
    }
    const expectedCrc = body.readUInt32BE(dataEnd);
    const actualCrc = crc32(body.subarray(typeStart, dataEnd));
    if (expectedCrc !== actualCrc) throw new ImageAssetValidationError(`${label} 的 ${type} chunk CRC 不匹配。`);
    const data = body.subarray(dataStart, dataEnd);

    if (!parsed && type !== "IHDR") throw new ImageAssetValidationError(`${label} 的第一个 PNG chunk 必须是 IHDR。`);
    if (sawIdat && type !== "IDAT" && type !== "IEND") endedIdat = true;
    if (type === "IHDR") {
      if (parsed || length !== 13) throw new ImageAssetValidationError(`${label} 的 IHDR 重复或长度无效。`);
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (
        !width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS ||
        bitDepth === undefined || colorType === undefined || !validBitDepth(colorType, bitDepth) ||
        compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)
      ) {
        throw new ImageAssetValidationError(`${label} 的 IHDR 参数无效或超过安全上限。`);
      }
      parsed = { width, height, bitDepth, colorType, interlace, idat: [] };
    } else if (type === "PLTE") {
      if (
        !parsed ||
        sawIdat ||
        parsed.paletteEntries !== undefined ||
        parsed.colorType === 0 ||
        parsed.colorType === 4 ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768
      ) {
        throw new ImageAssetValidationError(`${label} 的 PLTE chunk 无效。`);
      }
      parsed.paletteEntries = length / 3;
      if (parsed.colorType === 3 && parsed.paletteEntries > 2 ** parsed.bitDepth) {
        throw new ImageAssetValidationError(`${label} 的 PLTE 颜色数超过索引 bit depth。`);
      }
    } else if (type === "tRNS") {
      if (!parsed || sawIdat || parsed.transparency || (parsed.colorType === 3 && parsed.paletteEntries === undefined)) {
        throw new ImageAssetValidationError(`${label} 的 tRNS 顺序或数量无效。`);
      }
      parsed.transparency = Buffer.from(data);
    } else if (type === "IDAT") {
      if (!parsed || endedIdat || length === 0 || (parsed.colorType === 3 && parsed.paletteEntries === undefined)) {
        throw new ImageAssetValidationError(`${label} 的 IDAT 顺序或长度无效。`);
      }
      sawIdat = true;
      parsed.idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      if (!parsed || !sawIdat || length !== 0 || sawIend) throw new ImageAssetValidationError(`${label} 的 IEND 无效。`);
      sawIend = true;
      offset = chunkEnd;
      break;
    } else if ((typeBytes[0] ?? 0) >= 65 && (typeBytes[0] ?? 0) <= 90) {
      throw new ImageAssetValidationError(`${label} 含不支持的关键 PNG chunk：${type}`);
    }
    offset = chunkEnd;
  }
  if (!parsed || !sawIend || offset !== body.byteLength || parsed.idat.length === 0) {
    throw new ImageAssetValidationError(`${label} 的 PNG chunk 流不完整或 IEND 后仍有数据。`);
  }
  if (parsed.colorType === 3 && parsed.paletteEntries === undefined) {
    throw new ImageAssetValidationError(`${label} 的索引色 PNG 缺少 PLTE。`);
  }
  validateTransparencyChunk(parsed, label);
  return parsed;
}

function validateTransparencyChunk(parsed: ParsedPng, label: string): void {
  const length = parsed.transparency?.byteLength;
  if (length === undefined) return;
  if (parsed.colorType === 0 && length !== 2) throw new ImageAssetValidationError(`${label} 的灰度 tRNS 长度无效。`);
  if (parsed.colorType === 2 && length !== 6) throw new ImageAssetValidationError(`${label} 的真彩色 tRNS 长度无效。`);
  if (parsed.colorType === 3 && (length === 0 || length > (parsed.paletteEntries ?? 0))) {
    throw new ImageAssetValidationError(`${label} 的索引色 tRNS 长度无效。`);
  }
  if (parsed.colorType === 4 || parsed.colorType === 6) {
    throw new ImageAssetValidationError(`${label} 的含 alpha 色型不得携带 tRNS。`);
  }
}

function transparencyKeyFor(parsed: ParsedPng, label: string): readonly number[] | undefined {
  if (!parsed.transparency) return undefined;
  if (parsed.colorType === 3) return [...parsed.transparency];
  const max = 2 ** parsed.bitDepth - 1;
  const values = parsed.colorType === 0
    ? [parsed.transparency.readUInt16BE(0)]
    : [
        parsed.transparency.readUInt16BE(0),
        parsed.transparency.readUInt16BE(2),
        parsed.transparency.readUInt16BE(4)
      ];
  if (values.some((value) => value > max)) {
    throw new ImageAssetValidationError(`${label} 的 tRNS 样本超出 bit depth。`);
  }
  return values;
}

function effectiveAlpha(
  row: Buffer,
  pixelIndex: number,
  parsed: ParsedPng,
  transparencyKey: readonly number[] | undefined,
  label: string
): number {
  const channels = channelsForColorType(parsed.colorType);
  const sampleOffset = pixelIndex * channels;
  const sample = (channel: number): number => readSample(row, sampleOffset + channel, parsed.bitDepth, label);
  const max = alphaScaleFor(parsed);
  if (parsed.colorType === 4) return sample(1);
  if (parsed.colorType === 6) return sample(3);
  if (parsed.colorType === 3) {
    const index = sample(0);
    if (index >= (parsed.paletteEntries ?? 0)) {
      throw new ImageAssetValidationError(`${label} 的像素引用了 PLTE 范围外索引 ${index}。`);
    }
    return transparencyKey?.[index] ?? 255;
  }
  if (parsed.colorType === 0 && transparencyKey) return sample(0) === transparencyKey[0] ? 0 : max;
  if (parsed.colorType === 2 && transparencyKey) {
    return sample(0) === transparencyKey[0] && sample(1) === transparencyKey[1] && sample(2) === transparencyKey[2]
      ? 0
      : max;
  }
  return max;
}

function readSample(row: Buffer, sampleIndex: number, bitDepth: number, label: string): number {
  if (bitDepth === 8) {
    const value = row[sampleIndex];
    if (value === undefined) throw new ImageAssetValidationError(`${label} 的 scanline 样本越界。`);
    return value;
  }
  if (bitDepth === 16) {
    const offset = sampleIndex * 2;
    if (offset + 2 > row.byteLength) throw new ImageAssetValidationError(`${label} 的 16-bit scanline 样本越界。`);
    return row.readUInt16BE(offset);
  }
  const bitOffset = sampleIndex * bitDepth;
  const byte = row[Math.floor(bitOffset / 8)];
  if (byte === undefined) throw new ImageAssetValidationError(`${label} 的 packed scanline 样本越界。`);
  const shift = 8 - bitDepth - bitOffset % 8;
  return byte >> shift & (2 ** bitDepth - 1);
}

function unfilterRow(filtered: Buffer, previous: Buffer, filterType: number, bytesPerPixel: number): Buffer {
  const row = Buffer.allocUnsafe(filtered.byteLength);
  for (let index = 0; index < filtered.byteLength; index += 1) {
    const raw = filtered[index] ?? 0;
    const left = index >= bytesPerPixel ? row[index - bytesPerPixel] ?? 0 : 0;
    const up = previous[index] ?? 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] ?? 0 : 0;
    let predictor = 0;
    if (filterType === 1) predictor = left;
    else if (filterType === 2) predictor = up;
    else if (filterType === 3) predictor = Math.floor((left + up) / 2);
    else if (filterType === 4) predictor = paeth(left, up, upperLeft);
    row[index] = (raw + predictor) & 0xff;
  }
  return row;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance ? up : upperLeft;
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function validBitDepth(colorType: number, bitDepth: number): boolean {
  return (
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && [8, 16].includes(bitDepth)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    (colorType === 4 && [8, 16].includes(bitDepth)) ||
    (colorType === 6 && [8, 16].includes(bitDepth))
  );
}

function channelsForColorType(colorType: number): number {
  if (colorType === 0 || colorType === 3) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new ImageAssetValidationError(`不支持的 PNG color type：${colorType}`);
}

function alphaScaleFor(parsed: ParsedPng): number {
  return parsed.colorType === 3 ? 255 : 2 ** parsed.bitDepth - 1;
}

function alphaSourceFor(parsed: ParsedPng): PngAlphaSource {
  if (parsed.colorType === 4 || parsed.colorType === 6) return "channel";
  if (parsed.colorType === 3 && parsed.transparency) return "palette";
  if ((parsed.colorType === 0 || parsed.colorType === 2) && parsed.transparency) return "color_key";
  return "none";
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
