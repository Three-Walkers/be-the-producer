import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { defaultAgentContracts, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentContract, AgentId, AgentLoopControl, Artifact, ArtifactStatus, StudioMessage, Task, TaskId } from "@game-pipeline/shared-schemas";
import { runImplementationChecks } from "./implementationChecks.js";
import { selfCheckPath, implementationReviewPath, validateImplementationReview, applyImplementationReviewFeedback } from "./implementationReview.js";
import { parseRasterNormalization } from "./rasterNormalization.js";
import {
  readArtifactContentForModel,
  resolveWorkspacePathTarget,
  writeToolArtifactBinaryContent,
  writeToolArtifactContent
} from "./workspaceWriter.js";
import { rasterizeSvgFile } from "./svgRasterizer.js";
import { resolveProjectWorkspaceRoot } from "./workspaceWriter.js";
import { CocosEngineBridge } from "./cocosEngineBridge.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { CocosPlaytestHarness } from "./cocosPlaytestHarness.js";
import { assertQaEvidenceWriteAllowed } from "./qaEvidenceProtection.js";
import { assertContractArtifactContent, assertContractRevisionAdvance, isContractArtifactType } from "./contractArtifacts.js";
import { assertProjectContractCompatibility } from "./projectContracts.js";
import {
  assertAgentPathAuthorized,
  authorizeAgentToolRequest,
  normalizeAuthorizationPath
} from "./toolAuthorization.js";
import { artifactReadyForConsumption, captureCurrentTaskInputProvenance } from "./taskOutputEvidence.js";
import { modelSettingsStore } from "./modelSettings.js";
import {
  composeEffectiveImageGenerationPrompt,
  DashScopeMultimodalArtProvider,
  type ArtImageMime
} from "./multimodalArtProvider.js";
import {
  applyQualityReviewChangeRequest,
  assertQualityReviewEvidenceGrounded,
  assertQualityReviewVisionMetadataBound,
  assertQualityReviewTargetsCurrent,
  buildCurrentVisionReviewAuthoritativeContext,
  currentGeneratedRuntimeAssetPathsForReview,
  linkGeneratedRuntimeAssetToVisualReview,
  mergeVisionSemanticInspectionReceipts,
  qualityReviewContractForArtifact,
  readVisionSemanticInspectionReceipts,
  stampAndValidateQualityReviewText
} from "./qualityReviewArtifacts.js";
import { parseCurrentAssetManifestText } from "./assetManifestArtifacts.js";
import {
  bindMediaGenerationArtifactMetadata,
  hasCurrentGenerateRasterAssetReceipt,
  mediaGenerationOperationMetadata,
  pickVisionReceiptMetadata,
  stripPrivilegedMaterializationMetadata
} from "./mediaArtifactEvidence.js";

export type ExecutableToolName =
  | "write_artifact"
  | "append_document"
  | "write_code"
  | "run_typecheck"
  | "run_implementation_checks"
  | "generate_image"
  | "generate_raster_asset"
  | "inspect_visual_assets"
  | "render_svg_to_png"
  | "cocos_validate_project"
  | "cocos_import_assets"
  | "cocos_apply_blueprint"
  | "cocos_build"
  | "run_playtest"
  | "write_asset_manifest"
  | "create_scene_blueprint"
  | "create_bug_report"
  | "create_release_gate"
  | "create_deploy_plan"
  | "create_rollback_plan"
  | "prepare_upload_report"
  | "write_redacted_log"
  | "create_iteration_backlog"
  | "define_analytics_events";

interface ToolRequest {
  toolName: ExecutableToolName;
  path: string;
  content: string;
  sourcePath?: string;
  width?: number;
  artifactId?: string;
  artifactType?: Artifact["type"];
  artifactTypeExplicit?: boolean;
  artifactTypeInvalid?: boolean;
  taskId?: TaskId;
  status?: ArtifactStatus;
  arguments?: Record<string, unknown>;
}

export interface ToolExecutionResult {
  toolName: ExecutableToolName;
  status: "completed" | "failed";
  path?: string;
  artifactId?: string;
  hash?: string;
  sizeBytes?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface ToolExecutionActivityEvent {
  type: "started" | "completed" | "failed";
  toolName: ExecutableToolName;
  path?: string;
  progressPercent?: number;
}

export interface ToolExecutionOptions {
  onActivity?: (message: StudioMessage, event: ToolExecutionActivityEvent) => void;
}

const artifactTypes: Artifact["type"][] = [
  "gdd",
  "game_contract",
  "art_bible",
  "asset_spec",
  "asset",
  "asset_manifest",
  "scene_blueprint",
  "playtest_contract",
  "source_code",
  "build",
  "qa_report",
  "quality_review",
  "bug_report",
  "deployment_plan",
  "deployment_report",
  "rollback_plan",
  "release_notes"
];

const artifactStatuses: ArtifactStatus[] = ["draft", "submitted", "review", "approved", "change_requested", "rejected", "superseded"];
const executableToolNames: ExecutableToolName[] = [
  "write_artifact",
  "append_document",
  "write_code",
  "run_typecheck",
  "run_implementation_checks",
  "generate_image",
  "generate_raster_asset",
  "inspect_visual_assets",
  "render_svg_to_png",
  "cocos_validate_project",
  "cocos_import_assets",
  "cocos_apply_blueprint",
  "cocos_build",
  "run_playtest",
  "write_asset_manifest",
  "create_scene_blueprint",
  "create_bug_report",
  "create_release_gate",
  "create_deploy_plan",
  "create_rollback_plan",
  "prepare_upload_report",
  "write_redacted_log",
  "create_iteration_backlog",
  "define_analytics_events"
];
const loopControlStatuses: AgentLoopControl["status"][] = ["continue", "waiting_for_producer", "handoff", "ready_for_review", "blocked"];

export function executableToolsForAgent(agent: AgentContract): ExecutableToolName[] {
  const tools = executableToolNames.filter((toolName) => agent.tools.includes(toolName));
  if (agent.tools.includes("write_artifact") && !tools.includes("append_document")) {
    tools.push("append_document");
  }
  return tools;
}

export async function executeAgentToolRequests(
  kernel: StudioKernel,
  messages: StudioMessage[],
  options: ToolExecutionOptions = {}
): Promise<ToolExecutionResult[]> {
  const results: ToolExecutionResult[] = [];
  for (const message of messages) {
    if (message.senderType !== "agent") {
      continue;
    }

    const agent = defaultAgentContracts.find((candidate) => candidate.agentId === message.senderId);
    if (!agent) {
      continue;
    }

    const extracted = extractToolRequests(message.content, agent);
    if (extracted.requests.length === 0 && !extracted.loopControl) {
      continue;
    }

    const messageResults: ToolExecutionResult[] = [];
    const artifactIds = new Set(message.relatedArtifactIds);
    for (let index = 0; index < extracted.requests.length; index += 1) {
      const request = extracted.requests[index];
      if (!request) continue;
      const total = extracted.requests.length;
      emitToolActivity(options, message, {
        type: "started",
        toolName: request.toolName,
        path: request.path,
        progressPercent: Math.round(84 + (index / total) * 12)
      });
      const result = await executeToolRequest(kernel, message, agent, request);
      emitToolActivity(options, message, {
        type: result.status === "completed" ? "completed" : "failed",
        toolName: result.toolName,
        ...(result.path ? { path: result.path } : {}),
        progressPercent: Math.round(84 + ((index + 1) / total) * 12)
      });
      messageResults.push(result);
      results.push(result);
      if (result.artifactId) {
        artifactIds.add(result.artifactId);
      }
    }

    message.relatedArtifactIds = [...artifactIds];
    message.content = messageResults.length > 0 ? renderToolExecutedMessage(extracted.displayContent, messageResults) : extracted.displayContent;
    message.metadata = {
      ...message.metadata,
      toolRequestsParsed: extracted.requests.length,
      toolExecutions: messageResults,
      ...(extracted.loopControl ? { loopControl: extracted.loopControl } : {})
    };
  }

  return results;
}

function emitToolActivity(options: ToolExecutionOptions, message: StudioMessage, event: ToolExecutionActivityEvent): void {
  try {
    options.onActivity?.(message, event);
  } catch {
    // Progress telemetry must not change the result of the tool invocation.
  }
}

async function executeToolRequest(kernel: StudioKernel, message: StudioMessage, agent: AgentContract, request: ToolRequest): Promise<ToolExecutionResult> {
  try {
    assertToolAllowed(agent, request.toolName);
    const now = new Date().toISOString();
    if (request.artifactTypeInvalid) {
      throw new Error(`无效的显式 artifactType：${request.artifactType ?? "unknown"}。`);
    }
    const path = normalizeToolPath(request.path, agent);
    const authorization = authorizeAgentToolRequest(kernel, message, agent, {
      toolName: request.toolName,
      path,
      ...(request.artifactId ? { artifactId: request.artifactId } : {}),
      ...(request.artifactType ? { artifactType: request.artifactType } : {}),
      ...(request.artifactTypeExplicit ? { artifactTypeExplicit: true } : {}),
      ...(request.taskId ? { requestedTaskId: request.taskId } : {}),
      access: toolPathAccess(request.toolName)
    });
    assertAuxiliaryToolPathsAuthorized(kernel, agent, authorization.task, request);
    if (request.toolName.startsWith("cocos_")) {
      return executeCocosBridgeTool(kernel, message, agent, request, now, authorization.sourceTaskId);
    }
    if (request.toolName === "run_playtest") {
      return executePlaytestTool(kernel, message, agent, request, now, authorization.sourceTaskId);
    }
    if (request.toolName === "run_typecheck") {
      return runTypeScriptSemanticCheck(kernel.project.projectId, path);
    }
    if (request.toolName === "run_implementation_checks") {
      const checks = runImplementationChecks(resolveProjectWorkspaceRoot(kernel.project.projectId), cocosEngineSettingsStore.getResolvedConfig().executablePath);
      const output = agent.agentId === "gameplay_programmer" ? kernel.listArtifacts().find((artifact) => authorization.task.outputArtifacts.includes(artifact.artifactId) && artifact.path === selfCheckPath) : undefined;
      if (!output) return { toolName: request.toolName, status: "completed", path, details: { ...checks } };
      assertAgentPathAuthorized(kernel, agent, authorization.task, output.path, "write");
      const artifact = kernel.upsertArtifact({ ...output, status: "submitted", version: output.version + 1,
        metadata: { nativeHarnessManaged: true, toolName: request.toolName, toolExecutedAt: now }, updatedAt: now });
      const result = writeToolArtifactContent(kernel, artifact, { content: JSON.stringify(checks, null, 2), mode: "replace" });
      kernel.recordArtifactMaterialization(artifact.artifactId, { path: artifact.path, hash: result.hash, sizeBytes: result.sizeBytes,
        materializedAt: result.materializedAt, operationMetadata: { implementationVerificationHash: result.hash, implementationVerificationTool: request.toolName } });
      return { toolName: request.toolName, status: "completed", path: artifact.path, artifactId: artifact.artifactId,
        hash: result.hash, sizeBytes: result.sizeBytes, details: { ...checks } };
    }
    if (path === selfCheckPath) throw new Error("Self-check reports are server-owned. Call run_implementation_checks; ordinary text writes cannot forge verification evidence.");
    if (request.toolName === "generate_raster_asset") {
      return await executeRasterAssetGeneration(
        kernel,
        message,
        agent,
        request,
        path,
        now,
        authorization.sourceTaskId,
        authorization.existing
      );
    }
    if (request.toolName === "inspect_visual_assets") {
      return await executeVisualAssetInspection(kernel, message, agent, authorization.task, request, now);
    }
    if (request.toolName === "generate_image") {
      assertSvgImage(path, request.content);
    }
    const sourceTaskId = authorization.sourceTaskId;
    const existing = authorization.existing;
    const artifactType = existing?.type ?? request.artifactType ?? inferArtifactType(agent.agentId, path);
    let implementationReview: ReturnType<typeof validateImplementationReview> | undefined;
    if (path === implementationReviewPath) {
      if (agent.agentId !== "qa_evaluator" || request.toolName === "append_document") throw new Error("Independent implementation review must be submitted by QA as a complete JSON document.");
      const root = resolveProjectWorkspaceRoot(kernel.project.projectId);
      const checks = runImplementationChecks(root, cocosEngineSettingsStore.getResolvedConfig().executablePath);
      implementationReview = validateImplementationReview(root, JSON.parse(request.content), checks);
      request.content = JSON.stringify(implementationReview, null, 2);
    }
    let qualityReview: ReturnType<typeof stampAndValidateQualityReviewText>["review"] | undefined;
    if (artifactType === "quality_review") {
      const stamped = stampAndValidateQualityReviewText(request.content, {
        reviewerAgentId: agent.agentId,
        providerId: stringMetadata(message.metadata.providerId) ?? "unknown-provider",
        model: stringMetadata(message.metadata.model) ?? "unknown-model",
        invocationId: stringMetadata(message.metadata.invocationId) ?? message.messageId,
        reviewedAt: now
      });
      const contract = qualityReviewContractForArtifact(existing?.artifactId ?? request.artifactId ?? "");
      if (!contract) {
        throw new Error("质量审查必须写入当前任务预登记的 canonical quality_review 产物。");
      }
      assertQualityReviewTargetsCurrent(kernel, stamped.review, contract);
      const additionalEvidencePaths = stamped.review.domain === "visual_assets"
        ? currentGeneratedRuntimeAssetPathsForReview(kernel, stamped.review)
        : [];
      assertQualityReviewEvidenceGrounded(kernel, stamped.review, additionalEvidencePaths);
      if (stamped.review.domain !== "design") {
        if (!existing) throw new Error("视觉质量审查必须写入已预登记的 canonical artifact。");
        assertQualityReviewVisionMetadataBound(kernel, existing, stamped.review, contract);
      }
      request.content = stamped.content;
      qualityReview = stamped.review;
    }
    if (artifactType === "asset_manifest") {
      if (request.toolName === "append_document") {
        throw new Error("Asset Manifest 只能整份替换，禁止 append_document。");
      }
      parseCurrentAssetManifestText(request.content);
    }
    assertContractArtifactContent(artifactType, request.content, request.toolName === "append_document" ? "append" : "write");
    if (isContractArtifactType(artifactType)) {
      const previousContent = existing?.metadata.toolExecutedAt
        ? readArtifactContentForModel(kernel.project.projectId, existing, 2_000_000) ?? stringMetadata(existing.metadata.toolContent)
        : undefined;
      assertContractRevisionAdvance(artifactType, previousContent, request.content);
      assertProjectContractCompatibility(kernel, artifactType, request.content);
    }
    assertQaEvidenceWriteAllowed(path, request.toolName);
    if (request.toolName === "render_svg_to_png") {
      return executeSvgRasterization(kernel, message, agent, request, path, now, sourceTaskId, existing);
    }
    const artifact: Artifact = {
      artifactId: existing?.artifactId ?? request.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, path),
      projectId: kernel.project.projectId,
      type: artifactType,
      path,
      ownerAgentId: agent.agentId,
      stageId: kernel.project.currentStage,
      status: nextMaterializedArtifactStatus(request.status, existing?.status),
      version: existing ? existing.version + 1 : 1,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      sourceDecisionIds: existing?.sourceDecisionIds ?? [],
      metadata: {
        ...stripPrivilegedMaterializationMetadata(existing?.metadata ?? {}),
        ...(qualityReview?.domain !== "design" && existing
          ? pickVisionReceiptMetadata(existing.metadata)
          : {}),
        toolName: request.toolName,
        toolSourceMessageId: message.messageId,
        toolExecutedAt: now,
        toolWriteMode: writeMode(request.toolName),
        toolContent: request.content,
        ...(qualityReview
          ? {
              reviewProviderId: qualityReview.modelTrace.providerId,
              reviewModel: qualityReview.modelTrace.model,
              reviewInvocationId: qualityReview.modelTrace.invocationId,
              reviewPromptVersion: qualityReview.modelTrace.promptVersion,
              qualityReviewDomain: qualityReview.domain,
              qualityReviewVerdict: qualityReview.verdict,
              qualityReviewScore: qualityReview.scoreTotal
            }
          : {})
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    const registered = kernel.upsertArtifact(artifact);
    // StudioKernel merges metadata for ordinary updates.  A new materializing
    // tool operation instead uses the sanitized server view above so receipts
    // from the previous bytes cannot survive by omission.
    registered.metadata = artifact.metadata;
    const writeResult = writeToolArtifactContent(kernel, registered, {
      content: request.content,
      mode: writeMode(request.toolName)
    });
    const materialized = kernel.upsertArtifact({
      ...artifact,
      metadata: {
        ...artifact.metadata,
        toolContent: writeResult.content,
        toolHash: writeResult.hash,
        toolSizeBytes: writeResult.sizeBytes,
        toolMaterializedAt: writeResult.materializedAt
      },
      updatedAt: writeResult.materializedAt
    });
    kernel.recordArtifactMaterialization(materialized.artifactId, {
      path: writeResult.relativePath,
      hash: writeResult.hash,
      sizeBytes: writeResult.sizeBytes,
      materializedAt: writeResult.materializedAt,
      ...(implementationReview ? { operationMetadata: { implementationVerificationHash: writeResult.hash, implementationVerificationTool: request.toolName } } : {})
    });
    if (implementationReview) applyImplementationReviewFeedback(kernel, materialized, implementationReview);
    if (qualityReview) {
      applyQualityReviewChangeRequest(kernel, materialized, qualityReview, writeResult.materializedAt);
    }

    return {
      toolName: request.toolName,
      status: "completed",
      path: writeResult.relativePath,
      artifactId: registered.artifactId,
      hash: writeResult.hash,
      sizeBytes: writeResult.sizeBytes
    };
  } catch (error) {
    return {
      toolName: request.toolName,
      status: "failed",
      path: request.path,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function executePlaytestTool(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  request: ToolRequest,
  now: string,
  sourceTaskId: TaskId
): Promise<ToolExecutionResult> {
  const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
  const args = request.arguments ?? {};
  const registeredReportPath = sourceTaskId
    ? kernel.findTask(sourceTaskId)?.outputArtifacts
        .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
        .find((artifact) => artifact?.type === "qa_report")?.path
    : undefined;
  const result = await new CocosPlaytestHarness(projectRoot, cocosEngineSettingsStore.getResolvedConfig()).run({
    ...(typeof args.maxDurationSec === "number" ? { maxDurationSec: args.maxDurationSec } : {}),
    ...(registeredReportPath ? { reportPath: registeredReportPath } : {}),
    ...(sourceTaskId && kernel.findTask(sourceTaskId)
      ? { taskInputEvidence: captureCurrentTaskInputProvenance(kernel, kernel.findTask(sourceTaskId) as Task) }
      : {})
  });
  const taskOutputIds = sourceTaskId ? kernel.findTask(sourceTaskId)?.outputArtifacts ?? [] : [];
  let primary: ToolExecutionResult | undefined;
  for (const item of result.evidence) {
    if (item.path !== result.reportPath && !item.path.startsWith("agents/qa/playtest-runs/")) continue;
    const existing = kernel.listArtifacts().find((artifact) =>
      artifact.path === item.path || (taskOutputIds.includes(artifact.artifactId) && item.path === result.reportPath)
    );
    const artifact = kernel.upsertArtifact({
      artifactId: existing?.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, item.path),
      projectId: kernel.project.projectId,
      type: existing?.type ?? inferArtifactType(agent.agentId, item.path),
      path: existing?.path ?? item.path,
      ownerAgentId: agent.agentId,
      stageId: kernel.project.currentStage,
      status: result.verdict === "pass" ? "submitted" : "change_requested",
      version: existing ? existing.version + 1 : 1,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      sourceDecisionIds: existing?.sourceDecisionIds ?? [],
      metadata: {
        ...stripPrivilegedMaterializationMetadata(existing?.metadata ?? {}),
        toolName: request.toolName,
        toolSourceMessageId: message.messageId,
        toolExecutedAt: now,
        playtestOperationId: result.operationId,
        ...(item.path !== result.reportPath ? { evidenceRole: "supporting" } : {}),
        playtestVerdict: result.verdict,
        playtestChecks: result.checks,
        playtestDefects: result.defects,
        playtestEvidencePaths: result.evidencePaths,
        playtestRuntime: result.runtime,
        ...(result.schemaVersion === 2 ? { playtestSchemaVersion: 2 } : {}),
        ...(result.contract ? { playtestContract: result.contract } : {}),
        ...(result.scenarios ? { playtestScenarios: result.scenarios } : {}),
        playtestTaskInputEvidence: sourceTaskId && kernel.findTask(sourceTaskId)
          ? captureCurrentTaskInputProvenance(kernel, kernel.findTask(sourceTaskId) as Task)
          : []
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    kernel.recordArtifactMaterialization(artifact.artifactId, {
      path: item.path,
      hash: item.hash,
      sizeBytes: item.sizeBytes,
      materializedAt: now
    });
    if (item.path === result.reportPath) {
      primary = {
        toolName: "run_playtest",
        status: "completed",
        path: item.path,
        artifactId: artifact.artifactId,
        hash: item.hash,
        sizeBytes: item.sizeBytes,
        details: {
          operationId: result.operationId,
          verdict: result.verdict,
          defectCount: result.defects.length,
          evidencePaths: result.evidencePaths
        }
      };
    }
  }
  if (!primary) {
    throw new Error(`试玩 ${result.operationId} 没有生成主 QA 报告。`);
  }
  return primary;
}

async function executeRasterAssetGeneration(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  request: ToolRequest,
  path: string,
  now: string,
  sourceTaskId: TaskId,
  existing?: Artifact
): Promise<ToolExecutionResult> {
  if (!path.toLowerCase().endsWith(".png")) {
    throw new Error("generate_raster_asset 只物化 PNG；目标 path 必须以 .png 结尾。");
  }
  const args = request.arguments ?? {};
  const prompt = stringValue(args.prompt) || request.content.trim();
  if (!prompt) throw new Error("generate_raster_asset 必须提供 prompt。");
  const referencePaths = Array.isArray(args.referencePaths)
    ? args.referencePaths.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  if (referencePaths.length > 3) {
    throw new Error("generate_raster_asset 最多接受 3 个 task-bound referencePaths。");
  }
  const referenceImageDataUrls = referencePaths.map((referencePath) => {
    const target = resolveWorkspacePathTarget(kernel.project.projectId, normalizeAuthorizationPath(referencePath));
    if (!target.exists || target.type !== "file") throw new Error(`参考图片不存在：${referencePath}`);
    const mime = imageMimeForPath(referencePath);
    const bytes = readFileSync(target.absolutePath);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(`参考图片超过 10MiB：${referencePath}`);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  });
  const size = normalizeGeneratedImageSize(args.size, args.width, args.height);
  const seed = typeof args.seed === "number" && Number.isInteger(args.seed) ? args.seed : undefined;
  const [requestedWidth, requestedHeight] = size.split("*").map(Number);
  const negativePrompt = stringValue(args.negativePrompt);
  const imageModel = process.env.BTP_IMAGE_GENERATION_MODEL ?? "wan2.7-image-pro";
  const effectivePrompt = composeEffectiveImageGenerationPrompt(imageModel, prompt.trim(), negativePrompt.trim());
  const promptHash = createHash("sha256").update(effectivePrompt).digest("hex");
  const negativePromptHash = createHash("sha256").update(negativePrompt.trim()).digest("hex");
  const recordedReferencePaths = Array.isArray(existing?.metadata.mediaReferencePaths)
    ? existing.metadata.mediaReferencePaths.filter((value): value is string => typeof value === "string")
    : [];
  const existingLedger = existing
    ? kernel.listArtifactLedger().find((entry) => entry.artifactId === existing.artifactId)
    : undefined;
  if (
    existing && args.normalization === undefined &&
    existingLedger?.hash &&
    existingLedger.sizeBytes !== undefined &&
    artifactReadyForConsumption(kernel, existing.artifactId) &&
    hasCurrentGenerateRasterAssetReceipt(kernel, existing) &&
    existing.metadata.mediaPromptHash === promptHash &&
    existing.metadata.mediaNegativePromptHash === negativePromptHash &&
    existing.metadata.mediaWidth === requestedWidth &&
    existing.metadata.mediaHeight === requestedHeight &&
    (seed === undefined || existing.metadata.mediaSeed === seed) &&
    recordedReferencePaths.length === referencePaths.length &&
    recordedReferencePaths.every((value, index) => value === referencePaths[index])
  ) {
    return {
      toolName: request.toolName,
      status: "completed",
      path: existing.path,
      artifactId: existing.artifactId,
      hash: existingLedger.hash,
      sizeBytes: existingLedger.sizeBytes,
      details: {
        provider: existing.metadata.mediaProvider,
        model: existing.metadata.mediaModel,
        requestId: existing.metadata.mediaRequestId,
        seed: existing.metadata.mediaSeed,
        width: existing.metadata.mediaWidth,
        height: existing.metadata.mediaHeight,
        promptHash,
        reused: true
      }
    };
  }
  const provider = createConfiguredMultimodalArtProvider();
  const generated = await provider.generateImage({
    normalization: parseRasterNormalization(args.normalization),
    prompt,
    size,
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(referenceImageDataUrls.length > 0 ? { referenceImageDataUrls } : {})
  });
  const artifactType = existing?.type ?? request.artifactType ?? "asset";
  if (artifactType !== "asset") {
    throw new Error(`generate_raster_asset 只能物化 asset，当前类型是 ${artifactType}。`);
  }
  const artifact: Artifact = {
    artifactId: existing?.artifactId ?? request.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, path),
    projectId: kernel.project.projectId,
    type: "asset",
    path,
    ownerAgentId: agent.agentId,
    stageId: kernel.project.currentStage,
    status: nextMaterializedArtifactStatus(request.status, existing?.status),
    version: existing ? existing.version + 1 : 1,
    sourceTaskId,
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: {
      ...stripPrivilegedMaterializationMetadata(existing?.metadata ?? {}),
      generatedBy: "dashscope_multimodal_art_provider",
      toolName: request.toolName,
      toolSourceMessageId: message.messageId,
      toolExecutedAt: now,
      mediaProvider: generated.provider,
      mediaModel: generated.model,
      mediaRequestId: generated.requestId,
      mediaEndpointFingerprint: generated.endpointFingerprint,
      mediaPromptHash: generated.promptHash,
      mediaNegativePromptHash: generated.negativePromptHash,
      mediaSeed: generated.seed,
      mediaMime: generated.mime,
      mediaWidth: generated.width,
      mediaHeight: generated.height,
      mediaLatencyMs: generated.latencyMs,
      mediaNormalizationReceipt: generated.normalizationReceipt,
      mediaReferencePaths: referencePaths,
      mediaReviewStatus: "pending_independent_review"
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  const writeResult = writeToolArtifactBinaryContent(kernel, artifact, generated.buffer);
  const registered = kernel.upsertArtifact({ ...artifact, updatedAt: writeResult.materializedAt });
  registered.metadata = artifact.metadata;
  const materialization = kernel.recordArtifactMaterialization(registered.artifactId, {
    path: writeResult.relativePath,
    hash: writeResult.hash,
    sizeBytes: writeResult.sizeBytes,
    materializedAt: writeResult.materializedAt,
    operationMetadata: mediaGenerationOperationMetadata({
      normalizationReceipt: generated.normalizationReceipt,
      hash: writeResult.hash,
      sizeBytes: writeResult.sizeBytes,
      provider: generated.provider,
      model: generated.model,
      requestId: generated.requestId,
      promptHash: generated.promptHash
    })
  });
  const bound = kernel.upsertArtifact({
    ...registered,
    metadata: bindMediaGenerationArtifactMetadata(
      registered.metadata,
      materialization.sourceOperationId,
      { hash: writeResult.hash, sizeBytes: writeResult.sizeBytes }
    ),
    updatedAt: writeResult.materializedAt
  });
  linkGeneratedRuntimeAssetToVisualReview(kernel, bound, writeResult.materializedAt);
  return {
    toolName: request.toolName,
    status: "completed",
    path: writeResult.relativePath,
    artifactId: registered.artifactId,
    hash: writeResult.hash,
    sizeBytes: writeResult.sizeBytes,
    details: {
      provider: generated.provider,
      model: generated.model,
      requestId: generated.requestId,
      seed: generated.seed,
      width: generated.width,
      height: generated.height,
      promptHash: generated.promptHash
    }
  };
}

async function executeVisualAssetInspection(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  task: Task,
  request: ToolRequest,
  now: string
): Promise<ToolExecutionResult> {
  const args = request.arguments ?? {};
  const paths = Array.isArray(args.paths)
    ? [...new Set(args.paths.filter((value): value is string => typeof value === "string" && Boolean(value.trim())))]
    : [];
  if (paths.length === 0 || paths.length > 16) {
    throw new Error("inspect_visual_assets 必须提供 1-16 个 task-bound 图片 paths。");
  }
  const inspectedEvidence: Array<{ path: string; hash: string; sizeBytes: number }> = [];
  const images = paths.map((path, index) => {
    const normalized = normalizeAuthorizationPath(path);
    const target = resolveWorkspacePathTarget(kernel.project.projectId, normalized);
    if (!target.exists || target.type !== "file") throw new Error(`待审图片不存在：${normalized}`);
    const buffer = readFileSync(target.absolutePath);
    inspectedEvidence.push({
      path: normalized,
      hash: createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.byteLength
    });
    paths[index] = normalized;
    return { path: normalized, mime: imageMimeForPath(normalized), buffer };
  });
  const rubricPrompt = stringValue(args.rubricPrompt) || request.content.trim();
  const reviewArtifact = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "quality_review");
  if (!reviewArtifact || reviewArtifact.ownerAgentId !== agent.agentId) {
    throw new Error(`任务 ${task.taskId} 没有由 ${agent.agentId} 拥有的 quality_review 输出。`);
  }
  const contract = qualityReviewContractForArtifact(reviewArtifact.artifactId);
  if (!contract || contract.ownerAgentId !== agent.agentId || contract.sourceTaskId !== task.taskId) {
    throw new Error(`任务 ${task.taskId} 没有可用的 canonical visual quality review contract。`);
  }
  const authoritativeContext = buildCurrentVisionReviewAuthoritativeContext(kernel, contract);
  const inspected = await createConfiguredMultimodalArtProvider().reviewImages({
    images,
    rubric: contract.rubric,
    authoritativeContext,
    rubricPrompt,
    systemPrompt:
      "你是独立的 Principal 2D Game Art Director 与移动技术美术。只依据真实图片像素和给定 rubric 审查，不因生成者自述而通过。返回严格 JSON，列出可观察证据、严重度、问题与建议；不要声称批准制作人门禁。"
  });
  const invocationId = stringMetadata(message.metadata.invocationId) ?? message.messageId;
  const previousReceipts = reviewArtifact.metadata.visionInspectionInvocationId === invocationId
    ? readVisionSemanticInspectionReceipts(reviewArtifact.metadata.visionInspectionSemanticReceipts)
    : [];
  const receipts = [
    ...previousReceipts,
    {
      invocationId,
      operationId: inspected.requestId,
      providerId: inspected.provider,
      model: inspected.model,
      paths: [...paths],
      evidence: inspectedEvidence,
      responseHash: inspected.rawHash,
      authoritativeContextEvidence: inspected.authoritativeContextEvidence,
      authoritativeContextHash: inspected.authoritativeContextHash,
      requestSemanticHash: inspected.requestSemanticHash,
      result: inspected.result
    }
  ];
  const merged = mergeVisionSemanticInspectionReceipts(receipts, contract);
  kernel.upsertArtifact({
    ...reviewArtifact,
    metadata: {
      ...reviewArtifact.metadata,
      visionInspectionOperationId: merged.operationId,
      visionInspectionProvider: merged.providerId,
      visionInspectionModel: merged.model,
      visionInspectionResponseHash: merged.responseHash,
      visionInspectionSemanticHash: merged.semanticHash,
      visionAuthoritativeContextEvidence: merged.authoritativeContextEvidence,
      visionAuthoritativeContextHash: merged.authoritativeContextHash,
      visionRequestSemanticHash: merged.requestSemanticHash,
      visionInspectionSemanticResult: merged.result,
      visionInspectionSemanticReceipts: receipts,
      visionInspectionLatencyMs: inspected.latencyMs,
      visionInspectionInvocationId: invocationId,
      visionInspectedPaths: merged.paths,
      visionInspectedEvidence: merged.evidence,
      visionInspectedAt: now
    },
    updatedAt: now
  });
  return {
    toolName: request.toolName,
    status: "completed",
    path: paths[0]!,
    hash: merged.responseHash,
    details: {
      provider: inspected.provider,
      model: inspected.model,
      requestId: inspected.requestId,
      operationId: merged.operationId,
      responseHash: merged.responseHash,
      semanticHash: merged.semanticHash,
      authoritativeContextEvidence: merged.authoritativeContextEvidence,
      authoritativeContextHash: merged.authoritativeContextHash,
      requestSemanticHash: merged.requestSemanticHash,
      paths: merged.paths,
      inspectedEvidence: merged.evidence,
      result: merged.result,
      latencyMs: inspected.latencyMs
    }
  };
}

function createConfiguredMultimodalArtProvider(): DashScopeMultimodalArtProvider {
  const provider = modelSettingsStore.getProviderConfig("dashscope");
  if (!provider.apiKey) throw new Error("DashScope API key 未配置，无法执行真实多模态美术工具。");
  const baseUrl = new URL(provider.baseUrl);
  const origin = baseUrl.origin;
  return new DashScopeMultimodalArtProvider({
    apiKey: provider.apiKey,
    imageEndpoint:
      process.env.BTP_IMAGE_GENERATION_ENDPOINT ??
      `${origin}/api/v1/services/aigc/multimodal-generation/generation`,
    visionEndpoint:
      process.env.BTP_VISION_REVIEW_ENDPOINT ??
      `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    imageModel: process.env.BTP_IMAGE_GENERATION_MODEL ?? "wan2.7-image-pro",
    visionModel: process.env.BTP_VISION_REVIEW_MODEL ?? "qwen3.8-max",
    allowedDownloadHostSuffixes: [".aliyuncs.com", ".aliyun.com"]
  });
}

function imageMimeForPath(path: string): ArtImageMime {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.webp$/i.test(path)) return "image/webp";
  throw new Error(`多模态美术工具只接受 PNG/JPEG/WebP：${path}`);
}

function normalizeGeneratedImageSize(size: unknown, width: unknown, height: unknown): string {
  if (typeof size === "string" && /^\d{3,4}\*\d{3,4}$/.test(size.trim())) return size.trim();
  if (
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height)
  ) {
    return `${width}*${height}`;
  }
  return "1024*1024";
}

function executeSvgRasterization(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  request: ToolRequest,
  path: string,
  now: string,
  sourceTaskId: TaskId | undefined,
  existing: Artifact | undefined
): ToolExecutionResult {
  if (!request.sourcePath) {
    throw new Error("render_svg_to_png 必须提供 sourcePath。");
  }
  const sourcePath = normalizeToolPath(request.sourcePath, agent);
  const source = resolveWorkspacePathTarget(kernel.project.projectId, sourcePath);
  if (!source.exists || source.type !== "file") {
    throw new Error(`SVG 源文件不存在：${sourcePath}`);
  }
  const target = resolveWorkspacePathTarget(kernel.project.projectId, path);
  const rendered = rasterizeSvgFile(source.absolutePath, target.absolutePath, request.width);
  const materializedAt = statSync(target.absolutePath).mtime.toISOString();
  const artifact: Artifact = {
    artifactId: existing?.artifactId ?? request.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, path),
    projectId: kernel.project.projectId,
    type: "asset",
    path,
    ownerAgentId: agent.agentId,
    stageId: kernel.project.currentStage,
    status: nextMaterializedArtifactStatus(request.status, existing?.status),
    version: existing ? existing.version + 1 : 1,
    ...(sourceTaskId ? { sourceTaskId } : {}),
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: {
      ...stripPrivilegedMaterializationMetadata(existing?.metadata ?? {}),
      toolName: request.toolName,
      toolSourceMessageId: message.messageId,
      toolExecutedAt: now,
      toolWriteMode: "render",
      sourcePath,
      outputWidth: rendered.width,
      outputHeight: rendered.height,
      toolHash: rendered.hash,
      toolSizeBytes: rendered.sizeBytes,
      toolMaterializedAt: materializedAt
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: materializedAt
  };
  const registered = kernel.upsertArtifact(artifact);
  registered.metadata = artifact.metadata;
  kernel.recordArtifactMaterialization(registered.artifactId, {
    path: target.relativePath,
    hash: rendered.hash,
    sizeBytes: rendered.sizeBytes,
    materializedAt
  });
  return {
    toolName: request.toolName,
    status: "completed",
    path: target.relativePath,
    artifactId: registered.artifactId,
    hash: rendered.hash,
    sizeBytes: rendered.sizeBytes
  };
}

function extractToolRequests(
  content: string,
  agent: AgentContract
): { requests: ToolRequest[]; displayContent: string; loopControl?: AgentLoopControl } {
  const requests: ToolRequest[] = [];
  const blocksToStrip: string[] = [];
  let loopControl: AgentLoopControl | undefined;
  const blockPattern = /```(?:json|tool|tool_request|tool_requests)?\s*([\s\S]*?)```/gi;

  for (const match of content.matchAll(blockPattern)) {
    const parsed = parseJson(match[1] ?? "");
    if (parsed === undefined) {
      continue;
    }

    const blockRequests = collectToolRequests(parsed, agent);
    const blockLoopControl = normalizeLoopControl(parsed);
    if (blockRequests.length === 0 && !blockLoopControl) {
      continue;
    }

    requests.push(...blockRequests);
    loopControl = blockLoopControl ?? loopControl;
    blocksToStrip.push(match[0]);
  }

  let displayContent = content;
  for (const block of blocksToStrip) {
    displayContent = displayContent.replace(block, "").trim();
  }

  return {
    requests,
    displayContent,
    ...(loopControl ? { loopControl } : {})
  };
}

function normalizeLoopControl(value: unknown): AgentLoopControl | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value.loopControl ?? value.loop_control ?? value.control;
  if (!isRecord(raw)) {
    return undefined;
  }
  const status = stringValue(raw.status) as AgentLoopControl["status"];
  if (!loopControlStatuses.includes(status)) {
    return undefined;
  }
  const handoffValue = raw.handoffAgentIds ?? raw.handoff_agent_ids ?? raw.handoffs;
  const handoffAgentIds = Array.isArray(handoffValue)
    ? handoffValue.map(stringValue).filter(Boolean)
    : stringValue(handoffValue)
      ? [stringValue(handoffValue)]
      : [];
  return {
    status,
    reason: stringValue(raw.reason) || defaultLoopControlReason(status),
    handoffAgentIds: [...new Set(handoffAgentIds)]
  };
}

function collectToolRequests(value: unknown, agent: AgentContract): ToolRequest[] {
  const objects = unwrapToolRequestObjects(value);
  const requests: ToolRequest[] = [];
  for (const object of objects) {
    const request = normalizeToolRequest(object, agent);
    if (request) {
      requests.push(request);
    }
  }
  return requests;
}

function unwrapToolRequestObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => unwrapToolRequestObjects(item));
  }
  if (!isRecord(value)) {
    return [];
  }

  const nested = [value.toolRequests, value.tool_requests, value.toolCalls, value.tool_calls, value.calls].find(Array.isArray);
  if (Array.isArray(nested)) {
    return nested.flatMap((item) => unwrapToolRequestObjects(item));
  }

  return [value];
}

function normalizeToolRequest(raw: Record<string, unknown>, agent: AgentContract): ToolRequest | undefined {
  const args = requestArgs(raw);
  const toolName = normalizeToolName(raw.tool ?? raw.toolName ?? raw.name ?? raw.functionName ?? raw.tool_name ?? raw.function);
  if (!toolName) {
    return undefined;
  }

  const path = stringValue(args.path ?? args.filePath ?? args.artifactPath ?? args.relativePath);
  const rawContent = args.content ?? args.body ?? args.markdown ?? args.text;
  const content = typeof rawContent === "string" ? rawContent : rawContent === undefined ? "" : JSON.stringify(rawContent, null, 2);
  const isServiceTool =
    toolName.startsWith("cocos_") ||
    toolName === "run_playtest" ||
    toolName === "run_implementation_checks" ||
    toolName === "generate_raster_asset" ||
    toolName === "inspect_visual_assets";
  if ((!path && !isServiceTool) || (!isServiceTool && !["run_typecheck", "render_svg_to_png"].includes(toolName) && !content.trim())) {
    return undefined;
  }

  const artifactId = stringValue(args.artifactId ?? args.artifact_id);
  const taskId = stringValue(args.taskId ?? args.task_id);
  const sourcePath = stringValue(args.sourcePath ?? args.source_path);
  const width = typeof args.width === "number" && Number.isFinite(args.width) ? args.width : undefined;
  const status = normalizeArtifactStatus(args.status);
  const rawArtifactType = args.artifactType ?? args.artifact_type ?? args.type;
  const explicitArtifactType = rawArtifactType !== undefined && stringValue(rawArtifactType) !== "";
  const normalizedArtifactType = normalizeArtifactType(rawArtifactType);
  return {
    toolName,
    path: path || (toolName === "run_implementation_checks" ? (agent.agentId === "gameplay_programmer" ? selfCheckPath : agent.agentId === "qa_evaluator" ? implementationReviewPath : "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json") : defaultServiceToolPath(toolName, args)),
    content,
    ...(isServiceTool ? { arguments: args } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(artifactId ? { artifactId } : {}),
    artifactType: normalizedArtifactType ?? inferArtifactType(agent.agentId, path),
    ...(explicitArtifactType ? { artifactTypeExplicit: true } : {}),
    ...(explicitArtifactType && !normalizedArtifactType ? { artifactTypeInvalid: true } : {}),
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {})
  };
}

function executeCocosBridgeTool(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  request: ToolRequest,
  now: string,
  sourceTaskId: TaskId
): ToolExecutionResult {
  const bridge = new CocosEngineBridge(resolveProjectWorkspaceRoot(kernel.project.projectId), cocosEngineSettingsStore.getResolvedConfig());
  const args = request.arguments ?? {};
  const result = request.toolName === "cocos_validate_project"
    ? bridge.validateProject()
    : request.toolName === "cocos_import_assets"
      ? bridge.importAssets({ ...(stringValue(args.manifestPath) ? { manifestPath: stringValue(args.manifestPath) } : {}) })
      : request.toolName === "cocos_apply_blueprint"
        ? bridge.applySceneBlueprint({
            ...(stringValue(args.blueprintPath) ? { blueprintPath: stringValue(args.blueprintPath) } : {}),
            ...(stringValue(args.scenePath) ? { scenePath: stringValue(args.scenePath) } : {})
          })
        : bridge.build({
            ...(args.platform === "wechatgame" ? { platform: "wechatgame" as const } : {}),
            ...(typeof args.debug === "boolean" ? { debug: args.debug } : {}),
            ...(stringValue(args.outputDir) ? { outputDir: stringValue(args.outputDir) } : {}),
            ...(stringValue(args.configPath) ? { configPath: stringValue(args.configPath) } : {})
          });

  const primaryEvidence = result.evidence.find((entry) => entry.path === result.reportPath) ?? result.evidence.at(-1);
  if (!primaryEvidence) {
    throw new Error(`Cocos Bridge 没有返回可登记证据：${result.operationId}`);
  }
  const taskOutputIds = sourceTaskId ? kernel.findTask(sourceTaskId)?.outputArtifacts ?? [] : [];
  const existing = kernel.listArtifacts().find((artifact) =>
    taskOutputIds.includes(artifact.artifactId)
      && (primaryEvidence.path === artifact.path || primaryEvidence.path.startsWith(`${artifact.path.replace(/\/+$/, "")}/`))
  );
  const artifactId = existing?.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, primaryEvidence.path);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type: existing?.type ?? (request.toolName === "cocos_build" ? "build" : inferArtifactType(agent.agentId, primaryEvidence.path)),
    path: existing?.path ?? primaryEvidence.path,
    ownerAgentId: agent.agentId,
    stageId: kernel.project.currentStage,
    status: result.ok ? existing?.status ?? "submitted" : "change_requested",
    version: existing ? existing.version + 1 : 1,
    ...(sourceTaskId ? { sourceTaskId } : {}),
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: {
      ...stripPrivilegedMaterializationMetadata(existing?.metadata ?? {}),
      bridgeOperationId: result.operationId,
      bridgeOperationType: result.operationType,
      bridgeReportPath: result.reportPath,
      bridgeResult: result.details,
      bridgeOk: result.ok,
      toolName: request.toolName,
      toolSourceMessageId: message.messageId,
      toolExecutedAt: now
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
  const directoryManifest = request.toolName === "cocos_build"
    ? readBridgeDirectoryManifest(result.details)
    : undefined;
  if (result.ok && request.toolName === "cocos_build" && !directoryManifest) {
    throw new Error(`Cocos Bridge 构建成功但缺少规范 output manifest：${result.operationId}`);
  }
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: primaryEvidence.path,
    hash: primaryEvidence.hash,
    sizeBytes: primaryEvidence.sizeBytes,
    materializedAt: now,
    ...(directoryManifest ? { directoryManifest } : {})
  });
  if (!result.ok) {
    return {
      toolName: request.toolName,
      status: "failed",
      path: primaryEvidence.path,
      artifactId: artifact.artifactId,
      hash: primaryEvidence.hash,
      sizeBytes: primaryEvidence.sizeBytes,
      error: result.error ?? result.summary
    };
  }
  return {
    toolName: request.toolName,
    status: "completed",
    path: primaryEvidence.path,
    artifactId: artifact.artifactId,
    hash: primaryEvidence.hash,
    sizeBytes: primaryEvidence.sizeBytes
  };
}

function readBridgeDirectoryManifest(details: Record<string, unknown>): import("@game-pipeline/shared-schemas").ArtifactDirectoryManifest | undefined {
  const candidate = details.outputManifest;
  if (!isRecord(candidate) || candidate.schemaVersion !== 1 || typeof candidate.rootPath !== "string" ||
    typeof candidate.digest !== "string" || !Array.isArray(candidate.files)) {
    return undefined;
  }
  const files = candidate.files.filter((entry): entry is { path: string; hash: string; sizeBytes: number } =>
    isRecord(entry) && typeof entry.path === "string" && typeof entry.hash === "string" && typeof entry.sizeBytes === "number"
  );
  if (files.length !== candidate.files.length) return undefined;
  return { schemaVersion: 1, rootPath: candidate.rootPath, digest: candidate.digest, files };
}

function defaultServiceToolPath(toolName: ExecutableToolName, args: Record<string, unknown>): string {
  switch (toolName) {
    case "cocos_validate_project":
      return "agents/cocos-automation/validation";
    case "cocos_import_assets":
      return stringValue(args.manifestPath) || "agents/art/asset-manifest.json";
    case "cocos_apply_blueprint":
      return stringValue(args.scenePath) || "assets/scenes/MainGame.scene";
    case "cocos_build":
      return stringValue(args.outputDir) || "shared/build-artifacts/wechat/dev";
    case "run_playtest":
      return "agents/qa/playtest-reports/report-001.md";
    case "generate_raster_asset":
      return stringValue(args.path) || "agents/art/processed-assets/generated.png";
    case "inspect_visual_assets": {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      return paths.find((value): value is string => typeof value === "string" && Boolean(value.trim())) ?? "agents/review/art";
    }
    default:
      return "agents/cocos-automation";
  }
}

function requestArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const functionValue = isRecord(raw.function) ? raw.function : undefined;
  const args = raw.args ?? raw.arguments ?? raw.input ?? raw.parameters ?? functionValue?.arguments;
  if (typeof args === "string") {
    const parsed = parseJson(args);
    return isRecord(parsed) ? parsed : raw;
  }
  return isRecord(args) ? args : raw;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function normalizeToolName(value: unknown): ExecutableToolName | undefined {
  const name = typeof value === "string" ? value : isRecord(value) ? stringValue(value.name) : "";
  return executableToolNames.includes(name as ExecutableToolName) ? (name as ExecutableToolName) : undefined;
}

function normalizeArtifactType(value: unknown): Artifact["type"] | undefined {
  const type = stringValue(value);
  return artifactTypes.includes(type as Artifact["type"]) ? (type as Artifact["type"]) : undefined;
}

function normalizeArtifactStatus(value: unknown): ArtifactStatus | undefined {
  const status = stringValue(value);
  return artifactStatuses.includes(status as ArtifactStatus) ? (status as ArtifactStatus) : undefined;
}

export function inferArtifactType(agentId: AgentId, path: string): Artifact["type"] {
  const normalized = path.toLowerCase();
  if (/\.(svg|png|jpe?g|webp)$/.test(normalized)) {
    return "asset";
  }
  if (normalized.includes("art-bible") || normalized.includes("art_bible")) {
    return "art_bible";
  }
  if (normalized.includes("game-contract") || normalized.includes("game_contract")) {
    return "game_contract";
  }
  if (normalized.includes("playtest-contract") || normalized.includes("playtest_contract")) {
    return "playtest_contract";
  }
  if (normalized.includes("manifest")) {
    return "asset_manifest";
  }
  if (normalized.includes("quality-review") || normalized.includes("quality_review")) {
    return "quality_review";
  }
  if (normalized.includes("scene") || normalized.includes("blueprint")) {
    return "scene_blueprint";
  }
  if (normalized.endsWith(".ts") || normalized.endsWith(".tsx") || normalized.endsWith(".js")) {
    return "source_code";
  }
  if (normalized.includes("qa") || normalized.includes("test")) {
    return "qa_report";
  }
  if (
    normalized.includes("deployment-plan") ||
    normalized.includes("deployment_plan") ||
    normalized.includes("deploy-plan") ||
    normalized.includes("deploy_plan") ||
    normalized.includes("deployment-plans/")
  ) {
    return "deployment_plan";
  }
  if (normalized.includes("deploy")) {
    return "deployment_report";
  }
  if (normalized.includes("rollback")) {
    return "rollback_plan";
  }
  if (normalized.includes("release")) {
    return "release_notes";
  }
  if (normalized.includes("asset")) {
    return "asset_spec";
  }
  if (agentId === "art_director") {
    return "art_bible";
  }
  if (agentId === "asset_production") {
    return "asset_manifest";
  }
  if (agentId === "cocos_tech_lead") {
    return "scene_blueprint";
  }
  if (agentId === "gameplay_programmer") {
    return "source_code";
  }
  if (agentId === "qa_evaluator") {
    return "qa_report";
  }
  return "gdd";
}

function assertToolAllowed(agent: AgentContract, toolName: ExecutableToolName): void {
  const allowed = agent.tools.includes(toolName) || (toolName === "append_document" && agent.tools.includes("write_artifact"));
  if (!allowed) {
    throw new Error(`${agent.agentId} 没有 ${toolName} 工具权限。`);
  }
}

function toolPathAccess(toolName: ExecutableToolName): "read" | "write" {
  return toolName === "run_typecheck" || toolName === "run_implementation_checks" || toolName === "cocos_import_assets" || toolName === "inspect_visual_assets"
    ? "read"
    : "write";
}

function assertAuxiliaryToolPathsAuthorized(
  kernel: StudioKernel,
  agent: AgentContract,
  task: Task,
  request: ToolRequest
): void {
  if (request.sourcePath) {
    assertAgentPathAuthorized(kernel, agent, task, normalizeToolPath(request.sourcePath, agent), "read");
  }
  const args = request.arguments ?? {};
  if (request.toolName === "generate_raster_asset" || request.toolName === "inspect_visual_assets") {
    const paths = request.toolName === "generate_raster_asset" ? args.referencePaths : args.paths;
    if (paths !== undefined && !Array.isArray(paths)) {
      throw new Error(`${request.toolName} 的图片路径参数必须是数组。`);
    }
    for (const path of Array.isArray(paths) ? paths : []) {
      if (typeof path !== "string" || !path.trim()) {
        throw new Error(`${request.toolName} 的图片路径必须是非空字符串。`);
      }
      assertAgentPathAuthorized(kernel, agent, task, normalizeAuthorizationPath(path), "read");
    }
  }
  const readKeys = request.toolName === "cocos_import_assets"
    ? ["manifestPath"]
    : request.toolName === "cocos_apply_blueprint"
      ? ["blueprintPath"]
      : request.toolName === "cocos_build"
        ? ["configPath"]
        : [];
  const writeKeys = request.toolName === "cocos_apply_blueprint"
    ? ["scenePath"]
    : request.toolName === "cocos_build"
      ? ["outputDir"]
      : [];
  for (const key of readKeys) {
    const path = stringValue(args[key]);
    if (path) assertAgentPathAuthorized(kernel, agent, task, normalizeAuthorizationPath(path), "read");
  }
  for (const key of writeKeys) {
    const path = stringValue(args[key]);
    if (path) assertAgentPathAuthorized(kernel, agent, task, normalizeAuthorizationPath(path), "write");
  }
}

function writeMode(toolName: ExecutableToolName): "replace" | "append" {
  return toolName === "append_document" ? "append" : "replace";
}

function nextMaterializedArtifactStatus(
  requestedStatus: ArtifactStatus | undefined,
  existingStatus: ArtifactStatus | undefined
): ArtifactStatus {
  if (requestedStatus && ["approved", "review", "rejected", "superseded"].includes(requestedStatus)) {
    throw new Error(`工具请求不能直接设置受控产物状态 ${requestedStatus}；评审和制作人门禁必须通过 Workflow 完成。`);
  }
  if (requestedStatus) {
    return requestedStatus;
  }
  return existingStatus === "change_requested" ? "submitted" : existingStatus ?? "draft";
}

function runTypeScriptSemanticCheck(projectId: string, path: string): ToolExecutionResult {
  const target = resolveWorkspacePathTarget(projectId, path);
  if (!target.exists || target.type !== "file") {
    throw new Error(`待检查的 TypeScript 文件不存在：${path}`);
  }
  if (!/\.(ts|tsx)$/.test(path.toLowerCase())) {
    throw new Error(`run_typecheck 只接受 .ts 或 .tsx 文件：${path}`);
  }

  const source = readFileSync(target.absolutePath, "utf8");
  const result = runImplementationChecks(resolveProjectWorkspaceRoot(projectId), cocosEngineSettingsStore.getResolvedConfig().executablePath);
  const errors = result.findings.filter((finding) => finding.code.startsWith("TS") || finding.code === "missing_creator_types")
    .map((finding) => `${finding.path}:${finding.line ?? 1} ${finding.code} ${finding.details}`);
  if (errors.length > 0) {
    throw new Error(`TypeScript 语义检查失败（真实 Cocos 类型）：${errors.slice(0, 20).join("；")}`);
  }

  return {
    toolName: "run_typecheck",
    status: "completed",
    path: target.relativePath,
    hash: createHash("sha256").update(source).digest("hex"),
    sizeBytes: Buffer.byteLength(source)
  };
}

function assertSvgImage(path: string, content: string): void {
  if (!path.toLowerCase().endsWith(".svg")) {
    throw new Error("当前内置 generate_image 工具只生成可审计的 SVG 资产，请使用 .svg 路径。位图生成将在图片模型工具接入后开放。");
  }
  const normalized = content.trim();
  if (!/^<svg\b[\s\S]*<\/svg>$/i.test(normalized)) {
    throw new Error("generate_image 的 content 必须是完整 SVG 文档。");
  }
  if (/<script\b|\bon\w+\s*=|javascript:/i.test(normalized)) {
    throw new Error("SVG 包含脚本或事件处理器，已拒绝写入。");
  }
}

function defaultLoopControlReason(status: AgentLoopControl["status"]): string {
  switch (status) {
    case "waiting_for_producer":
      return "等待制作人补充信息或确认。";
    case "handoff":
      return "当前工作已交接给其他角色。";
    case "ready_for_review":
      return "当前任务产物已准备接受评审。";
    case "blocked":
      return "当前任务存在无法自行解除的阻塞。";
    case "continue":
    default:
      return "继续执行当前任务。";
  }
}

function normalizeToolPath(path: string, agent: AgentContract): string {
  let normalized = path.trim().replace(/^\.\/+/, "");
  if (!normalized.includes("/")) {
    normalized = `${agent.workspace.replace(/\/+$/, "")}/${normalized}`;
  }
  return normalizeAuthorizationPath(normalized);
}

function renderToolExecutedMessage(content: string, results: ToolExecutionResult[]): string {
  const summary = results
    .map((result) => {
      if (result.status === "completed") {
        return `- ${result.toolName} 已写入 \`${result.path}\`，artifactId=${result.artifactId}，hash=${result.hash?.slice(0, 12)}，size=${result.sizeBytes} bytes`;
      }
      return `- ${result.toolName} 执行失败：${result.error}`;
    })
    .join("\n");

  return [content.trim(), "---", "服务端工具执行结果：", summary].filter(Boolean).join("\n\n");
}

export function stableArtifactId(projectId: string, agentId: AgentId, path: string): string {
  return `artifact_${createHash("sha1").update(`${projectId}:${agentId}:${path}`).digest("hex").slice(0, 12)}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
