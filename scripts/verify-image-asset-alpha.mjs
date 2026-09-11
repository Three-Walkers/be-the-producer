import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-image-alpha-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");

const { createStudioKernel } = await import("../packages/agent-runtime/dist/index.js");
const { parseAssetManifest } = await import("../packages/shared-schemas/dist/index.js");
const {
  assertPngAlphaPolicy,
  inspectPngAlpha,
  validateManifestRuntimeAssetAlphaPolicies
} = await import("../apps/api/dist/imageAssetValidation.js");
const { taskOutputsVerified } = await import("../apps/api/dist/taskOutputEvidence.js");
const {
  bindMediaGenerationArtifactMetadata,
  mediaGenerationOperationMetadata
} = await import("../apps/api/dist/mediaArtifactEvidence.js");
const { parseCurrentAssetManifestText } = await import("../apps/api/dist/assetManifestArtifacts.js");
const { reconcileAssetTechnicalFailures } = await import("../apps/api/dist/assetTechnicalFeedback.js");

const RGB_OPAQUE = png({ width: 2, height: 1, colorType: 2, rows: [[255, 0, 0, 0, 255, 0]] });
const RGBA_OPAQUE = png({ width: 2, height: 1, colorType: 6, rows: [[255, 0, 0, 255, 0, 255, 0, 255]] });
const RGBA_ALPHA = png({ width: 2, height: 1, colorType: 6, rows: [[255, 0, 0, 255, 0, 255, 0, 0]] });
const RGBA_INVISIBLE = png({ width: 1, height: 1, colorType: 6, rows: [[255, 0, 0, 0]] });

try {
  verifySchemaMigrationBoundary();
  verifyPngDecodingAndPolicies();
  verifyProductionTaskRevalidatesEveryManifestAsset();
  verifyTechnicalFailureRouting();
  process.stdout.write(
    "Image asset alpha verification passed: v2 policy declarations, PNG pixel alpha, and Stage 2 hard gate enforced\n"
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function verifySchemaMigrationBoundary() {
  const legacy = parseAssetManifest({ assets: [{ id: "hero", runtimePath: "assets/art/hero.png" }] });
  assert.equal(legacy.migrationRequired, true);
  assert.equal(legacy.runtimeAssets[0].alphaPolicy, "optional");
  assert.equal(legacy.runtimeAssets[0].alphaPolicySource, "legacy_default_optional");
  assert.throws(
    () => validateManifestRuntimeAssetAlphaPolicies("unused", { assets: [] }),
    /必须迁移到 schemaVersion=2\.0\.0/
  );
  assert.throws(
    () => parseCurrentAssetManifestText(JSON.stringify({ assets: [{ runtimePath: "assets/art/hero.png" }] })),
    /schemaVersion=2\.0\.0/
  );
  assert.doesNotThrow(() => parseCurrentAssetManifestText(JSON.stringify({
    schemaVersion: "2.0.0",
    assets: [{ runtimePath: "assets/art/hero.png", alphaPolicy: "required" }]
  })));
  assert.throws(
    () => parseAssetManifest({ schemaVersion: "2.0.0", assets: [{ runtimePath: "assets/art/hero.png" }] }),
    /alphaPolicy.*必填/
  );
  assert.throws(
    () => parseAssetManifest({
      schemaVersion: "2.0.0",
      assets: [
        { runtimePath: "assets/art/hero.png", alphaPolicy: "required" },
        { runtimePath: "assets/art/hero.png", alphaPolicy: "opaque" }
      ]
    }),
    /runtimePath 重复/
  );
}

function verifyPngDecodingAndPolicies() {
  const mutable = inspectPngAlpha(RGBA_OPAQUE);
  mutable.minimumAlpha = 0;
  mutable.transparentPixels = 2;
  assert.throws(() => assertPngAlphaPolicy(inspectPngAlpha(RGBA_OPAQUE), "required"), /完全不透明/,
    "a caller cannot mutate cached measurements into acceptance");
  assert.doesNotThrow(() => assertPngAlphaPolicy(inspectPngAlpha(RGBA_ALPHA), "required"),
    "new bytes must be measured even for equal dimensions and the same default label");
  const rgb = inspectPngAlpha(RGB_OPAQUE, "rgb.png");
  assert.equal(rgb.alphaSource, "none");
  assert.equal(rgb.transparentPixels, 0);
  assert.doesNotThrow(() => assertPngAlphaPolicy(rgb, "opaque", "rgb.png"));
  assert.throws(() => assertPngAlphaPolicy(rgb, "required", "rgb.png"), /完全不透明/);

  const opaqueRgba = inspectPngAlpha(RGBA_OPAQUE, "opaque-rgba.png");
  assert.equal(opaqueRgba.alphaSource, "channel");
  assert.equal(opaqueRgba.transparentPixels, 0);
  assert.throws(() => assertPngAlphaPolicy(opaqueRgba, "required", "opaque-rgba.png"), /完全不透明/);

  const alpha = inspectPngAlpha(RGBA_ALPHA, "alpha.png");
  assert.equal(alpha.transparentPixels, 1);
  assert.equal(alpha.fullyTransparentPixels, 1);
  assert.equal(alpha.transparentRatio, 0.5);
  assert.equal(alpha.transparentEdgeRatio, 0.5);
  assert.doesNotThrow(() => assertPngAlphaPolicy(alpha, "required", "alpha.png"));
  assert.throws(() => assertPngAlphaPolicy(alpha, "opaque", "alpha.png"), /alphaPolicy=opaque/);

  const invisible = inspectPngAlpha(RGBA_INVISIBLE, "invisible.png");
  assert.throws(() => assertPngAlphaPolicy(invisible, "required", "invisible.png"), /没有可见像素/);

  const indexed = png({
    width: 2,
    height: 1,
    colorType: 3,
    rows: [[0, 1]],
    palette: [255, 0, 0, 0, 255, 0],
    transparency: [255, 0]
  });
  const indexedReceipt = inspectPngAlpha(indexed, "indexed.png");
  assert.equal(indexedReceipt.alphaSource, "palette");
  assert.equal(indexedReceipt.transparentPixels, 1);

  const grayKey = png({
    width: 2,
    height: 1,
    colorType: 0,
    rows: [[0, 255]],
    transparency: [0, 0]
  });
  const grayReceipt = inspectPngAlpha(grayKey, "gray-key.png");
  assert.equal(grayReceipt.alphaSource, "color_key");
  assert.equal(grayReceipt.transparentPixels, 1);

  const interlaced16 = png({
    width: 1,
    height: 1,
    colorType: 6,
    bitDepth: 16,
    interlace: 1,
    rows: [[255, 255, 0, 0, 0, 0, 128, 0]]
  });
  const interlacedReceipt = inspectPngAlpha(interlaced16, "interlaced-16.png");
  assert.equal(interlacedReceipt.interlaced, true);
  assert.equal(interlacedReceipt.semiTransparentPixels, 1);

  const corrupt = Buffer.from(RGBA_ALPHA);
  corrupt[corrupt.indexOf(Buffer.from("IDAT")) + 4] ^= 1;
  assert.throws(() => inspectPngAlpha(corrupt, "corrupt.png"), /CRC/);
}

function verifyProductionTaskRevalidatesEveryManifestAsset() {
  const kernel = createStudioKernel("alpha_task_gate", "Alpha gate", "producer", "alpha hard gate");
  const taskId = "task_stage_2_asset_pipeline";
  addTask(kernel, taskId);
  materialize(kernel, {
    artifactId: "artifact_asset_contact_sheet",
    taskId,
    path: "agents/art/processed-assets/first-playable-contact-sheet.png",
    content: RGB_OPAQUE,
    metadata: {
      toolName: "generate_raster_asset",
      toolExecutedAt: new Date().toISOString(),
      mediaRole: "asset_contact_sheet",
      ...providerMetadata("contact")
    }
  });
  const heroPath = "assets/art/first-playable/hero.png";
  materialize(kernel, {
    artifactId: "artifact_alpha_hero",
    taskId,
    path: heroPath,
    content: RGB_OPAQUE,
    metadata: {
      toolName: "generate_raster_asset",
      toolExecutedAt: new Date().toISOString(),
      ...providerMetadata("hero-rgb")
    }
  });
  materializeManifest(kernel, taskId, heroPath, "opaque", 1);
  assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), true, "legal RGB opaque must pass");

  materializeManifest(kernel, taskId, heroPath, "required", 2);
  assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), false, "required RGB must fail");

  materialize(kernel, {
    artifactId: "artifact_alpha_hero",
    taskId,
    path: heroPath,
    content: RGBA_OPAQUE,
    version: 2,
    metadata: {
      toolName: "generate_raster_asset",
      toolExecutedAt: new Date().toISOString(),
      ...providerMetadata("hero-rgba-opaque")
    }
  });
  materializeManifest(kernel, taskId, heroPath, "required", 3);
  assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), false, "required fully opaque RGBA must fail");

  materialize(kernel, {
    artifactId: "artifact_alpha_hero",
    taskId,
    path: heroPath,
    content: RGBA_ALPHA,
    version: 3,
    metadata: {
      toolName: "generate_raster_asset",
      toolExecutedAt: new Date().toISOString(),
      ...providerMetadata("hero-rgba-alpha")
    }
  });
  materializeManifest(kernel, taskId, heroPath, "required", 4);
  assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), true, "required transparent RGBA must pass");

  materializeManifest(kernel, taskId, heroPath, undefined, 5, true);
  assert.equal(taskOutputsVerified(kernel, kernel.findTask(taskId)), false, "legacy manifest must fail production gate");
}

function verifyTechnicalFailureRouting() {
  const kernel = createStudioKernel("asset_feedback", "Feedback", "producer_test", "repair assets");
  const taskId = "task_stage_2_asset_pipeline";
  addTask(kernel, taskId);
  const heroPath = "assets/art/first-playable/hero.png";
  const bytesPath = join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId, heroPath);
  materialize(kernel, { artifactId: "hero", taskId, path: heroPath, content: RGBA_OPAQUE,
    metadata: { toolName: "generate_raster_asset", toolExecutedAt: new Date().toISOString(), ...providerMetadata("feedback") } });
  materializeManifest(kernel, taskId, heroPath, "required", 1);
  kernel.updateTask(taskId, { status: "blocked", blockers: ["Agent Loop：连续两轮没有产生工具结果，已停止自动重试。"] });
  const ledger = structuredClone(kernel.listArtifactLedger());
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), ["asset_production"]);
  assert.equal(kernel.findTask(taskId).status, "doing");
  assert.match(kernel.findTask(taskId).description, /hero\.png.*sha256:/);
  assert.match(kernel.findTask(taskId).description, /完全不透明/);
  assert.equal(kernel.listArtifacts().find((a) => a.artifactId === "artifact_asset_manifest_draft").status, "change_requested");
  assert.deepEqual(kernel.listArtifactLedger(), ledger, "feedback cannot forge or destroy byte receipts");
  const count = kernel.listMessages().length;
  kernel.updateTask(taskId, { status: "blocked", blockers: ["Agent Loop：retry exhausted"] });
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), []);
  assert.equal(kernel.findTask(taskId).status, "blocked", "same failure must not reset retries forever");
  assert.equal(kernel.listMessages().length, count);
  materializeManifest(kernel, taskId, heroPath, "required", 2);
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), [], "a cosmetic manifest version bump is not new evidence");
  assert.equal(kernel.listArtifacts().find((a) => a.artifactId === "artifact_asset_manifest_draft").status, "change_requested");
  writeFileSync(bytesPath, RGBA_ALPHA);
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), []);
  assert.doesNotMatch(kernel.findTask(taskId).description, /ASSET_TECHNICAL_REPAIR/);
  assert.equal(kernel.listArtifacts().find((a) => a.artifactId === "artifact_asset_manifest_draft").status, "change_requested",
    "technical recovery alone must not publish the manifest or approve a gate");
  writeFileSync(bytesPath, RGBA_OPAQUE);
  kernel.updateTask(taskId, { status: "blocked", blockers: ["人工：等待素材授权", "Agent Loop：retry exhausted"] });
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), []);
  assert.deepEqual(kernel.findTask(taskId).blockers, ["人工：等待素材授权"]);
  assert.equal(kernel.findTask(taskId).status, "blocked", "manual blockers must survive automatic repair");
  kernel.updateTask(taskId, { status: "cancelled" });
  const cancelled = structuredClone(kernel.toSnapshot());
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), []);
  assert.deepEqual(kernel.toSnapshot(), cancelled, "cancelled work must not reopen");
  kernel.updateTask(taskId, { status: "blocked", blockers: ["Agent Loop：等待制作人：全部完成，等待阶段门禁验收"] });
  assert.deepEqual(reconcileAssetTechnicalFailures(kernel), ["asset_production"],
    "new actionable work clears an agent's stale stage-approval wait, not the actual gate");
  assert.equal(kernel.findTask(taskId).status, "doing");
}

function addTask(kernel, taskId) {
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    title: taskId,
    description: "alpha validation fixture",
    ownerAgentId: "asset_production",
    participantAgentIds: [],
    status: "review",
    priority: 1,
    sortOrder: 1,
    progressPercent: 90,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts: ["artifact_asset_manifest_draft", "artifact_asset_contact_sheet"],
    acceptanceCriteria: ["deterministic alpha evidence"],
    createdAt: now,
    updatedAt: now
  });
}

function materializeManifest(kernel, taskId, runtimePath, alphaPolicy, version, legacy = false) {
  const asset = { id: "hero", runtimePath, ...(alphaPolicy ? { alphaPolicy } : {}) };
  materialize(kernel, {
    artifactId: "artifact_asset_manifest_draft",
    taskId,
    type: "asset_manifest",
    path: "agents/art/asset-manifest.json",
    content: Buffer.from(`${JSON.stringify({ ...(legacy ? {} : { schemaVersion: "2.0.0" }), assets: [asset] }, null, 2)}\n`),
    version,
    metadata: { toolName: "write_asset_manifest", toolExecutedAt: new Date().toISOString() }
  });
}

function materialize(kernel, {
  artifactId,
  taskId,
  type = "asset",
  path,
  content,
  version = 1,
  metadata
}) {
  const now = new Date().toISOString();
  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, kernel.project.projectId, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  const existing = kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type,
    path,
    ownerAgentId: "asset_production",
    stageId: kernel.project.currentStage,
    status: "submitted",
    version,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: { ...(existing?.metadata ?? {}), ...metadata },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
  const stats = statSync(absolutePath);
  const genuineGenerate = metadata.toolName === "generate_raster_asset";
  const hash = createHash("sha256").update(content).digest("hex");
  const materialization = kernel.recordArtifactMaterialization(artifact.artifactId, {
    path,
    hash,
    sizeBytes: stats.size,
    materializedAt: stats.mtime.toISOString(),
    ...(genuineGenerate
      ? {
          operationMetadata: mediaGenerationOperationMetadata({
            hash,
            sizeBytes: stats.size,
            provider: metadata.mediaProvider,
            model: metadata.mediaModel,
            requestId: metadata.mediaRequestId,
            promptHash: metadata.mediaPromptHash
          })
        }
      : {})
  });
  if (genuineGenerate) {
    kernel.upsertArtifact({
      ...artifact,
      metadata: bindMediaGenerationArtifactMetadata(
        artifact.metadata,
        materialization.sourceOperationId,
        { hash, sizeBytes: stats.size }
      ),
      updatedAt: stats.mtime.toISOString()
    });
  }
}

function providerMetadata(suffix) {
  return {
    generatedBy: "dashscope_multimodal_art_provider",
    mediaProvider: "dashscope",
    mediaModel: "wan2.7-image-pro",
    mediaRequestId: `request-${suffix}`,
    mediaPromptHash: createHash("sha256").update(`prompt-${suffix}`).digest("hex"),
    mediaMime: "image/png",
    mediaWidth: 2,
    mediaHeight: 1
  };
}

function png({ width, height, colorType, bitDepth = 8, interlace = 0, rows, palette, transparency }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const chunks = [chunk("IHDR", ihdr)];
  if (palette) chunks.push(chunk("PLTE", Buffer.from(palette)));
  if (transparency) chunks.push(chunk("tRNS", Buffer.from(transparency)));
  chunks.push(chunk("IDAT", deflateSync(Buffer.concat(rows.map((row) => Buffer.from([0, ...row]))))));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
