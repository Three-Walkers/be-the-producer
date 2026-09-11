import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AgentContract, Artifact, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import type { QualityReviewArtifactContract, StudioKernel } from "@game-pipeline/agent-runtime";
import { inferArtifactType, stableArtifactId, type ToolExecutionResult } from "./toolExecutor.js";
import { artifactFilePath, hashWorkspaceFile, resolveProjectWorkspaceRoot } from "./workspaceWriter.js";
import { selfCheckPath, implementationReviewPath, validateImplementationReview, applyImplementationReviewFeedback } from "./implementationReview.js";
import { runImplementationChecks } from "./implementationChecks.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { parsePlaytestMarker } from "./playtestEvidence.js";
import type { AgentHarnessToolOperation } from "./agentHarness.js";
import { isQaHarnessManagedPath } from "./qaEvidenceProtection.js";
import { assertAgentPathAuthorized } from "./toolAuthorization.js";
import { resolvePathWithinRoot } from "./pathSafety.js";
import {
  applyQualityReviewChangeRequest,
  assertQualityReviewMatchesVisionSemanticResult,
  buildVisionReviewAuthoritativeContext,
  currentVisionProducerDecisions,
  linkGeneratedRuntimeAssetToVisualReview,
  mergeVisionSemanticInspectionReceipts,
  qualityReviewContractForArtifact,
  parseQualityReviewText
} from "./qualityReviewArtifacts.js";
import {
  bindMediaGenerationArtifactMetadata,
  hasCurrentGenerateRasterAssetReceipt,
  mediaGenerationOperationMetadata,
  stripPrivilegedMaterializationMetadata
} from "./mediaArtifactEvidence.js";

export interface WorkspaceFileEvidence {
  path: string;
  absolutePath: string;
  hash: string;
  sizeBytes: number;
  updatedAt: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceFileEvidence>;

export interface HarnessEvidenceResult {
  changedPaths: string[];
  deletedPaths: string[];
  violations: string[];
  artifactIds: string[];
  toolExecutions: ToolExecutionResult[];
}

export interface HarnessWorkspaceAnalysis {
  changedPaths: string[];
  deletedPaths: string[];
  violations: string[];
}

function buildHarnessVisionAuthoritativeContext(
  kernel: StudioKernel,
  contract: QualityReviewArtifactContract,
  workspace: WorkspaceSnapshot
) {
  const requiredIds = contract.domain === "art_direction"
    ? ["artifact_art_bible_baseline_draft"]
    : contract.domain === "visual_assets"
      ? ["artifact_art_bible_baseline_draft", "artifact_asset_manifest_draft"]
      : [];
  const artifacts = requiredIds.map((artifactId) => {
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
    const file = ledger ? workspace.get(ledger.path) : undefined;
    if (!artifact || !ledger?.hash || ledger.sizeBytes === undefined || !file) {
      throw new Error(`Harness 视觉权威上下文缺少当前文件证据：${artifactId}`);
    }
    return {
      artifactId,
      version: artifact.version,
      path: artifact.path,
      hash: ledger.hash,
      sizeBytes: ledger.sizeBytes,
      buffer: readFileSync(file.absolutePath)
    };
  });
  return buildVisionReviewAuthoritativeContext({
    contract,
    artifacts,
    producerDecisions: currentVisionProducerDecisions(kernel),
    readRuntimeAsset: (path) => {
      const file = workspace.get(path);
      if (!file) throw new Error(`Harness 视觉权威上下文缺少 runtime asset：${path}`);
      return readFileSync(file.absolutePath);
    }
  });
}

const ignoredDirectoryNames = new Set([
  ".git",
  ".be-the-producer",
  "node_modules",
  "library",
  "temp",
  "local"
]);

const generatedWorkspaceFiles = new Set([
  "README.md",
  "settings/be-the-producer.project.json",
  "shared/cocos/project-root.json",
  "shared/milestones/project.json",
  "shared/task-board/current-status.json",
  "shared/tasks/tasks.json",
  "shared/chat/messages.json",
  "shared/memory/project-memory.jsonl",
  "shared/artifacts/artifacts.json",
  "shared/artifacts/artifact-ledger.json",
  "shared/artifacts/artifact-operations.json",
  "shared/claims/claim-verifications.json",
  "shared/claims/claim-repairs.json",
  "shared/audit/audit-events.json"
]);

export function captureWorkspaceSnapshot(projectRoot: string): WorkspaceSnapshot {
  const safeRoot = resolvePathWithinRoot(projectRoot, ".", {
    allowMissing: false,
    allowRoot: true,
    expectedKind: "directory",
    label: "Harness 工作区"
  }).absolutePath;
  const files = new Map<string, WorkspaceFileEvidence>();
  walkDirectory(safeRoot, safeRoot, files);
  return files;
}

export function recordHarnessWorkspaceChanges(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  invocationId: string,
  invocationChangedPaths?: string[],
  invocationToolOperations?: AgentHarnessToolOperation[],
  options: { authoritativeWorkspace?: boolean; validationWorkspaceRoot?: string } = {}
): HarnessEvidenceResult {
  const analysis = analyzeHarnessWorkspaceChanges(
    kernel,
    task,
    agent,
    before,
    after,
    invocationChangedPaths,
    invocationToolOperations,
    options
  );
  const { changedPaths, deletedPaths, violations } = analysis;
  if (violations.length > 0) {
    return {
      changedPaths,
      deletedPaths,
      violations,
      artifactIds: [],
      toolExecutions: failedHarnessToolExecutions(invocationToolOperations)
    };
  }
  const artifactIds = new Set<string>();
  const toolExecutions: ToolExecutionResult[] = [];
  const now = new Date().toISOString();

  for (const path of changedPaths) {
    const file = after.get(path);
    if (!file) {
      continue;
    }
    const existing = findArtifactForPath(kernel, task, path);
    const pathWrites = invocationToolOperations
      ?.filter((operation) =>
        operation.path === path && (toolOperationSucceeded(operation) || isFailedCocosDiagnostic(operation, file)) && operationWritesWorkspace(operation)
      ) ?? [];
    let sourceOperation = pathWrites.at(-1);
    if (sourceOperation?.toolName === "resubmit_existing_asset") {
      const precedingWrite = pathWrites.filter((operation) => operation.toolName !== "resubmit_existing_asset").at(-1);
      // Resubmitting immediately after a genuine generation must not replace
      // that generation's provenance with an unchanged-old-asset assertion.
      // Do not search past an intervening write or accept mismatching bytes.
      if (precedingWrite?.toolName === "generate_raster_asset" &&
          generatedMediaReceiptMatchesFile(precedingWrite, file) && generatedMediaReceiptMatchesFile(sourceOperation, file)) {
        sourceOperation = precedingWrite;
      }
    }
    const sourceTool = sourceOperation?.toolName;
    if (sourceOperation && isFailedCocosDiagnostic(sourceOperation, file)) {
      toolExecutions.push({ toolName: sourceOperation.toolName as ToolExecutionResult["toolName"],
        status: "failed", path, hash: file.hash, sizeBytes: file.sizeBytes,
        error: sourceOperation.error ?? "Cocos 操作失败；已保留诊断，不是可消费产物。" });
      // Diagnostics are retained on disk and in the failed tool record, never
      // added to required task outputs or registered as successful artifacts.
      continue;
    }
    if (sourceOperation?.toolName === "resubmit_existing_asset") {
      if (!existing || existing.ownerAgentId !== agent.agentId || agent.agentId !== "asset_production" ||
          existing.sourceTaskId !== task.taskId || task.taskId !== "task_stage_2_asset_pipeline" ||
          !task.outputArtifacts.includes(existing.artifactId) || !path.startsWith("assets/art/first-playable/") || !path.endsWith(".png") ||
          !sourceOperation.resubmissionReason?.trim() || before.get(path)?.hash !== file.hash ||
          !generatedMediaReceiptMatchesFile(sourceOperation, file) || !hasCurrentGenerateRasterAssetReceipt(kernel, existing)) {
        throw new Error(`Existing asset resubmission lacks unchanged original generation evidence: ${path}`);
      }
      // Keep the original generation operation/ledger/version; this is an
      // author's explicit submission assertion, never a new creation or pass.
      kernel.upsertArtifact({ ...existing, status: "submitted", updatedAt: now,
        metadata: { ...existing.metadata, lastResubmission: { invocationId, reason: sourceOperation.resubmissionReason,
          hash: file.hash, submittedAt: now }, mediaReviewStatus: "pending_independent_review" } });
      artifactIds.add(existing.artifactId);
      toolExecutions.push({ toolName: "write_artifact", status: "completed", path, artifactId: existing.artifactId,
        hash: file.hash, sizeBytes: file.sizeBytes });
      continue;
    }
    const generatedMedia = sourceTool === "generate_raster_asset" ? sourceOperation : undefined;
    const composition = sourceTool === "compose_asset_contact_sheet" ? sourceOperation : undefined;
    if (composition && (!generatedMediaReceiptMatchesFile(composition, file) ||
        existing?.artifactId !== "artifact_asset_contact_sheet" || agent.agentId !== "asset_production" ||
        !composition.contactSheetReceipt || composition.contactSheetReceipt.outputHash !== file.hash ||
        composition.contactSheetReceipt.sources.some((source) => {
          const input = after.get(source.path);
          return !input || input.hash !== source.hash || input.sizeBytes !== source.sizeBytes;
        }))) throw new Error(`Contact sheet composition receipt does not match current bytes: ${path}`);
    if (generatedMedia && !generatedMediaReceiptMatchesFile(generatedMedia, file)) {
      const error =
        `generate_raster_asset 生成收据与本轮最终文件不一致，拒绝物化：${path}` +
        `（receipt hash=${generatedMedia.hash ?? "missing"}, size=${generatedMedia.sizeBytes ?? "missing"}; ` +
        `final hash=${file.hash}, size=${file.sizeBytes}）`;
      violations.push(error);
      toolExecutions.push({
        toolName: "generate_raster_asset",
        status: "failed",
        path,
        error
      });
      continue;
    }
    const playtest = path.endsWith(".md") ? parsePlaytestMarker(readFileSync(file.absolutePath, "utf8")) : undefined;
    const artifactType = existing?.type ?? inferArtifactType(agent.agentId, path);
    let implementationReview: ReturnType<typeof validateImplementationReview> | undefined;
    if (path === selfCheckPath || path === implementationReviewPath) {
      if (sourceOperation?.hash !== file.hash || sourceOperation?.sizeBytes !== file.sizeBytes ||
          sourceTool !== (path === selfCheckPath ? "run_implementation_checks" : "write_artifact")) {
        throw new Error(`Implementation verification report lacks authoritative tool evidence: ${path}`);
      }
      const root = options.validationWorkspaceRoot ?? resolveProjectWorkspaceRoot(kernel.project.projectId);
      const checks = runImplementationChecks(root, cocosEngineSettingsStore.getResolvedConfig().executablePath);
      const document = JSON.parse(readFileSync(file.absolutePath, "utf8"));
      if (path === selfCheckPath) {
        // Preserve valid source edits if the author forgot to rerun the check.
        // The immutable tool-produced report is retained as stale evidence;
        // currentImplementationReport refuses to consume it. Throwing here
        // rolls back the whole staged turn and loses the actual repair.
        if (agent.agentId !== "gameplay_programmer" || document.scope !== "static_integration_only" ||
            typeof document.fingerprint !== "string" || !["pass", "fail", "blocked"].includes(document.status)) throw new Error("Self-check lacks a valid programmer tool result.");
      } else {
        if (agent.agentId !== "qa_evaluator" || document.checks?.fingerprint !== checks.fingerprint) throw new Error("Independent implementation review is stale or not QA-owned.");
        implementationReview = validateImplementationReview(root, document, checks);
      }
    }
    const qualityReview = artifactType === "quality_review"
      ? parseQualityReviewText(readFileSync(file.absolutePath, "utf8"))
      : undefined;
    let qualityVisionReceipt: ReturnType<typeof mergeVisionSemanticInspectionReceipts> | undefined;
    if (qualityReview) {
      if (sourceTool !== "write_artifact" || !sourceOperation) {
        throw new Error(`quality_review ${path} 缺少本次 Harness write_artifact 操作证据。`);
      }
      if (qualityReview.reviewerAgentId !== agent.agentId) {
        throw new Error(`quality_review ${path} reviewer=${qualityReview.reviewerAgentId}，当前 Agent=${agent.agentId}。`);
      }
      if (qualityReview.modelTrace.invocationId !== invocationId) {
        throw new Error(`quality_review ${path} 的 modelTrace.invocationId 与本次 Harness invocation 不一致。`);
      }
      if (qualityReview.domain !== "design") {
        const contract = qualityReviewContractForArtifact(existing?.artifactId ?? "");
        if (!contract) throw new Error(`视觉 quality_review ${path} 缺少 canonical review contract。`);
        if (sourceOperation.operationType !== "quality_review_with_vision") {
          throw new Error(`视觉 quality_review ${path} 缺少本次 invocation 的语义绑定视觉操作。`);
        }
        qualityVisionReceipt = mergeVisionSemanticInspectionReceipts(
          sourceOperation.visionSemanticReceipts ?? [],
          contract
        );
        const currentAuthoritativeContext = buildHarnessVisionAuthoritativeContext(kernel, contract, after);
        if (
          sourceOperation.operationId !== qualityVisionReceipt.operationId ||
          sourceOperation.providerId !== qualityVisionReceipt.providerId ||
          sourceOperation.model !== qualityVisionReceipt.model ||
          sourceOperation.visionResponseHash !== qualityVisionReceipt.responseHash ||
          sourceOperation.visionSemanticHash !== qualityVisionReceipt.semanticHash ||
          sourceOperation.authoritativeContextHash !== qualityVisionReceipt.authoritativeContextHash ||
          sourceOperation.requestSemanticHash !== qualityVisionReceipt.requestSemanticHash ||
          JSON.stringify(sourceOperation.authoritativeContextEvidence) !==
            JSON.stringify(qualityVisionReceipt.authoritativeContextEvidence) ||
          currentAuthoritativeContext.hash !== qualityVisionReceipt.authoritativeContextHash ||
          JSON.stringify(currentAuthoritativeContext.evidence) !==
            JSON.stringify(qualityVisionReceipt.authoritativeContextEvidence)
        ) {
          throw new Error(`视觉 quality_review ${path} 的响应或权威上下文语义收据已缺失或过期。`);
        }
        assertQualityReviewMatchesVisionSemanticResult(qualityReview, qualityVisionReceipt.result);
      }
    }
    const artifact: Artifact = {
      artifactId: existing?.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, path),
      projectId: kernel.project.projectId,
      type: artifactType,
      path: existing?.path ?? path,
      ownerAgentId: agent.agentId,
      stageId: kernel.project.currentStage,
      status: "submitted",
      version: (existing?.version ?? 0) + 1,
      sourceTaskId: task.taskId,
      sourceDecisionIds: existing?.sourceDecisionIds ?? [],
      metadata: {
        ...stripPrivilegedMaterializationMetadata(existing?.metadata ?? {}),
        generatedBy: generatedMedia ? "dashscope_multimodal_art_provider" : "claude_cli_harness",
        nativeHarnessManaged: true,
        harnessInvocationId: invocationId,
        ...(sourceTool ? { harnessToolName: sourceTool } : {}),
        ...(sourceOperation?.operationId ? { bridgeOperationId: sourceOperation.operationId } : {}),
        ...(sourceOperation?.operationType ? { bridgeOperationType: sourceOperation.operationType } : {}),
        ...(sourceOperation?.bridgeOk !== undefined ? { bridgeOk: sourceOperation.bridgeOk } : {}),
        ...(sourceOperation?.error ? { harnessToolError: sourceOperation.error } : {}),
        ...(generatedMedia
          ? {
              mediaProvider: generatedMedia.providerId,
              mediaModel: generatedMedia.model,
              mediaRequestId: generatedMedia.requestId ?? generatedMedia.operationId,
              mediaEndpointFingerprint: generatedMedia.endpointFingerprint,
              mediaPromptHash: generatedMedia.promptHash,
              mediaNegativePromptHash: generatedMedia.negativePromptHash,
              mediaSeed: generatedMedia.seed,
              mediaMime: generatedMedia.mime,
              mediaWidth: generatedMedia.width,
              mediaHeight: generatedMedia.height,
              mediaLatencyMs: generatedMedia.latencyMs,
              mediaNormalizationReceipt: generatedMedia.normalizationReceipt,
              mediaReviewStatus: "pending_independent_review"
            }
          : {}),
        ...(qualityReview
          ? {
              reviewProviderId: qualityReview.modelTrace.providerId,
              reviewModel: qualityReview.modelTrace.model,
              reviewInvocationId: qualityReview.modelTrace.invocationId,
              reviewPromptVersion: qualityReview.modelTrace.promptVersion,
              qualityReviewDomain: qualityReview.domain,
              qualityReviewVerdict: qualityReview.verdict,
              qualityReviewScore: qualityReview.scoreTotal,
              qualityReviewedAt: qualityReview.reviewedAt
            }
          : {}),
        ...(qualityReview && sourceOperation?.operationType === "quality_review_with_vision" && qualityVisionReceipt
          ? {
              visionInspectionOperationId: qualityVisionReceipt.operationId,
              visionInspectionProvider: qualityVisionReceipt.providerId,
              visionInspectionModel: qualityVisionReceipt.model,
              visionInspectionInvocationId: qualityVisionReceipt.invocationId,
              visionInspectionResponseHash: qualityVisionReceipt.responseHash,
              visionInspectionSemanticHash: qualityVisionReceipt.semanticHash,
              visionAuthoritativeContextEvidence: qualityVisionReceipt.authoritativeContextEvidence,
              visionAuthoritativeContextHash: qualityVisionReceipt.authoritativeContextHash,
              visionRequestSemanticHash: qualityVisionReceipt.requestSemanticHash,
              visionInspectionSemanticResult: qualityVisionReceipt.result,
              visionInspectionSemanticReceipts: sourceOperation.visionSemanticReceipts ?? [],
              visionInspectedPaths: qualityVisionReceipt.paths,
              visionInspectedEvidence: qualityVisionReceipt.evidence,
              visionInspectedAt: sourceOperation.recordedAt ?? now
            }
          : {}),
        toolExecutedAt: now,
        changedPath: path,
        ...(playtest
          ? {
              playtestOperationId: playtest.operationId,
              playtestVerdict: playtest.verdict,
              playtestChecks: playtest.checks,
              playtestDefects: playtest.defects,
              playtestEvidencePaths: playtest.evidencePaths,
              playtestRuntime: playtest.runtime
            }
          : {})
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: file.updatedAt
    };
    let stored = kernel.upsertArtifact(artifact);
    stored.metadata = artifact.metadata;
    stored.status = playtest && playtest.verdict !== "pass" ? "change_requested" : "submitted";
    stored.updatedAt = file.updatedAt;
    const materialization = kernel.recordArtifactMaterialization(stored.artifactId, {
      path,
      hash: file.hash,
      sizeBytes: file.sizeBytes,
      materializedAt: file.updatedAt,
      ...(sourceOperation?.directoryManifest ? { directoryManifest: sourceOperation.directoryManifest } : {}),
      ...(generatedMedia
        ? {
            operationMetadata: mediaGenerationOperationMetadata({
              normalizationReceipt: generatedMedia.normalizationReceipt,
              hash: file.hash,
              sizeBytes: file.sizeBytes,
              provider: requiredOperationString(generatedMedia.providerId, "providerId", path),
              model: requiredOperationString(generatedMedia.model, "model", path),
              requestId: requiredOperationString(
                generatedMedia.requestId ?? generatedMedia.operationId,
                "requestId",
                path
              ),
              promptHash: requiredOperationString(generatedMedia.promptHash, "promptHash", path)
            })
          }
        : composition ? { operationMetadata: { materializationToolName: "compose_asset_contact_sheet",
            materializationHash: file.hash, materializationSizeBytes: file.sizeBytes, contactSheetReceipt: composition.contactSheetReceipt } }
        : [selfCheckPath, implementationReviewPath].includes(path) ? { operationMetadata: {
            implementationVerificationHash: file.hash, implementationVerificationTool: sourceTool } } : {})
    });
    if (generatedMedia) {
      stored = kernel.upsertArtifact({
        ...stored,
        metadata: bindMediaGenerationArtifactMetadata(
          stored.metadata,
          materialization.sourceOperationId,
          { hash: file.hash, sizeBytes: file.sizeBytes }
        ),
        updatedAt: file.updatedAt
      });
      linkGeneratedRuntimeAssetToVisualReview(kernel, stored, file.updatedAt);
    }
    if (qualityReview) {
      applyQualityReviewChangeRequest(kernel, stored, qualityReview, now);
    }
    if (implementationReview) applyImplementationReviewFeedback(kernel, stored, implementationReview);
    artifactIds.add(stored.artifactId);
    toolExecutions.push({
      toolName: sourceTool === "generate_raster_asset"
        ? "generate_raster_asset"
        : sourceTool === "append_document"
          ? "append_document"
          : "write_artifact",
      status: "completed",
      path,
      artifactId: stored.artifactId,
      hash: file.hash,
      sizeBytes: file.sizeBytes
    });
  }

  for (const operation of invocationToolOperations ?? []) {
    if (
      toolOperationSucceeded(operation) ||
      !failedToolExecutionName(operation.toolName)
    ) {
      continue;
    }
    if (
      toolExecutions.some(
        (execution) =>
          execution.status === "failed" &&
          execution.toolName === operation.toolName &&
          execution.path === operation.path
      )
    ) {
      continue;
    }
    toolExecutions.push({
      toolName: operation.toolName,
      status: "failed",
      path: operation.path,
      ...(operation.error ? { error: operation.error } : {})
    });
  }

  return {
    changedPaths,
    deletedPaths,
    violations,
    artifactIds: [...artifactIds],
    toolExecutions
  };
}

export function analyzeHarnessWorkspaceChanges(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  invocationChangedPaths?: string[],
  invocationToolOperations?: AgentHarnessToolOperation[],
  options: { authoritativeWorkspace?: boolean } = {}
): HarnessWorkspaceAnalysis {
  const workspaceChangedPaths = [...after.values()]
    .filter((file) => before.get(file.path)?.hash !== file.hash)
    .map((file) => file.path)
    .sort();
  const successfulOperationPaths = new Set(
    (invocationToolOperations ?? [])
      .filter((operation) => (toolOperationSucceeded(operation) || isFailedCocosDiagnostic(operation, after.get(operation.path))) && operationWritesWorkspace(operation))
      .map((operation) => operation.path)
  );
  const failedOnlyOperationPaths = new Set(
    (invocationToolOperations ?? [])
      .filter((operation) =>
        operationWritesWorkspace(operation) &&
        !toolOperationSucceeded(operation) &&
        !successfulOperationPaths.has(operation.path)
      )
      .map((operation) => operation.path)
  );
  const readOnlyOperationPaths = new Set(
    (invocationToolOperations ?? [])
      .filter((operation) => operation.access === "read" && !successfulOperationPaths.has(operation.path))
      .map((operation) => operation.path)
  );
  const failedMutationPaths = [...failedOnlyOperationPaths]
    .filter((path) => after.has(path) && before.get(path)?.hash !== after.get(path)?.hash)
    .sort();
  const explicitResubmissions = (invocationToolOperations ?? [])
    .filter((operation) => operation.toolName === "resubmit_existing_asset" && toolOperationSucceeded(operation))
    .map((operation) => operation.path).filter((path) => after.has(path));
  const candidateChangedPaths = options.authoritativeWorkspace || !invocationChangedPaths
    ? [...new Set([...workspaceChangedPaths, ...explicitResubmissions])].sort()
    : [...new Set([...invocationChangedPaths, ...failedMutationPaths])].filter((path) => after.has(path)).sort();
  const changedPaths = candidateChangedPaths
    .filter((path) => !readOnlyOperationPaths.has(path) || before.get(path)?.hash !== after.get(path)?.hash)
    .filter((path) => !failedOnlyOperationPaths.has(path) || failedMutationPaths.includes(path));
  const deletedPaths = [...before.keys()].filter((path) => !after.has(path)).sort();
  const protectedMutationPaths = changedPaths.filter((path) => {
    if (!isQaHarnessManagedPath(path)) return false;
    return invocationToolOperations
      ?.filter((operation) =>
        operation.path === path && toolOperationSucceeded(operation) && operationWritesWorkspace(operation)
      )
      .at(-1)?.toolName !== "run_playtest";
  });
  const violations = [
    ...changedPaths.filter((path) => !isAllowedAgentPath(kernel, task, agent, path)).map((path) => `未授权写入：${path}`),
    ...protectedMutationPaths.map((path) => `受保护 QA 机器证据被非 run_playtest 工具修改：${path}`),
    ...failedMutationPaths.map((path) => `失败工具仍修改了工作区，拒绝物化：${path}`),
    ...deletedPaths.map((path) => `删除：${path}`)
  ];
  return { changedPaths, deletedPaths, violations };
}

/** A failed build is not a successful output, but its server-written diagnostic
 * is intentional evidence, not an unauthorized partial game mutation. Keep it
 * and prior successful work while preserving bridgeOk=false and failed tools.
 * Never accept failed scene/source/asset writes through this exception. */
function isFailedCocosDiagnostic(operation: AgentHarnessToolOperation, file?: WorkspaceFileEvidence): boolean {
  if (!file || operation.status !== "failed" || operation.bridgeOk !== false ||
      operation.hash !== file.hash || operation.sizeBytes !== file.sizeBytes || !operation.operationId) return false;
  const kinds: Record<string, { type: string; root: string }> = {
    cocos_validate_project: { type: "validate_project", root: "validation" },
    cocos_import_assets: { type: "import_assets", root: "imports" },
    cocos_apply_blueprint: { type: "apply_scene_blueprint", root: "scene-ops" },
    cocos_build: { type: "build", root: "build-ops" }
  };
  const kind = kinds[operation.toolName];
  if (!kind || operation.operationType !== kind.type || !/^cocos_[a-z]+_\d{14}_[a-f0-9]{8}$/.test(operation.operationId)) return false;
  if (kind.type === "build" && file.path === `agents/cocos-automation/cocos-build-logs/${operation.operationId}.log`) return true;
  try {
    const document = JSON.parse(readFileSync(file.absolutePath, "utf8"));
    if (document.operationId !== operation.operationId || document.operationType !== kind.type || document.status !== "failed") return false;
    return file.path === `agents/cocos-automation/${kind.root}/${operation.operationId}.json` ||
      (kind.type === "build" && typeof document.outputPath === "string" &&
        file.path === `${document.outputPath}/build-report.json`);
  } catch { return false; }
}

function failedHarnessToolExecutions(
  invocationToolOperations?: AgentHarnessToolOperation[]
): ToolExecutionResult[] {
  return (invocationToolOperations ?? []).flatMap((operation) => {
    if (toolOperationSucceeded(operation) || !failedToolExecutionName(operation.toolName)) return [];
    return [{
      toolName: operation.toolName,
      status: "failed" as const,
      path: operation.path,
      ...(operation.error ? { error: operation.error } : {})
    }];
  });
}

export function attachHarnessEvidenceToMessage(message: StudioMessage, evidence: HarnessEvidenceResult): StudioMessage {
  message.relatedArtifactIds = [...new Set([...message.relatedArtifactIds, ...evidence.artifactIds])];
  message.metadata = {
    ...message.metadata,
    harnessChangedPaths: evidence.changedPaths,
    harnessDeletedPaths: evidence.deletedPaths,
    harnessViolations: evidence.violations,
    toolExecutions: evidence.toolExecutions
  };
  return message;
}

function walkDirectory(root: string, directory: string, files: WorkspaceSnapshot): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Harness 工作区拒绝符号链接：${relative(root, directory).split(sep).join("/")}/${entry.name}`);
    }
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) {
      continue;
    }
    const path = relative(root, join(directory, entry.name)).split(sep).join("/");
    const absolutePath = resolvePathWithinRoot(root, path, {
      allowMissing: false,
      label: "Harness 工作区路径"
    }).absolutePath;
    if (entry.isDirectory()) {
      walkDirectory(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile() || isGeneratedWorkspaceFile(path)) {
      continue;
    }
    const stats = statSync(absolutePath);
    files.set(path, {
      path,
      absolutePath,
      hash: hashWorkspaceFile(absolutePath),
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString()
    });
  }
}

function isGeneratedWorkspaceFile(path: string): boolean {
  return generatedWorkspaceFiles.has(path) || /(^|\/)workspace-summary\.md$/.test(path);
}

function findArtifactForPath(kernel: StudioKernel, task: Task, path: string): Artifact | undefined {
  const artifacts = kernel.listArtifacts();
  const exact = artifacts.find((artifact) => artifactFilePath(artifact).replaceAll("\\", "/") === path || artifact.path === path);
  if (exact) {
    return exact;
  }
  return task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact && path.startsWith(`${artifact.path.replace(/\/+$/, "")}/`));
}

function isAllowedAgentPath(kernel: StudioKernel, task: Task, agent: AgentContract, path: string): boolean {
  try {
    assertAgentPathAuthorized(kernel, agent, task, path, "write");
    return true;
  } catch {
    return false;
  }
}

function toolOperationSucceeded(operation: AgentHarnessToolOperation): boolean {
  return operation.status !== "failed" && operation.bridgeOk !== false;
}

function operationWritesWorkspace(operation: AgentHarnessToolOperation): boolean {
  return operation.access !== "read";
}

function generatedMediaReceiptMatchesFile(
  operation: AgentHarnessToolOperation,
  file: WorkspaceFileEvidence
): boolean {
  return Boolean(
    typeof operation.hash === "string" &&
    operation.hash === file.hash &&
    typeof operation.sizeBytes === "number" &&
    operation.sizeBytes === file.sizeBytes
  );
}

function requiredOperationString(value: unknown, field: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`generate_raster_asset ${path} 缺少服务端 ${field} 收据。`);
  }
  return value;
}

function failedToolExecutionName(
  value: string
): value is ToolExecutionResult["toolName"] {
  return ["write_artifact", "append_document", "generate_raster_asset", "inspect_visual_assets",
    "cocos_validate_project", "cocos_import_assets", "cocos_apply_blueprint", "cocos_build"].includes(value);
}
