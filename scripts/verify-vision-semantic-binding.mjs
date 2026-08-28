import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-vision-semantic-binding-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_SECRET_ROOT = join(tempRoot, "secrets");

const { createStudioKernel, getQualityReviewArtifactContracts } = await import("../packages/agent-runtime/dist/index.js");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { modelSettingsStore } = await import("../apps/api/dist/modelSettings.js");
const { writeToolArtifactBinaryContent, writeToolArtifactContent } = await import("../apps/api/dist/workspaceWriter.js");
const {
  assertVisionSemanticReceiptAuthoritativeContextCurrent,
  buildCurrentVisionReviewAuthoritativeContext
} = await import("../apps/api/dist/qualityReviewArtifacts.js");
const { hashArtVisionRequestSemantics } = await import("../apps/api/dist/multimodalArtProvider.js");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

try {
  const projectId = "vision_semantic_direct";
  const kernel = createStudioKernel(projectId, "Vision Semantic Direct", "producer_test", "fail-closed review binding");
  const contract = getQualityReviewArtifactContracts().find(
    (candidate) => candidate.artifactId === "artifact_stage_1_visual_quality_review"
  );
  assert.ok(contract);
  addTask(kernel, "task_stage_1_art_direction", "art_director", [], [
    "artifact_art_bible_baseline_draft",
    "artifact_art_direction_board"
  ]);
  addTask(kernel, contract.sourceTaskId, contract.ownerAgentId, [...contract.subjectArtifactIds], [contract.artifactId]);
  const artBible = materializeText(kernel, {
    artifactId: "artifact_art_bible_baseline_draft",
    taskId: "task_stage_1_art_direction",
    type: "art_bible",
    path: "agents/art/art-bible.md",
    ownerAgentId: "art_director",
    content: "# Art Bible\n\nReadable silhouettes.\n"
  });
  const board = materializeBinary(kernel, {
    artifactId: "artifact_art_direction_board",
    taskId: "task_stage_1_art_direction",
    type: "asset",
    path: "agents/art/art-direction-board.png",
    ownerAgentId: "art_director",
    content: PNG
  });
  kernel.upsertArtifact({
    artifactId: contract.artifactId,
    projectId,
    type: "quality_review",
    path: contract.path,
    ownerAgentId: contract.ownerAgentId,
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: contract.sourceTaskId,
    sourceDecisionIds: [],
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  modelSettingsStore.saveProvider("dashscope", {
    baseUrl: "https://dashscope.example/compatible-mode/v1",
    defaultModel: "qwen3.8-max",
    apiKey: "direct-test-only"
  });

  const majorSemantic = semanticResult(contract, board.path, {
    score: 35,
    status: "change_requested",
    severity: "major",
    verdict: "change_requested"
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    return new Response(JSON.stringify({
      id: "direct-vision-major",
      model: body.model ?? "qwen3.8-max",
      choices: [{ message: { content: JSON.stringify(majorSemantic) } }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const invocationId = "inv_direct_vision_semantic_001";
    const [inspection] = await executeAgentToolRequests(kernel, [toolMessage(kernel, invocationId, {
      tool: "inspect_visual_assets",
      arguments: {
        taskId: contract.sourceTaskId,
        paths: [board.path]
      }
    })]);
    assert.equal(inspection?.status, "completed", inspection?.error);
    assert.equal(inspection?.details?.result?.verdict, "change_requested");

    const forgedPass = qualityReview(kernel, contract, artBible, board, majorSemantic, {
      score: 100,
      status: "pass",
      severity: "note",
      verdict: "pass"
    });
    const [forgedWrite] = await executeAgentToolRequests(kernel, [toolMessage(kernel, invocationId, {
      tool: "write_artifact",
      taskId: contract.sourceTaskId,
      artifactId: contract.artifactId,
      artifactType: "quality_review",
      path: contract.path,
      content: JSON.stringify(forgedPass)
    })]);
    assert.equal(forgedWrite?.status, "failed");
    assert.match(forgedWrite?.error ?? "", /语义收据|score\/verdict|逐项等价/);

    const boundChangeRequest = qualityReview(kernel, contract, artBible, board, majorSemantic);
    const [legalWrite] = await executeAgentToolRequests(kernel, [toolMessage(kernel, invocationId, {
      tool: "write_artifact",
      taskId: contract.sourceTaskId,
      artifactId: contract.artifactId,
      artifactType: "quality_review",
      path: contract.path,
      content: JSON.stringify(boundChangeRequest)
    })]);
    assert.equal(legalWrite?.status, "completed", legalWrite?.error);
    const reviewArtifact = kernel.listArtifacts().find((artifact) => artifact.artifactId === contract.artifactId);
    assert.equal(reviewArtifact?.metadata.visionInspectionResponseHash, inspection?.hash);
    assert.match(String(reviewArtifact?.metadata.visionInspectionSemanticHash), /^[a-f0-9]{64}$/);
    assert.match(String(reviewArtifact?.metadata.visionAuthoritativeContextHash), /^[a-f0-9]{64}$/);
    assert.match(String(reviewArtifact?.metadata.visionRequestSemanticHash), /^[a-f0-9]{64}$/);

    kernel.upsertArtifact({ ...board, status: "submitted", updatedAt: new Date().toISOString() });
    const revisedArtBible = reviseTextArtifact(kernel, artBible, "# Art Bible\n\nReadable silhouettes. Canonical palette changed to cobalt.\n");
    const staleContextReview = qualityReview(kernel, contract, revisedArtBible, board, majorSemantic);
    const [staleContextWrite] = await executeAgentToolRequests(kernel, [toolMessage(kernel, invocationId, {
      tool: "write_artifact",
      taskId: contract.sourceTaskId,
      artifactId: contract.artifactId,
      artifactType: "quality_review",
      path: contract.path,
      content: JSON.stringify(staleContextReview)
    })]);
    assert.equal(staleContextWrite?.status, "failed");
    assert.match(staleContextWrite?.error ?? "", /权威上下文|Art Bible|过期/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  verifyStageTwoManifestContextStaleness();

  process.stdout.write("Vision semantic binding passed: caller prompt cannot replace authority, semantic score is immutable, and Art Bible/Manifest changes stale receipts\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function verifyStageTwoManifestContextStaleness() {
  const kernel = createStudioKernel("vision_manifest_stale", "Vision Manifest Stale", "producer_test", "manifest authority");
  const contract = getQualityReviewArtifactContracts().find(
    (candidate) => candidate.artifactId === "artifact_stage_2_visual_quality_review"
  );
  assert.ok(contract);
  addTask(kernel, "task_stage_1_art_direction", "art_director", [], ["artifact_art_bible_baseline_draft"]);
  addTask(kernel, "task_stage_2_asset_pipeline", "asset_production", ["artifact_art_bible_baseline_draft"], [
    "artifact_asset_manifest_draft",
    "artifact_asset_contact_sheet",
    "artifact_runtime_hero"
  ]);
  materializeText(kernel, {
    artifactId: "artifact_art_bible_baseline_draft",
    taskId: "task_stage_1_art_direction",
    type: "art_bible",
    path: "agents/art/art-bible.md",
    ownerAgentId: "art_director",
    content: "# Art Bible\n\nUse a cobalt focal palette.\n"
  });
  const runtimePath = "assets/art/first-playable/hero.png";
  materializeBinary(kernel, {
    artifactId: "artifact_runtime_hero",
    taskId: "task_stage_2_asset_pipeline",
    type: "asset",
    path: runtimePath,
    ownerAgentId: "asset_production",
    content: PNG
  });
  const manifest = materializeText(kernel, {
    artifactId: "artifact_asset_manifest_draft",
    taskId: "task_stage_2_asset_pipeline",
    type: "asset_manifest",
    path: "agents/art/asset-manifest.json",
    ownerAgentId: "asset_production",
    content: `${JSON.stringify({
      schemaVersion: "2.0.0",
      assets: [{ id: "hero", runtimePath, alphaPolicy: "optional" }]
    }, null, 2)}\n`
  });
  materializeBinary(kernel, {
    artifactId: "artifact_asset_contact_sheet",
    taskId: "task_stage_2_asset_pipeline",
    type: "asset",
    path: "agents/art/first-playable-contact-sheet.png",
    ownerAgentId: "asset_production",
    content: PNG
  });
  const oldContext = buildCurrentVisionReviewAuthoritativeContext(kernel, contract);
  const oldBinding = {
    authoritativeContextEvidence: oldContext.evidence,
    authoritativeContextHash: oldContext.hash,
    requestSemanticHash: hashArtVisionRequestSemantics(contract.rubric, oldContext.hash)
  };
  assert.doesNotThrow(() =>
    assertVisionSemanticReceiptAuthoritativeContextCurrent(kernel, contract, oldBinding)
  );
  reviseTextArtifact(kernel, manifest, `${JSON.stringify({
    schemaVersion: "2.0.0",
    notes: "production constraints revised after inspection",
    assets: [{ id: "hero", runtimePath, alphaPolicy: "optional" }]
  }, null, 2)}\n`);
  assert.throws(
    () => assertVisionSemanticReceiptAuthoritativeContextCurrent(kernel, contract, oldBinding),
    /权威上下文已过期|Asset Manifest/
  );
}

function addTask(kernel, taskId, ownerAgentId, inputArtifacts, outputArtifacts) {
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    title: taskId,
    description: "vision semantic binding fixture",
    ownerAgentId,
    participantAgentIds: [],
    status: "doing",
    priority: 100,
    sortOrder: 1,
    progressPercent: 0,
    blockers: [],
    inputArtifacts,
    outputArtifacts,
    acceptanceCriteria: [],
    createdAt: now,
    updatedAt: now
  });
}

function materializeText(kernel, input) {
  const artifact = baseArtifact(kernel, input);
  kernel.upsertArtifact(artifact);
  const written = writeToolArtifactContent(kernel, artifact, { content: input.content, mode: "replace" });
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: written.relativePath,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    materializedAt: written.materializedAt
  });
  return artifact;
}

function materializeBinary(kernel, input) {
  const artifact = baseArtifact(kernel, input);
  kernel.upsertArtifact(artifact);
  const written = writeToolArtifactBinaryContent(kernel, artifact, input.content);
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: written.relativePath,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    materializedAt: written.materializedAt
  });
  return artifact;
}

function reviseTextArtifact(kernel, artifact, content) {
  const revised = {
    ...artifact,
    status: "submitted",
    version: artifact.version + 1,
    updatedAt: new Date().toISOString()
  };
  kernel.upsertArtifact(revised);
  const written = writeToolArtifactContent(kernel, revised, { content, mode: "replace" });
  kernel.recordArtifactMaterialization(revised.artifactId, {
    path: written.relativePath,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    materializedAt: written.materializedAt
  });
  return revised;
}

function baseArtifact(kernel, input) {
  const now = new Date().toISOString();
  return {
    artifactId: input.artifactId,
    projectId: kernel.project.projectId,
    type: input.type,
    path: input.path,
    ownerAgentId: input.ownerAgentId,
    stageId: kernel.project.currentStage,
    status: "submitted",
    version: 1,
    sourceTaskId: input.taskId,
    sourceDecisionIds: [],
    metadata: { toolName: "fixture", toolExecutedAt: now },
    createdAt: now,
    updatedAt: now
  };
}

function semanticResult(contract, path, overrides = {}) {
  const score = overrides.score ?? 90;
  const status = overrides.status ?? "pass";
  const severity = overrides.severity ?? "note";
  const criteria = contract.rubric.criteria.map((criterion) => ({
    ...criterion,
    score,
    status,
    findings: [{
      issueCode: `${criterion.criterionId}.direct.observation`,
      severity,
      summary: `Visible observation for ${criterion.label}.`,
      evidenceRefs: [`${path}#pixel:full frame ${criterion.criterionId}`]
    }]
  }));
  const scoreTotal = Number(criteria.reduce(
    (total, criterion) => total + criterion.weight * criterion.score / 100,
    0
  ).toFixed(4));
  return {
    schemaVersion: "1.0.0",
    rubricId: contract.rubric.rubricId,
    rubricVersion: contract.rubric.version,
    passThreshold: contract.rubric.passThreshold,
    criteria,
    scoreTotal,
    verdict: overrides.verdict ?? status
  };
}

function qualityReview(kernel, contract, artBible, board, semantic, overrides) {
  const selectedSemantic = overrides ? semanticResult(contract, board.path, overrides) : semantic;
  const targets = [artBible, board].map((artifact) => {
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId);
    assert.ok(ledger?.hash && ledger.sizeBytes);
    return {
      artifactId: artifact.artifactId,
      version: artifact.version,
      path: artifact.path,
      ledgerHash: ledger.hash,
      sizeBytes: ledger.sizeBytes
    };
  });
  return {
    schemaVersion: "1.0.0",
    kind: "artifact_quality_review",
    reviewId: overrides ? "review.direct.forged_pass" : "review.direct.bound_change",
    domain: contract.domain,
    reviewerAgentId: contract.ownerAgentId,
    targets,
    rubric: {
      rubricId: contract.rubric.rubricId,
      version: contract.rubric.version,
      passThreshold: contract.rubric.passThreshold
    },
    criteria: selectedSemantic.criteria,
    scoreTotal: selectedSemantic.scoreTotal,
    verdict: selectedSemantic.verdict,
    requiredChanges: [],
    risks: [],
    blockingIssueCodes: [],
    modelTrace: { providerId: "placeholder", model: "placeholder", invocationId: "placeholder", promptVersion: "1.0.0" },
    reviewedAt: "2026-08-15T12:00:00.000Z"
  };
}

function toolMessage(kernel, invocationId, request) {
  return {
    messageId: `msg_${createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 16)}`,
    projectId: kernel.project.projectId,
    roomId: kernel.getRoom("art-room").roomId,
    senderType: "agent",
    senderId: "visual_quality_reviewer",
    messageType: "progress_update",
    content: `semantic binding\n\n\`\`\`json\n${JSON.stringify({ toolRequests: [request] })}\n\`\`\``,
    mentions: [],
    relatedTaskIds: ["task_stage_1_visual_quality_review"],
    relatedArtifactIds: [],
    metadata: { providerId: "dashscope", model: "direct-review-model", invocationId },
    createdAt: new Date().toISOString()
  };
}
