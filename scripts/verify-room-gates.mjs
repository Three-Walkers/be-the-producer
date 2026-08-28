import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  getQualityReviewArtifactContracts,
  IllegalWorkflowStageTransitionError,
  LocalAgentRuntime,
  reconcileLocalRuntimeProjectState
} from "../packages/agent-runtime/dist/index.js";
import {
  hashArtVisionRequestSemantics,
  hashArtVisionSemanticResult
} from "../apps/api/dist/multimodalArtProvider.js";
import { buildCurrentVisionReviewAuthoritativeContext } from "../apps/api/dist/qualityReviewArtifacts.js";
import {
  bindMediaGenerationArtifactMetadata,
  mediaGenerationOperationMetadata
} from "../apps/api/dist/mediaArtifactEvidence.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const kernel = createStudioKernel("game_room_gate_test", "Room gate test", "producer_test", "test idea");
const designRoom = kernel.getRoom("design-room");
assert.ok(designRoom.participants.includes("game_designer"));

const removed = kernel.updateRoomParticipant("design-room", "game_designer", "remove");
assert.equal(removed.changed, true);
assert.ok(!removed.room.participants.includes("game_designer"));

const removedRoute = kernel.postMessage(producerMessage(kernel, designRoom.roomId, "@策划 请回复", ["game_designer"]));
assert.ok(!removedRoute.targets.some((target) => target.agentId === "game_designer"));

const invited = kernel.updateRoomParticipant("design-room", "game_designer", "invite");
assert.equal(invited.changed, true);
const invitedRoute = kernel.postMessage(producerMessage(kernel, designRoom.roomId, "@策划 请回复", ["game_designer"]));
assert.ok(invitedRoute.targets.some((target) => target.agentId === "game_designer"));

const restored = createStudioKernelFromSnapshot(kernel.toSnapshot());
assert.ok(restored.getRoom("design-room").participants.includes("game_designer"));

const policyTempRoot = mkdtempSync(join(tmpdir(), "game-api-gate-policy-"));
process.env.STUDIO_WORKSPACE_ROOT = policyTempRoot;
const { apiGateEvidencePolicy } = await import("../apps/api/dist/gateEvidencePolicy.js");
try {
  const policyKernel = createStudioKernel("game_api_gate_policy", "API policy test", "producer_test", "test idea");
  const relativePath = "agents/design/gdd/policy.md";
  const absolutePath = join(policyTempRoot, policyKernel.project.projectId, relativePath);
  const content = "current gate evidence\n";
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  materializeGateArtifact(
    policyKernel,
    "artifact_policy_gdd",
    "gdd",
    relativePath,
    sha256(content),
    Buffer.byteLength(content)
  );
  const policyRequirement = {
    gateActionId: "stage1",
    phase: "decision",
    requiredArtifactIds: ["artifact_policy_gdd"]
  };
  assert.doesNotThrow(() => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement));
  const policyArtifact = policyKernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_policy_gdd");
  assert.ok(policyArtifact);
  policyKernel.upsertArtifact({
    ...policyArtifact,
    status: "change_requested",
    metadata: {
      ...policyArtifact.metadata,
      bridgeOperationId: "bridge_failed_fixture",
      bridgeOk: false
    },
    updatedAt: new Date().toISOString()
  });
  assert.throws(
    () => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement),
    /缺少当前且可消费的产物证据/,
    "a verified failure report must not be treated as a consumable gate deliverable"
  );
  policyKernel.upsertArtifact({
    ...policyArtifact,
    status: "draft",
    metadata: {
      ...policyArtifact.metadata,
      bridgeOperationId: "bridge_recovered_fixture",
      bridgeOk: true
    },
    updatedAt: new Date().toISOString()
  });
  assert.doesNotThrow(() => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement));
  writeFileSync(absolutePath, "tampered gate evidence\n");
  assert.throws(
    () => apiGateEvidencePolicy.assertGateEvidence(policyKernel, policyRequirement),
    /缺少当前且可消费的产物证据/,
    "API policy must reject a workspace file that no longer matches its ledger"
  );
} finally {
  rmSync(policyTempRoot, { recursive: true, force: true });
}

const gateTempRoot = mkdtempSync(join(tmpdir(), "game-room-gate-evidence-"));
process.env.STUDIO_WORKSPACE_ROOT = gateTempRoot;
const gateKernel = createStudioKernel("game_gate_test", "Gate test", "producer_test", "test idea");
const runtime = new LocalAgentRuntime({ gateEvidencePolicy: apiGateEvidencePolicy });
const first = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "发起立项阶段的门禁评审"),
  { scriptedReplies: false }
);
assert.ok(first.agentMessages.some((message) =>
  message.messageType === "blocker" &&
  /canonical 产物身份不匹配|独立质量审查|缺少当前且可消费的产物证据/.test(message.content)
));
assert.equal(gateKernel.project.currentStage, "concept_discussion", "missing evidence must not freeze work in review");
assert.equal(gateKernel.getWorkflowSnapshot().activeGateId, null);
assert.deepEqual(gateKernel.listWorkflowEvents(), []);

assert.throws(
  () => gateKernel.setStage("production"),
  IllegalWorkflowStageTransitionError,
  "the legacy stage setter must not bypass producer review"
);

const second = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "执行确认：确认立项"),
  { scriptedReplies: false }
);
assert.ok(second.agentMessages.some((message) => message.messageType === "decision_request" && message.content.includes("必须先经过")));
assert.ok(!second.agentMessages.some((message) => message.content.includes("二次确认口令：执行确认：确认立项")));
assert.equal(gateKernel.project.currentStage, "concept_discussion");
assert.equal(gateKernel.getWorkflowSnapshot().decisions.length, 0);

reconcileLocalRuntimeProjectState(gateKernel);
materializePassingStageOneEvidence(gateKernel);
const readyReview = runtime.handleProducerMessage(
  gateKernel,
  producerMessage(gateKernel, gateKernel.getRoom("studio-main").roomId, "发起立项阶段的门禁评审"),
  { scriptedReplies: false }
);
assert.ok(readyReview.agentMessages.some((message) => message.content.includes("二次确认口令：执行确认：确认立项")));
assert.equal(gateKernel.project.currentStage, "concept_review");
assert.equal(gateKernel.getWorkflowSnapshot().activeGateId !== null, true);
assert.deepEqual(
  gateKernel.listWorkflowEvents().map((event) => event.type),
  ["stage_transitioned", "gate_opened"]
);

const activeGateId = gateKernel.getWorkflowSnapshot().activeGateId;
assert.ok(activeGateId);
assert.throws(
  () => gateKernel.executeWorkflow({
    type: "record_gate_decision",
    expectedRevision: gateKernel.getWorkflowSnapshot().revision,
    idempotencyKey: "agent-cannot-self-approve-room-gate",
    actor: { actorId: "game_designer", role: "agent" },
    gateId: activeGateId,
    verdict: "approved",
    notes: "Agent attempted self approval."
  }),
  (error) => error?.code === "WORKFLOW_FORBIDDEN"
);

const reviewSnapshot = gateKernel.toSnapshot();
assert.equal(reviewSnapshot.workflow?.stage, "concept_review");
const restoredReview = createStudioKernelFromSnapshot(reviewSnapshot);
assert.equal(restoredReview.project.currentStage, "concept_review");
assert.deepEqual(restoredReview.getWorkflowSnapshot(), gateKernel.getWorkflowSnapshot());

const approvalMessage = producerMessage(
  gateKernel,
  gateKernel.getRoom("studio-main").roomId,
  "执行确认：确认立项"
);
runtime.handleProducerMessage(gateKernel, approvalMessage, { scriptedReplies: false });
assert.equal(gateKernel.project.currentStage, "production");
assert.equal(gateKernel.getWorkflowSnapshot().decisions.at(-1)?.producerId, gateKernel.project.producerId);
assert.equal(gateKernel.getWorkflowSnapshot().decisions.at(-1)?.verdict, "approved");
const approvedRevision = gateKernel.getWorkflowSnapshot().revision;
runtime.handleProducerMessage(gateKernel, approvalMessage, { scriptedReplies: false });
assert.equal(
  gateKernel.getWorkflowSnapshot().revision,
  approvedRevision,
  "replaying the same producer request must not duplicate a workflow decision"
);
const mismatchedSnapshot = gateKernel.toSnapshot();
assert.throws(
  () => createStudioKernelFromSnapshot({
    ...mismatchedSnapshot,
    project: { ...mismatchedSnapshot.project, currentStage: "release_preparation" }
  }),
  /does not match project stage/,
  "snapshot restore must reject drift between Project and Workflow stages"
);

const deploymentKernel = createStudioKernelFromSnapshot({
  ...kernel.toSnapshot(),
  project: {
    ...kernel.project,
    projectId: "game_deployment_boundary_test",
    currentStage: "production_deploy"
  },
  workflow: undefined,
  rooms: kernel.listRooms().map((room) => ({
    ...room,
    projectId: "game_deployment_boundary_test"
  })),
  messages: [],
  tasks: [],
  artifacts: [],
  artifactOperations: [],
  artifactLedger: [],
  claimVerifications: [],
  claimRepairs: [],
  memoryRecords: [],
  auditEvents: []
});
assert.throws(
  () => deploymentKernel.setStage("liveops", "2026-08-13T10:00:00.000Z"),
  IllegalWorkflowStageTransitionError,
  "even deployment completion must not use the legacy stage setter"
);
deploymentKernel.executeWorkflow({
  type: "transition_stage",
  expectedRevision: deploymentKernel.getWorkflowSnapshot().revision,
  idempotencyKey: "deployment-health-check-passed",
  actor: { actorId: "devops", role: "orchestrator" },
  occurredAt: "2026-08-13T10:00:00.000Z",
  targetStage: "liveops",
  reason: "Production deployment and health checks passed."
});
assert.equal(deploymentKernel.project.currentStage, "liveops");
assert.equal(deploymentKernel.listWorkflowEvents().at(-1)?.trigger, "operational_transition");

rmSync(gateTempRoot, { recursive: true, force: true });
console.log("Room membership and natural-language gate smoke passed");

function producerMessage(targetKernel, roomId, content, mentions = []) {
  return {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: targetKernel.project.projectId,
    roomId,
    senderType: "producer",
    senderId: targetKernel.project.producerId,
    messageType: "plan_submission",
    content,
    mentions,
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

function materializePassingStageOneEvidence(targetKernel) {
  materializeRegisteredArtifact(
    targetKernel,
    "artifact_gdd_baseline_draft",
    Buffer.from("# Gate-ready GDD\n\nA clear tap loop, public progress signal, mobile feedback and bounded MVP scope.\n"),
    { toolName: "write_artifact" }
  );
  materializeRegisteredArtifact(
    targetKernel,
    "artifact_game_contract_draft",
    Buffer.from(`${JSON.stringify(gameContractFixture(), null, 2)}\n`),
    { toolName: "write_artifact" }
  );
  materializeRegisteredArtifact(
    targetKernel,
    "artifact_art_bible_baseline_draft",
    Buffer.from("# Gate-ready Art Bible\n\nRounded silhouettes, restrained warm palette, high-contrast mobile UI and a 1024px source budget.\n"),
    { toolName: "write_artifact" }
  );
  const board = materializeRegisteredArtifact(
    targetKernel,
    "artifact_art_direction_board",
    PNG,
    {
      generatedBy: "dashscope_multimodal_art_provider",
      toolName: "generate_raster_asset",
      mediaProvider: "dashscope",
      mediaModel: "wan2.7-image-pro",
      mediaRequestId: "room-gate-art-direction-board",
      mediaPromptHash: sha256("room gate art direction board prompt"),
      mediaMime: "image/png",
      mediaWidth: 1,
      mediaHeight: 1,
      mediaRole: "art_direction_board"
    }
  );

  const designReview = passingQualityReview(targetKernel, "artifact_stage_1_design_quality_review");
  materializeRegisteredArtifact(
    targetKernel,
    "artifact_stage_1_design_quality_review",
    Buffer.from(`${JSON.stringify(designReview, null, 2)}\n`),
    qualityReviewMetadata(designReview)
  );
  const visualReview = passingQualityReview(targetKernel, "artifact_stage_1_visual_quality_review");
  const visionResult = {
    schemaVersion: "1.0.0",
    rubricId: visualReview.rubric.rubricId,
    rubricVersion: visualReview.rubric.version,
    passThreshold: visualReview.rubric.passThreshold,
    criteria: structuredClone(visualReview.criteria),
    scoreTotal: visualReview.scoreTotal,
    verdict: visualReview.verdict
  };
  const visionResponseHash = sha256("room-gate-canonical-vision-response");
  const visualContract = getQualityReviewArtifactContracts().find(
    (contract) => contract.artifactId === "artifact_stage_1_visual_quality_review"
  );
  assert.ok(visualContract);
  const authoritativeContext = buildCurrentVisionReviewAuthoritativeContext(targetKernel, visualContract);
  const requestSemanticHash = hashArtVisionRequestSemantics(visualContract.rubric, authoritativeContext.hash);
  const visionReceipt = {
    invocationId: visualReview.modelTrace.invocationId,
    operationId: "room-gate-vision-inspection",
    providerId: "dashscope",
    model: "qwen3.8-max",
    paths: [board.artifact.path],
    evidence: [{
      path: board.artifact.path,
      hash: board.ledger.hash,
      sizeBytes: board.ledger.sizeBytes
    }],
    responseHash: visionResponseHash,
    authoritativeContextEvidence: authoritativeContext.evidence,
    authoritativeContextHash: authoritativeContext.hash,
    requestSemanticHash,
    result: visionResult
  };
  materializeRegisteredArtifact(
    targetKernel,
    "artifact_stage_1_visual_quality_review",
    Buffer.from(`${JSON.stringify(visualReview, null, 2)}\n`),
    {
      ...qualityReviewMetadata(visualReview),
      visionInspectionOperationId: "room-gate-vision-inspection",
      visionInspectionProvider: "dashscope",
      visionInspectionModel: "qwen3.8-max",
      visionInspectionInvocationId: visualReview.modelTrace.invocationId,
      visionInspectionResponseHash: visionResponseHash,
      visionInspectionSemanticHash: hashArtVisionSemanticResult(visionResult),
      visionAuthoritativeContextEvidence: authoritativeContext.evidence,
      visionAuthoritativeContextHash: authoritativeContext.hash,
      visionRequestSemanticHash: requestSemanticHash,
      visionInspectionSemanticResult: visionResult,
      visionInspectionSemanticReceipts: [visionReceipt],
      visionInspectedPaths: [board.artifact.path],
      visionInspectedEvidence: [{
        path: board.artifact.path,
        hash: board.ledger.hash,
        sizeBytes: board.ledger.sizeBytes
      }],
      visionInspectedAt: new Date().toISOString()
    }
  );
}

function materializeRegisteredArtifact(targetKernel, artifactId, content, metadata) {
  const existing = targetKernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  assert.ok(existing, `fixture requires canonical artifact ${artifactId}`);
  assert.ok(existing.sourceTaskId && targetKernel.findTask(existing.sourceTaskId), `${artifactId} must retain its canonical source task`);
  const now = new Date().toISOString();
  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, targetKernel.project.projectId, existing.path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  let artifact = targetKernel.upsertArtifact({
    ...existing,
    status: "submitted",
    version: existing.version + 1,
    metadata: {
      ...existing.metadata,
      generatedBy: metadata.generatedBy ?? "room_gate_strict_fixture",
      ...metadata,
      toolExecutedAt: now
    },
    updatedAt: now
  });
  const stats = statSync(absolutePath);
  const hash = sha256(content);
  const genuineGenerate = metadata.toolName === "generate_raster_asset";
  const ledger = targetKernel.recordArtifactMaterialization(artifact.artifactId, {
    path: artifact.path,
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
    artifact = targetKernel.upsertArtifact({
      ...artifact,
      metadata: bindMediaGenerationArtifactMetadata(
        artifact.metadata,
        ledger.sourceOperationId,
        { hash, sizeBytes: stats.size }
      ),
      updatedAt: stats.mtime.toISOString()
    });
  }
  assert.equal(ledger.status, "verified", `${artifactId} fixture evidence must be verified`);
  assert.ok(ledger.hash && ledger.sizeBytes !== undefined);
  return { artifact, ledger };
}

function passingQualityReview(targetKernel, artifactId) {
  const contract = getQualityReviewArtifactContracts().find((candidate) => candidate.artifactId === artifactId);
  assert.ok(contract, `missing canonical quality review contract ${artifactId}`);
  const targets = contract.subjectArtifactIds.map((subjectArtifactId) => {
    const artifact = targetKernel.listArtifacts().find((candidate) => candidate.artifactId === subjectArtifactId);
    const ledger = targetKernel.listArtifactLedger().find((candidate) => candidate.artifactId === subjectArtifactId);
    assert.ok(artifact && ledger?.status === "verified" && ledger.hash && ledger.sizeBytes !== undefined);
    return {
      artifactId: artifact.artifactId,
      version: artifact.version,
      path: artifact.path,
      ledgerHash: ledger.hash,
      sizeBytes: ledger.sizeBytes
    };
  });
  const criteria = contract.rubric.criteria.map((criterion, index) => {
    const evidenceRef = contract.domain === "design"
      ? index % 2 === 0
        ? `${targets.find((target) => target.artifactId === "artifact_gdd_baseline_draft").path}#L1-L3`
        : `${targets.find((target) => target.artifactId === "artifact_game_contract_draft").path}#/coreLoop`
      : `${targets.find((target) => target.artifactId === "artifact_art_direction_board").path}#pixel:full-frame`;
    return {
      criterionId: criterion.criterionId,
      label: criterion.label,
      weight: criterion.weight,
      score: 90,
      status: "pass",
      findings: [{
        issueCode: `${criterion.criterionId}.positive_evidence`,
        severity: "note",
        summary: `Fixture records grounded positive evidence for ${criterion.label}.`,
        evidenceRefs: [evidenceRef]
      }]
    };
  });
  return {
    schemaVersion: "1.0.0",
    kind: "artifact_quality_review",
    reviewId: `room_gate.${artifactId.replace(/^artifact_/, "")}.pass`,
    domain: contract.domain,
    reviewerAgentId: contract.ownerAgentId,
    targets,
    rubric: {
      rubricId: contract.rubric.rubricId,
      version: contract.rubric.version,
      passThreshold: contract.rubric.passThreshold
    },
    criteria,
    scoreTotal: 90,
    verdict: "pass",
    requiredChanges: [],
    risks: [],
    blockingIssueCodes: [],
    modelTrace: {
      providerId: "dashscope",
      model: contract.domain === "design" ? "qwen3-max" : "qwen3.8-max",
      invocationId: `room-gate-${contract.domain}-review-invocation`,
      promptVersion: "1.0.0"
    },
    reviewedAt: new Date().toISOString()
  };
}

function qualityReviewMetadata(review) {
  return {
    toolName: "write_artifact",
    reviewProviderId: review.modelTrace.providerId,
    reviewModel: review.modelTrace.model,
    reviewInvocationId: review.modelTrace.invocationId,
    reviewPromptVersion: review.modelTrace.promptVersion,
    qualityReviewDomain: review.domain,
    qualityReviewVerdict: review.verdict,
    qualityReviewScore: review.scoreTotal,
    qualityReviewedAt: review.reviewedAt
  };
}

function gameContractFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "game_contract",
    identity: {
      contractId: "room_gate_test.contract",
      gameId: "room_gate_test",
      title: "Room Gate Test",
      slug: "room-gate-test",
      summary: "A compact current contract used by the strict room gate fixture.",
      revision: 1,
      releaseVersion: "0.1.0"
    },
    genre: {
      primary: "tap_action",
      tags: ["tap_action", "casual"],
      perspective: "2d",
      playerMode: "single_player"
    },
    coreLoop: {
      summary: "Start, tap the target and reach the public progress objective.",
      steps: [{
        stepId: "play_loop",
        label: "Play",
        description: "Perform the primary action and observe public progress.",
        actionIds: ["tap_target"],
        stateIds: ["playing"],
        emits: ["progress"]
      }],
      successConditions: [{ signalId: "progress", operator: "gte", value: 1 }],
      failureConditions: []
    },
    stateModel: {
      lifecycle: "finite",
      initialState: "ready",
      states: [
        { stateId: "ready", label: "Ready", kind: "boot", terminal: false, description: "Waiting to start." },
        { stateId: "playing", label: "Playing", kind: "active", terminal: false, description: "Main gameplay loop." },
        { stateId: "won", label: "Won", kind: "success", terminal: true, description: "Objective completed." }
      ],
      transitions: [
        { transitionId: "start_game", from: "ready", to: "playing", trigger: { type: "system", ref: "start" }, guards: [], emits: [] },
        { transitionId: "complete_goal", from: "playing", to: "won", trigger: { type: "signal", ref: "progress" }, guards: [{ signalId: "progress", operator: "gte", value: 1 }], emits: [] }
      ]
    },
    inputModel: {
      actions: [{
        actionId: "tap_target",
        label: "Tap target",
        description: "Tap the current gameplay target.",
        bindings: [{ device: "touch", control: "gameplay_area", gesture: "tap" }],
        enabledInStates: ["playing"]
      }],
      simultaneousTouchPoints: 1
    },
    runtimeSignals: {
      signals: [{
        signalId: "progress",
        label: "Progress",
        description: "Public objective progress.",
        valueType: "integer",
        visibility: "public",
        initialValue: 0
      }]
    }
  };
}

function materializeGateArtifact(
  targetKernel,
  artifactId,
  type,
  path,
  hash = `sha256:${artifactId}`,
  sizeBytes = 128
) {
  const now = new Date().toISOString();
  const existing = targetKernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
  const artifactPath = existing?.path ?? path;
  if (existing) {
    targetKernel.upsertArtifact({
      ...existing,
      status: "draft",
      version: existing.version + 1,
      metadata: {
        ...existing.metadata,
        toolExecutedAt: now,
        toolName: "write_artifact"
      },
      updatedAt: now
    });
  } else {
    targetKernel.addArtifact({
      artifactId,
      projectId: targetKernel.project.projectId,
      type,
      path: artifactPath,
      ownerAgentId: type === "art_bible" ? "art_director" : "game_designer",
      stageId: "concept_discussion",
      status: "draft",
      version: 1,
      sourceDecisionIds: [],
      metadata: {
        toolExecutedAt: now,
        toolName: "write_artifact"
      },
      createdAt: now,
      updatedAt: now
    });
  }
  targetKernel.recordArtifactMaterialization(artifactId, {
    path: artifactPath,
    hash,
    sizeBytes,
    materializedAt: now
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
