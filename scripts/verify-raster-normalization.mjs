import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PNG } from "pngjs";
import { normalizeGeneratedRaster, parseRasterNormalization } from "../apps/api/dist/rasterNormalization.js";
import { inspectPngAlpha, assertPngAlphaPolicy } from "../apps/api/dist/imageAssetValidation.js";
import { parseToolOperations } from "../apps/api/dist/claudeCliHarness.js";
const source = new PNG({ width: 16, height: 16 });
source.data.fill(255);
for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) {
  source.data[(y * 16 + x) * 4] = 20;
  source.data[(y * 16 + x) * 4 + 1] = 60;
  source.data[(y * 16 + x) * 4 + 2] = 90;
}
// Enclosed white highlight must not disappear with the external white matte.
source.data.fill(255, (8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4);
const raw = PNG.sync.write(source);
const result = normalizeGeneratedRaster(raw, { width: 16, height: 16, alpha: "remove_white" });
const decoded = PNG.sync.read(result.buffer);
assert.equal(decoded.data[3], 0);
assert.equal(decoded.data[(8 * 16 + 8) * 4 + 3], 255);
assert.equal(result.receipt.removedPixels, 192);
assert.equal(result.receipt.rawHash, createHash("sha256").update(raw).digest("hex"));
assert.equal(result.receipt.outputHash, createHash("sha256").update(result.buffer).digest("hex"));
const receiptRoot = mkdtempSync(join(tmpdir(), "btp-normalization-ipc-"));
try {
  const log = join(receiptRoot, "operations.jsonl");
  writeFileSync(log, JSON.stringify({ toolName: "generate_raster_asset", path: "assets/art/test.png", normalizationReceipt: result.receipt }));
  assert.deepEqual(parseToolOperations(log)[0].normalizationReceipt, result.receipt);
} finally { rmSync(receiptRoot, { recursive: true, force: true }); }
const small = normalizeGeneratedRaster(raw, { width: 4, height: 8, alpha: "remove_white" });
assert.equal(inspectPngAlpha(small.buffer).width, 4);
assert.equal(inspectPngAlpha(small.buffer).height, 8);
assertPngAlphaPolicy(inspectPngAlpha(small.buffer), "required");
assert.throws(() => assertPngAlphaPolicy(inspectPngAlpha(small.buffer), "opaque"), /非全不透明/);
const flattened = normalizeGeneratedRaster(result.buffer, { width: 8, height: 8, alpha: "opaque" });
assertPngAlphaPolicy(inspectPngAlpha(flattened.buffer), "opaque");
for (let i = 3; i < source.data.length; i += 4) source.data[i] = 252;
assert.throws(() => assertPngAlphaPolicy(inspectPngAlpha(PNG.sync.write(source)), "required"), /没有有效透明区域/);
assert.throws(() => parseRasterNormalization({ width: 99999, height: 1, alpha: "preserve" }));
assert.throws(() => parseRasterNormalization({ width: 2, height: 2, alpha: "bad" }));
assert.throws(() => normalizeGeneratedRaster(Buffer.from("fake"), { width: 2, height: 2, alpha: "opaque" }));
console.log("Raster normalization passed: bounded resize, edge-connected matte removal, preserved internal highlights, strict alpha and raw/output provenance.");
