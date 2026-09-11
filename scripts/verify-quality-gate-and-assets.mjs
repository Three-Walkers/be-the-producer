import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-quality-gate-assets-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");

const {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  getQualityReviewArtifactContracts
} = await import("../packages/agent-runtime/dist/index.js");
const {
  artifactReadyForConsumption,
  taskOutputsVerified
} = await import("../apps/api/dist/taskOutputEvidence.js");
const { apiGateEvidencePolicy } = await import("../apps/api/dist/gateEvidencePolicy.js");
const {
  buildCurrentVisionReviewAuthoritativeContext,
  qualityReviewReadyForGate
} = await import("../apps/api/dist/qualityReviewArtifacts.js");
const {
  hashArtVisionRequestSemantics,
  hashArtVisionSemanticResult
} = await import("../apps/api/dist/multimodalArtProvider.js");
const {
  bindMediaGenerationArtifactMetadata,
  mediaGenerationOperationMetadata
} = await import("../apps/api/dist/mediaArtifactEvidence.js");
const {
  assertPngAlphaPolicy,
  inspectPngAlpha,
  validateManifestRuntimeAssetAlphaPolicies
} = await import("../apps/api/dist/imageAssetValidation.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const RGB_OPAQUE_PNG = makePng(2, 2, 2, [
  255, 0, 0, 0, 255, 0,
  0, 0, 255, 255, 255, 255
]);
const RGBA_OPAQUE_PNG = makePng(2, 2, 6, [
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255
]);
const RGBA_TRANSPARENT_PNG = makePng(2, 2, 6, [
  255, 0, 0, 255, 0, 255, 0, 0,
  0, 0, 255, 128, 255, 255, 255, 255
]);
const RGBA_INVISIBLE_PNG = makePng(2, 2, 6, [
  255, 0, 0, 0, 0, 255, 0, 0,
  0, 0, 255, 0, 255, 255, 255, 0
]);

try {
  verifyPassingQualityReview();
  verifyChangeRequestCompletesTaskButFailsGate();
  verifyStaleTargetAndIdentityFailClosed();
  verifyPngAlphaInspection();
  verifyAssetProductionRequiresRealGeneratedPng();
  process.stdout.write(
    "Quality gate/assets passed: strict current reviews, change feedback semantics, and real generated PNG consumption enforced\n"
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function verifyPassingQualityReview() {
  const fixture = createVisualReviewFixture("quality_review_pass", "pass");
  const readiness = qualityReviewReadyForGate(fixture.kernel, fixture.reviewArtifactId, false);
  assert.equal(artifactReadyForConsumption(fixture.kernel, fixture.reviewArtifactId), true, readiness.reason);
  assert.equal(taskOutputsVerified(fixture.kernel, fixture.reviewTask), true);
  assert.doesNotThrow(() => apiGateEvidencePolicy.assertGateEvidence(fixture.kernel, gateRequirement(fixture.reviewArtifactId)));

  const traceMismatchArtifact = fixture.kernel.listArtifacts().find((artifact) => artifact.artifactId === fixture.reviewArtifactId);
  fixture.kernel.upsertArtifact({
    ...traceMismatchArtifact,
    metadata: { ...traceMismatchArtifact.metadata, reviewModel: "different-server-model" },
    updatedAt: new Date().toISOString()
  });
  assert.equal(artifactReadyForConsumption(fixture.kernel, fixture.reviewArtifactId), false, "server model trace mismatch must fail closed");
}

function verifyChangeRequestCompletesTaskButFailsGate() {
  const fixture = createVisualReviewFixture("quality_review_change", "change_requested");
  assert.equal(taskOutputsVerified(fixture.kernel, fixture.reviewTask), true, "grounded change request is completed reviewer work");
  assert.throws(
    () => apiGateEvidencePolicy.assertGateEvidence(fixture.kernel, gateRequirement(fixture.reviewArtifactId)),
    /verdict=pass|verdict=change_requested/
  );

  for (const target of fixture.review.targets) {
    const artifact = fixture.kernel.listArtifacts().find((candidate) => candidate.artifactId === target.artifactId);
    fixture.kernel.upsertArtifact({
      ...artifact,
      status: "change_requested",
      metadata: {
        ...artifact.metadata,
        qualityChangeReviewId: fixture.review.reviewId,
        qualityChangeReviewArtifactId: fixture.reviewArtifactId
      },
      updatedAt: new Date().toISOString()
    });
  }
  assert.equal(
    taskOutputsVerified(fixture.kernel, fixture.reviewTask),
    true,
    "feedback status applied by this exact review must not make the reviewer task incomplete"
  );
  assert.throws(() => apiGateEvidencePolicy.assertGateEvidence(fixture.kernel, gateRequirement(fixture.reviewArtifactId)));
}

function verifyStaleTargetAndIdentityFailClosed() {
  const staleResponse = createVisualReviewFixture("quality_review_stale_response", "pass");
  const staleResponseArtifact = staleResponse.kernel.listArtifacts().find(
    (artifact) => artifact.artifactId === staleResponse.reviewArtifactId
  );
  staleResponse.kernel.upsertArtifact({
    ...staleResponseArtifact,
    metadata: {
      ...staleResponseArtifact.metadata,
      visionInspectionResponseHash: "f".repeat(64)
    },
    updatedAt: new Date().toISOString()
  });
  assert.equal(
    artifactReadyForConsumption(staleResponse.kernel, staleResponse.reviewArtifactId),
    false,
    "a stale or substituted vision responseHash must fail closed"
  );

  const stale = createVisualReviewFixture("quality_review_stale", "pass");
  materialize(stale.kernel, {
    artifactId: "artifact_art_direction_board",
    taskId: "task_stage_1_art_direction",
    type: "asset",
    path: "agents/art/art-direction-board.png",
    ownerAgentId: "art_director",
    content: Buffer.concat([PNG, Buffer.from("revised")]),
    version: 2,
    metadata: { toolName: "generate_raster_asset", toolExecutedAt: new Date().toISOString() }
  });
  assert.equal(artifactReadyForConsumption(stale.kernel, stale.reviewArtifactId), false, "review target revision/hash changes must stale receipt");
  assert.throws(() => apiGateEvidencePolicy.assertGateEvidence(stale.kernel, gateRequirement(stale.reviewArtifactId)));

  const wrongIdentity = createVisualReviewFixture("quality_review_identity", "pass");
  const snapshot = structuredClone(wrongIdentity.kernel.toSnapshot());
  const reviewArtifact = snapshot.artifacts.find((artifact) => artifact.artifactId === wrongIdentity.reviewArtifactId);
  reviewArtifact.path = "agents/review/art/wrong.quality-review.json";
  const restored = createStudioKernelFromSnapshot(snapshot);
  assert.equal(artifactReadyForConsumption(restored, wrongIdentity.reviewArtifactId), false, "canonical review identity mismatch must fail");
  assert.throws(() => apiGateEvidencePolicy.assertGateEvidence(restored, gateRequirement(wrongIdentity.reviewArtifactId)));
}

function verifyAssetProductionRequiresRealGeneratedPng() {
  const kernel = createStudioKernel("quality_assets", "Quality assets", "producer_test", "real generated art");
  const taskId = "task_stage_2_asset_pipeline";
  addTask(kernel, {
    taskId,
    ownerAgentId: "asset_production",
    inputArtifacts: [],
    outputArtifacts: ["artifact_asset_manifest_draft", "artifact_asset_contact_sheet"]
  });
  materialize(kernel, {
    artifactId: "artifact_asset_contact_sheet",
    taskId,
    type: "asset",
    path: "agents/art/processed-assets/first-playable-contact-sheet.png",
    ownerAgentId: "asset_production",
    content: PNG,
    metadata: {
      toolName: "generate_raster_asset",
      toolExecutedAt: new Date().toISOString(),
      mediaRole: "asset_contact_sheet",
      ...providerMetadata("contact")
    }
  });
  materializeManifest(kernel, taskId, { schemaVersion: "2.0.0", assets: [] });
  const task = kernel.findTask(taskId);
  assert.equal(taskOutputsVerified(kernel, task), false, "manifest plus contact sheet only must not complete asset production");

  const svgPath = "agents/art/processed-assets/vector-source.svg";
  const rasterPath = "agents/art/processed-assets/vector-source.png";
  materialize(kernel, {
    artifactId: "artifact_vector_source",
    taskId,
    type: "asset",
    path: svgPath,
    ownerAgentId: "asset_production",
    content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'),
    metadata: { toolName: "generate_image", toolExecutedAt: new Date().toISOString() }
  });
  materialize(kernel, {
    artifactId: "artifact_vector_raster",
    taskId,
    type: "asset",
    path: rasterPath,
    ownerAgentId: "asset_production",
    content: PNG,
    metadata: {
      toolName: "render_svg_to_png",
      toolExecutedAt: new Date().toISOString(),
      sourcePath: svgPath,
      harnessToolName: "generate_raster_asset",
      bridgeOperationId: "forged-vector-provider-receipt",
      bridgeOperationType: "image_generation",
      ...providerMetadata("forged-vector")
    }
  });
  materializeManifest(kernel, taskId, {
    schemaVersion: "2.0.0",
    assets: [{ id: "vector", runtimePath: rasterPath, alphaPolicy: "optional" }]
  });
  assert.equal(taskOutputsVerified(kernel, task), false, "SVG rasterization must not masquerade as provider-generated art");

  materialize(kernel, {
    artifactId: "artifact_vector_raster",
    taskId,
    type: "asset",
    path: rasterPath,
    ownerAgentId: "asset_production",
    content: RGB_OPAQUE_PNG,
    version: 2,
    metadata: {
      toolName: "render_svg_to_png",
      toolExecutedAt: new Date().toISOString(),
      sourcePath: svgPath,
      harnessToolName: undefined,
      bridgeOperationId: undefined,
      bridgeOperationType: undefined,
      mediaProvider: undefined,
      mediaModel: undefined,
      mediaRequestId: undefined,
      mediaPromptHash: undefined,
      mediaMime: undefined,
      mediaWidth: undefined,
      mediaHeight: undefined
    }
  });

  const generatedPath = "agents/art/processed-assets/hero-generated.png";
  materialize(kernel, {
    artifactId: "artifact_hero_generated",
    taskId,
    type: "asset",
    path: generatedPath,
    ownerAgentId: "asset_production",
    content: PNG,
    metadata: {
      toolExecutedAt: new Date().toISOString(),
      harnessToolName: "generate_raster_asset",
      bridgeOperationId: "request-hero",
      bridgeOperationType: "image_generation",
      ...providerMetadata("hero")
    }
  });
  materializeManifest(kernel, taskId, {
    schemaVersion: "2.0.0",
    assets: [
      { id: "vector", runtimePath: rasterPath, alphaPolicy: "optional" },
      { id: "hero", runtimePath: generatedPath, alphaPolicy: "opaque" }
    ]
  });
  assert.equal(taskOutputsVerified(kernel, task), true, "a valid RGB PNG declared opaque should pass production evidence");
  delete kernel.listArtifacts().find((a) => a.artifactId === "artifact_asset_contact_sheet").metadata.mediaRole;
  assert.equal(taskOutputsVerified(kernel, task), true, "canonical contact-sheet identity cannot depend on sanitized mutable mediaRole");

  materialize(kernel, {
    artifactId: "artifact_hero_generated",
    taskId,
    type: "asset",
    path: generatedPath,
    ownerAgentId: "asset_production",
    content: RGBA_OPAQUE_PNG,
    version: 2,
    metadata: {
      toolExecutedAt: new Date().toISOString(),
      harnessToolName: "generate_raster_asset",
      bridgeOperationId: "request-hero-opaque-rgba",
      bridgeOperationType: "image_generation",
      ...providerMetadata("hero-opaque-rgba")
    }
  });
  materializeManifest(kernel, taskId, {
    schemaVersion: "2.0.0",
    assets: [
      { id: "vector", runtimePath: rasterPath, alphaPolicy: "optional" },
      { id: "hero", runtimePath: generatedPath, alphaPolicy: "required" }
    ]
  });
  assert.equal(taskOutputsVerified(kernel, task), false, "required must reject a fully opaque RGBA PNG");

  materialize(kernel, {
    artifactId: "artifact_hero_generated",
    taskId,
    type: "asset",
    path: generatedPath,
    ownerAgentId: "asset_production",
    content: RGBA_TRANSPARENT_PNG,
    version: 3,
    metadata: {
      toolExecutedAt: new Date().toISOString(),
      harnessToolName: "generate_raster_asset",
      bridgeOperationId: "request-hero-transparent",
      bridgeOperationType: "image_generation",
      ...providerMetadata("hero-transparent")
    }
  });
  materializeManifest(kernel, taskId, {
    schemaVersion: "2.0.0",
    assets: [
      { id: "vector", runtimePath: rasterPath, alphaPolicy: "optional" },
      { id: "hero", runtimePath: generatedPath, alphaPolicy: "required" }
    ]
  });
  assert.equal(taskOutputsVerified(kernel, task), true, "required should pass a current PNG with visible and transparent pixels");

  materializeManifest(kernel, taskId, {
    assets: [
      { id: "vector", runtimePath: rasterPath },
      { id: "hero", runtimePath: generatedPath }
    ]
  });
  assert.equal(taskOutputsVerified(kernel, task), false, "legacy manifests remain readable but cannot pass Stage 2 evidence");

  materializeManifest(kernel, taskId, {
    schemaVersion: "2.0.0",
    assets: [
      { id: "vector", runtimePath: rasterPath, alphaPolicy: "optional" },
      { id: "hero", runtimePath: generatedPath }
    ]
  });
  assert.equal(taskOutputsVerified(kernel, task), false, "v2 must explicitly declare alphaPolicy for every runtime asset");
}

function verifyPngAlphaInspection() {
  const rgb = inspectPngAlpha(RGB_OPAQUE_PNG, "rgb-opaque.png");
  assert.equal(rgb.alphaSource, "none");
  assert.equal(rgb.transparentPixels, 0);
  assert.doesNotThrow(() => assertPngAlphaPolicy(rgb, "opaque", "rgb-opaque.png"));
  assert.throws(() => assertPngAlphaPolicy(rgb, "required", "rgb-opaque.png"), /所有像素均完全不透明/);

  const opaqueRgba = inspectPngAlpha(RGBA_OPAQUE_PNG, "rgba-opaque.png");
  assert.equal(opaqueRgba.alphaSource, "channel");
  assert.equal(opaqueRgba.transparentPixels, 0);
  assert.throws(() => assertPngAlphaPolicy(opaqueRgba, "required", "rgba-opaque.png"), /所有像素均完全不透明/);

  const transparent = inspectPngAlpha(RGBA_TRANSPARENT_PNG, "rgba-transparent.png");
  assert.equal(transparent.transparentPixels, 2);
  assert.equal(transparent.fullyTransparentPixels, 1);
  assert.equal(transparent.semiTransparentPixels, 1);
  assert.equal(transparent.transparentRatio, 0.5);
  assert.equal(transparent.transparentEdgeRatio, 0.5);
  assert.doesNotThrow(() => assertPngAlphaPolicy(transparent, "required", "rgba-transparent.png"));
  assert.throws(() => assertPngAlphaPolicy(transparent, "opaque", "rgba-transparent.png"), /alphaPolicy=opaque/);

  const invisible = inspectPngAlpha(RGBA_INVISIBLE_PNG, "rgba-invisible.png");
  assert.throws(() => assertPngAlphaPolicy(invisible, "required", "rgba-invisible.png"), /没有可见像素/);

  const corrupt = Buffer.from(RGBA_TRANSPARENT_PNG);
  const idatDataOffset = corrupt.indexOf(Buffer.from("IDAT")) + 4;
  corrupt[idatDataOffset] ^= 1;
  assert.throws(() => inspectPngAlpha(corrupt, "corrupt.png"), /CRC/);

  assert.throws(
    () => validateManifestRuntimeAssetAlphaPolicies("not-used", { assets: [] }),
    /必须迁移到 schemaVersion=2\.0\.0/
  );
}

function createVisualReviewFixture(projectId, verdict) {
  const kernel = createStudioKernel(projectId, projectId, "producer_test", "quality review fixture");
  addTask(kernel, {
    taskId: "task_stage_1_art_direction",
    ownerAgentId: "art_director",
    inputArtifacts: [],
    outputArtifacts: ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"]
  });
  addTask(kernel, {
    taskId: "task_stage_1_visual_quality_review",
    ownerAgentId: "visual_quality_reviewer",
    inputArtifacts: ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"],
    outputArtifacts: ["artifact_stage_1_visual_quality_review"]
  });
  materialize(kernel, {
    artifactId: "artifact_art_bible_baseline_draft",
    taskId: "task_stage_1_art_direction",
    type: "art_bible",
    path: "agents/art/art-bible.md",
    ownerAgentId: "art_director",
    content: Buffer.from("# Art Bible\n\nReadable silhouettes and a restrained palette.\n"),
    metadata: { toolName: "write_artifact", toolExecutedAt: new Date().toISOString() }
  });
  materialize(kernel, {
    artifactId: "artifact_art_direction_board",
    taskId: "task_stage_1_art_direction",
    type: "asset",
    path: "agents/art/art-direction-board.png",
    ownerAgentId: "art_director",
    content: PNG,
    metadata: {
      toolName: "generate_raster_asset",
      toolExecutedAt: new Date().toISOString(),
      ...providerMetadata("art-direction-board")
    }
  });
  const boardLedger = kernel.listArtifactLedger().find(
    (entry) => entry.artifactId === "artifact_art_direction_board"
  );
  assert.ok(boardLedger?.hash && boardLedger.sizeBytes !== undefined);

  const reviewArtifactId = "artifact_stage_1_visual_quality_review";
  const reviewTask = kernel.findTask("task_stage_1_visual_quality_review");
  const review = qualityReviewFixture(kernel, verdict);
  const contract = getQualityReviewArtifactContracts().find(
    (candidate) => candidate.artifactId === reviewArtifactId
  );
  assert.ok(contract);
  const authoritativeContext = buildCurrentVisionReviewAuthoritativeContext(kernel, contract);
  const requestSemanticHash = hashArtVisionRequestSemantics(contract.rubric, authoritativeContext.hash);
  const visionResult = {
    schemaVersion: "1.0.0",
    rubricId: review.rubric.rubricId,
    rubricVersion: review.rubric.version,
    passThreshold: review.rubric.passThreshold,
    criteria: structuredClone(review.criteria),
    scoreTotal: review.scoreTotal,
    verdict: review.verdict
  };
  const visionResponseHash = createHash("sha256")
    .update(`vision-response:${projectId}:${verdict}`)
    .digest("hex");
  const visionReceipt = {
    invocationId: review.modelTrace.invocationId,
    operationId: "vision-request-1",
    providerId: "dashscope",
    model: "qwen3.8-max",
    paths: ["agents/art/art-direction-board.png"],
    evidence: [{
      path: "agents/art/art-direction-board.png",
      hash: boardLedger.hash,
      sizeBytes: boardLedger.sizeBytes
    }],
    responseHash: visionResponseHash,
    authoritativeContextEvidence: authoritativeContext.evidence,
    authoritativeContextHash: authoritativeContext.hash,
    requestSemanticHash,
    result: visionResult
  };
  materialize(kernel, {
    artifactId: reviewArtifactId,
    taskId: reviewTask.taskId,
    type: "quality_review",
    path: "agents/review/art/stage-1.quality-review.json",
    ownerAgentId: "visual_quality_reviewer",
    content: Buffer.from(`${JSON.stringify(review, null, 2)}\n`),
    metadata: {
      toolExecutedAt: new Date().toISOString(),
      generatedBy: "claude_cli_harness",
      nativeHarnessManaged: true,
      harnessToolName: "write_artifact",
      bridgeOperationId: "vision-request-1",
      bridgeOperationType: "quality_review_with_vision",
      reviewProviderId: review.modelTrace.providerId,
      reviewModel: review.modelTrace.model,
      reviewInvocationId: review.modelTrace.invocationId,
      visionInspectionOperationId: "vision-request-1",
      visionInspectionProvider: "dashscope",
      visionInspectionModel: "qwen3.8-max",
      visionInspectionInvocationId: review.modelTrace.invocationId,
      visionInspectionResponseHash: visionResponseHash,
      visionInspectionSemanticHash: hashArtVisionSemanticResult(visionResult),
      visionAuthoritativeContextEvidence: authoritativeContext.evidence,
      visionAuthoritativeContextHash: authoritativeContext.hash,
      visionRequestSemanticHash: requestSemanticHash,
      visionInspectionSemanticResult: visionResult,
      visionInspectionSemanticReceipts: [visionReceipt],
      visionInspectedPaths: ["agents/art/art-direction-board.png"],
      visionInspectedEvidence: [{
        path: "agents/art/art-direction-board.png",
        hash: boardLedger.hash,
        sizeBytes: boardLedger.sizeBytes
      }]
    }
  });
  return { kernel, reviewTask, reviewArtifactId, review };
}

function qualityReviewFixture(kernel, verdict) {
  const contract = getQualityReviewArtifactContracts().find(
    (candidate) => candidate.artifactId === "artifact_stage_1_visual_quality_review"
  );
  assert.ok(contract, "Stage 1 visual quality contract must be registered");
  const targets = ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"].map((artifactId) => {
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
    return {
      artifactId,
      version: artifact.version,
      path: artifact.path,
      ledgerHash: ledger.hash,
      sizeBytes: ledger.sizeBytes
    };
  });
  const changeRequested = verdict === "change_requested";
  const criteria = contract.rubric.criteria.map((criterion, index) => {
    const requestsChange = changeRequested && index === 0;
    return {
      ...criterion,
      score: requestsChange ? 50 : 90,
      status: requestsChange ? "change_requested" : "pass",
      findings: [{
        issueCode: requestsChange ? "art.low_contrast" : `art.${criterion.criterionId}_observed`,
        severity: requestsChange ? "major" : "note",
        summary: requestsChange
          ? "Foreground and background values are too close."
          : `Observable evidence supports ${criterion.criterionId}.`,
        evidenceRefs: ["agents/art/art-direction-board.png#pixel:foreground-silhouette"]
      }]
    };
  });
  const scoreTotal = criteria.reduce((total, criterion) => total + criterion.score * criterion.weight / 100, 0);
  return {
    schemaVersion: "1.0.0",
    kind: "artifact_quality_review",
    reviewId: `review.art_direction.${changeRequested ? "change" : "pass"}`,
    domain: "art_direction",
    reviewerAgentId: "visual_quality_reviewer",
    targets,
    rubric: {
      rubricId: contract.rubric.rubricId,
      version: contract.rubric.version,
      passThreshold: contract.rubric.passThreshold
    },
    criteria,
    scoreTotal,
    verdict,
    requiredChanges: changeRequested
      ? [{
          issueCode: "art.low_contrast",
          summary: "Increase foreground contrast.",
          acceptanceCriteria: ["Primary silhouette remains legible at mobile size."],
          evidenceRefs: ["agents/art/art-direction-board.png#pixel:foreground-silhouette"]
        }]
      : [],
    risks: [],
    blockingIssueCodes: [],
    modelTrace: {
      providerId: "dashscope",
      model: "qwen3.8-max",
      invocationId: `invocation-${kernel.project.projectId}`,
      promptVersion: "1.0.0"
    },
    reviewedAt: "2026-08-15T12:00:00.000Z"
  };
}

function materializeManifest(kernel, taskId, value) {
  const existing = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_asset_manifest_draft");
  materialize(kernel, {
    artifactId: "artifact_asset_manifest_draft",
    taskId,
    type: "asset_manifest",
    path: "agents/art/asset-manifest.json",
    ownerAgentId: "asset_production",
    content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    version: (existing?.version ?? 0) + 1,
    metadata: { ...(existing?.metadata ?? {}), toolName: "write_asset_manifest", toolExecutedAt: new Date().toISOString() }
  });
}

function materialize(kernel, { artifactId, taskId, type, path, ownerAgentId, content, version = 1, metadata }) {
  const now = new Date().toISOString();
  const absolutePath = workspacePath(kernel.project.projectId, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  const existing = kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type,
    path,
    ownerAgentId,
    stageId: kernel.project.currentStage,
    status: "submitted",
    version,
    sourceTaskId: taskId,
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: { ...(existing?.metadata ?? {}), ...metadata },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
  const stats = statSync(absolutePath);
  const genuineGenerate =
    metadata.toolName === "generate_raster_asset" ||
    (metadata.harnessToolName === "generate_raster_asset" &&
      (metadata.toolName === undefined || metadata.toolName === "generate_raster_asset") &&
      metadata.bridgeOperationType === "image_generation");
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
  if (!genuineGenerate) return artifact;
  return kernel.upsertArtifact({
    ...artifact,
    metadata: bindMediaGenerationArtifactMetadata(
      artifact.metadata,
      materialization.sourceOperationId,
      { hash, sizeBytes: stats.size }
    ),
    updatedAt: stats.mtime.toISOString()
  });
}

function addTask(kernel, { taskId, ownerAgentId, inputArtifacts, outputArtifacts }) {
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom(ownerAgentId.includes("visual") || ownerAgentId.includes("art") || ownerAgentId === "asset_production" ? "art-room" : "studio-main").roomId,
    taskLevel: "task",
    title: taskId,
    description: "quality evidence fixture",
    ownerAgentId,
    participantAgentIds: [],
    status: "review",
    priority: 1,
    sortOrder: 1,
    progressPercent: 90,
    blockers: [],
    inputArtifacts,
    outputArtifacts,
    acceptanceCriteria: ["current quality evidence"],
    createdAt: now,
    updatedAt: now
  });
}

function providerMetadata(suffix) {
  return {
    generatedBy: "dashscope_multimodal_art_provider",
    mediaProvider: "dashscope",
    mediaModel: "wan2.7-image-pro",
    mediaRequestId: `request-${suffix}`,
    mediaPromptHash: createHash("sha256").update(`prompt-${suffix}`).digest("hex"),
    mediaMime: "image/png",
    mediaWidth: 1024,
    mediaHeight: 1024
  };
}

function gateRequirement(reviewArtifactId) {
  return {
    gateActionId: "stage1",
    phase: "review",
    requiredArtifactIds: [reviewArtifactId]
  };
}

function workspacePath(projectId, path) {
  return join(process.env.STUDIO_WORKSPACE_ROOT, projectId, path);
}

function makePng(width, height, colorType, samples) {
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  assert.ok(channels > 0, "test PNG encoder supports RGB/RGBA only");
  assert.equal(samples.length, width * height * channels);
  const scanlines = [];
  for (let y = 0; y < height; y += 1) {
    const start = y * width * channels;
    scanlines.push(Buffer.from([0]), Buffer.from(samples.slice(start, start + width * channels)));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function testCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
