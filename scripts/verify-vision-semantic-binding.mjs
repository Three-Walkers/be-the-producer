import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG as Png } from "pngjs";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-vision-semantic-binding-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_SECRET_ROOT = join(tempRoot, "secrets");

const { createStudioKernel, getQualityReviewArtifactContracts } = await import("../packages/agent-runtime/dist/index.js");
const { executeAgentToolRequests } = await import("../apps/api/dist/toolExecutor.js");
const { modelSettingsStore } = await import("../apps/api/dist/modelSettings.js");
const { writeToolArtifactBinaryContent, writeToolArtifactContent } = await import("../apps/api/dist/workspaceWriter.js");
const {
  assertVisionSemanticReceiptAuthoritativeContextCurrent,
  buildCurrentVisionReviewAuthoritativeContext,
  applyQualityReviewChangeRequest,
  currentGeneratedRuntimeAssetPathsForReview,
  qualityReviewFromVisionResult,
  qualityReviewReadyForGate
} = await import("../apps/api/dist/qualityReviewArtifacts.js");
const { reconcileInvalidQualityReviewEvidence, restoreHistoricalReviewReferences } = await import("../apps/api/dist/evidenceReconciliation.js");
const { hashArtVisionRequestSemantics } = await import("../apps/api/dist/multimodalArtProvider.js");
const { mediaGenerationOperationMetadata, bindMediaGenerationArtifactMetadata } = await import("../apps/api/dist/mediaArtifactEvidence.js");

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
  const mixedSemantic = structuredClone(majorSemantic);
  mixedSemantic.criteria[0].findings.push({ issueCode: "palette.already_correct", severity: "note",
    summary: "The sand palette already matches the baseline.", evidenceRefs: [`${board.path}#pixel:sand`] });
  const projected = qualityReviewFromVisionResult(contract, mixedSemantic,
    qualityReview(kernel, contract, artBible, board, mixedSemantic).targets, "review.mixed");
  assert.deepEqual(projected.criteria, mixedSemantic.criteria, "all observations and scores remain immutable");
  assert.equal(projected.requiredChanges.some((change) => change.issueCode === "palette.already_correct"), false,
    "positive notes in a failed aggregate criterion must not become author rework");
  assert.ok(projected.requiredChanges.length > 0, "real major findings still require rework");
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
    const changeRequestReady = qualityReviewReadyForGate(kernel, contract.artifactId, false);
    assert.equal(changeRequestReady.ok, true,
      `a grounded change request stays valid after applying its own feedback: ${changeRequestReady.reason}`);
    assert.equal(qualityReviewReadyForGate(kernel, contract.artifactId).ok, false,
      "a valid change request must never pass the producer gate");
    const originalVersion = reviewArtifact.version;
    assert.equal(reconcileInvalidQualityReviewEvidence(kernel).changed, false,
      "checkpoint reconciliation must not destroy the receipt it just accepted");
    assert.equal(kernel.listArtifacts().find((artifact) => artifact.artifactId === contract.artifactId).version, originalVersion);
    const subject = kernel.listArtifacts().find((artifact) => artifact.artifactId === board.artifactId);
    const ownReviewId = subject.metadata.qualityChangeReviewId;
    subject.metadata.qualityChangeReviewId = "another.review";
    assert.equal(qualityReviewReadyForGate(kernel, contract.artifactId, false).ok, false,
      "feedback from another review cannot be projected away");
    subject.metadata.qualityChangeReviewId = ownReviewId;

    const oldContext = buildCurrentVisionReviewAuthoritativeContext(kernel, contract);
    const scopeDecision = {messageId: "scope_decision", projectId, roomId: kernel.getRoom("studio-main").roomId,
      senderType: "agent", senderId: "art_director", messageType: "decision_record", content: "HUD 布局由 Cocos 组件实现，不烘焙整块 PNG。",
      mentions: [], relatedTaskIds: [], relatedArtifactIds: [], metadata: {}, createdAt: new Date().toISOString()};
    kernel.recordMessage(scopeDecision);
    assert.equal(buildCurrentVisionReviewAuthoritativeContext(kernel, contract).hash, oldContext.hash, "agent claims cannot become authoritative producer decisions");
    kernel.recordMessage({...scopeDecision, messageId: "producer_scope", senderType: "producer", senderId: "producer_test"});
    const newContext = buildCurrentVisionReviewAuthoritativeContext(kernel, contract);
    assert.notEqual(newContext.hash, oldContext.hash, "producer scope must be bound into the immutable vision request");
    assert.deepEqual(JSON.parse(newContext.prompt).producerDecisions.map(d => d.messageId), ["producer_scope"]);
    assert.equal(qualityReviewReadyForGate(kernel, contract.artifactId, false).ok, false, "old inspection cannot be reused after scope changes");

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
    const invalidated = reconcileInvalidQualityReviewEvidence(kernel);
    assert.ok(invalidated.artifactIds.includes(contract.artifactId));
    const reopened = kernel.findTask(contract.sourceTaskId);
    assert.equal(reopened.status, "doing");
    assert.equal(reopened.blockers.length, 0, "the reason for re-review must not block the re-review task itself");
    kernel.updateTask(reopened.taskId, { status: "blocked", blockers: ["质量审查证据失效：legacy deadlock"] });
    reconcileInvalidQualityReviewEvidence(kernel);
    assert.equal(kernel.findTask(reopened.taskId).status, "doing", "legacy stuck reviewers resume after valid inputs return");
    assert.equal(kernel.findTask(reopened.taskId).blockers.length, 0);
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
  const bible = kernel.listArtifacts().find((a) => a.artifactId === "artifact_art_bible_baseline_draft");
  kernel.executeWorkflow({ type: "submit_review", actor: { actorId: "orchestrator", role: "orchestrator" },
    expectedRevision: kernel.getWorkflowSnapshot().revision, occurredAt: new Date().toISOString(),
    idempotencyKey: "fixture-concept-review", requiredArtifacts: [bible.artifactId], checks: ["fixture"], label: "Concept" });
  kernel.executeWorkflow({ type: "record_gate_decision", actor: { actorId: "producer_test", role: "producer" },
    expectedRevision: kernel.getWorkflowSnapshot().revision, occurredAt: new Date().toISOString(),
    idempotencyKey: "fixture-concept-approval", gateId: kernel.getWorkflowSnapshot().activeGateId, verdict: "approved", notes: "fixture" });
  kernel.findTask("task_stage_2_asset_pipeline").stageId = "production";
  addTask(kernel, contract.sourceTaskId, contract.ownerAgentId, [], [contract.artifactId]);
  kernel.findTask("task_stage_1_art_direction").status = "done";
  bible.status = "approved";
  const feedback = { reviewId: "review.stage2", verdict: "change_requested", reviewerAgentId: contract.ownerAgentId,
    targets: [{ artifactId: bible.artifactId }, { artifactId: manifest.artifactId }],
    modelTrace: { invocationId: "inv.stage2" }, requiredChanges: [{ issueCode: "asset.fix", summary: "Fix alpha" }] };
  applyQualityReviewChangeRequest(kernel, { artifactId: contract.artifactId }, feedback);
  assert.equal(bible.status, "approved", "historical reference is not a current author deliverable");
  assert.equal(manifest.status, "change_requested");
  assert.equal(kernel.findTask("task_stage_1_art_direction").status, "done");
  bible.status = "change_requested";
  Object.assign(bible.metadata, { qualityChangeReviewArtifactId: contract.artifactId, qualityChangeReviewInvocationId: "inv.stage2" });
  const originalWorkflow = kernel.getWorkflowSnapshot.bind(kernel);
  kernel.getWorkflowSnapshot = () => ({ gates: [], decisions: [] });
  assert.deepEqual(restoreHistoricalReviewReferences(kernel), [], "no producer approval means no automatic restoration");
  kernel.getWorkflowSnapshot = () => ({ gates: [{ status: "approved", requiredArtifacts: [bible.artifactId],
    decisionId: "decision", resolvedAt: "2099-01-01T00:00:00.000Z" }], decisions: [{ decisionId: "decision", status: "active" }] });
  assert.deepEqual(restoreHistoricalReviewReferences(kernel), [bible.artifactId]);
  assert.equal(bible.status, "approved");
  assert.equal(bible.metadata.qualityChangeReviewArtifactId, undefined);
  kernel.getWorkflowSnapshot = originalWorkflow;
  // Deliberately wrong opaque policy can be measured/rejected, but never pass.
  const translucent = new Png({ width: 1, height: 1 });
  translucent.data.set([100, 80, 60, 252]);
  const runtimeArtifact = kernel.listArtifacts().find((a) => a.artifactId === "artifact_runtime_hero");
  // Materialize through fixture generation receipts, exactly as real tool output.
  materializeBinary(kernel, { artifactId: runtimeArtifact.artifactId, taskId: "task_stage_2_asset_pipeline",
    type: "asset", path: runtimePath, ownerAgentId: "asset_production", content: Png.sync.write(translucent) });
  reviseTextArtifact(kernel, manifest, JSON.stringify({ schemaVersion: "2.0.0", assets: [{ id: "hero", runtimePath, alphaPolicy: "opaque" }] }));
  assert.deepEqual(currentGeneratedRuntimeAssetPathsForReview(kernel, feedback), [runtimePath]);
  assert.throws(() => currentGeneratedRuntimeAssetPathsForReview(kernel, { ...feedback, verdict: "pass" }), /非全不透明/);
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
  const generation = {
    hash: createHash("sha256").update(input.content).digest("hex"), sizeBytes: input.content.length,
    provider: "fixture", model: "fixture-image", requestId: `fixture-${input.artifactId}`, promptHash: "a".repeat(64)
  };
  artifact.metadata = {
    ...artifact.metadata, toolName: "generate_raster_asset", generatedBy: "dashscope_multimodal_art_provider",
    mediaProvider: generation.provider, mediaModel: generation.model, mediaRequestId: generation.requestId,
    mediaPromptHash: generation.promptHash, mediaMime: "image/png", mediaWidth: 1, mediaHeight: 1
  };
  kernel.upsertArtifact(artifact);
  const written = writeToolArtifactBinaryContent(kernel, artifact, input.content);
  const ledger = kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: written.relativePath,
    hash: written.hash,
    sizeBytes: written.sizeBytes,
    materializedAt: written.materializedAt,
    operationMetadata: mediaGenerationOperationMetadata(generation)
  });
  const current = kernel.listArtifacts().find((entry) => entry.artifactId === artifact.artifactId);
  current.metadata = bindMediaGenerationArtifactMetadata(current.metadata, ledger.sourceOperationId, generation);
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
    requiredChanges: selectedSemantic.verdict === "pass" ? [] : selectedSemantic.criteria.flatMap((criterion) =>
      criterion.findings.filter((finding) => ["critical", "major"].includes(finding.severity)).map((finding) => ({
        issueCode: finding.issueCode, summary: `Fix: ${finding.summary}`,
        acceptanceCriteria: ["Re-inspection confirms the issue is resolved."], evidenceRefs: finding.evidenceRefs
      }))
    ),
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
