import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { defaultAgentContracts, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentContract, AgentId, AgentLoopControl, Artifact, ArtifactStatus, StudioMessage, TaskId } from "@game-pipeline/shared-schemas";
import * as ts from "typescript";
import { resolveWorkspacePathTarget, writeToolArtifactContent } from "./workspaceWriter.js";
import { rasterizeSvgFile } from "./svgRasterizer.js";
import { resolveProjectWorkspaceRoot } from "./workspaceWriter.js";
import { CocosEngineBridge } from "./cocosEngineBridge.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { CocosPlaytestHarness } from "./cocosPlaytestHarness.js";
import { assertQaEvidenceWriteAllowed } from "./qaEvidenceProtection.js";

export type ExecutableToolName =
  | "write_artifact"
  | "append_document"
  | "write_code"
  | "run_typecheck"
  | "generate_image"
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
  taskId?: TaskId;
  status?: ArtifactStatus;
  metadata?: Record<string, unknown>;
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

const artifactTypes: Artifact["type"][] = [
  "gdd",
  "art_bible",
  "asset_spec",
  "asset",
  "asset_manifest",
  "scene_blueprint",
  "source_code",
  "build",
  "qa_report",
  "bug_report",
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
  "generate_image",
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

export async function executeAgentToolRequests(kernel: StudioKernel, messages: StudioMessage[]): Promise<ToolExecutionResult[]> {
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
    for (const request of extracted.requests) {
      const result = await executeToolRequest(kernel, message, agent, request);
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

async function executeToolRequest(kernel: StudioKernel, message: StudioMessage, agent: AgentContract, request: ToolRequest): Promise<ToolExecutionResult> {
  try {
    assertToolAllowed(agent, request.toolName);
    const now = new Date().toISOString();
    if (request.toolName.startsWith("cocos_")) {
      return executeCocosBridgeTool(kernel, message, agent, request, now);
    }
    if (request.toolName === "run_playtest") {
      return executePlaytestTool(kernel, message, agent, request, now);
    }
    const path = normalizeToolPath(request.path, agent);
    if (request.toolName === "run_typecheck") {
      return runTypeScriptSyntaxCheck(kernel.project.projectId, path);
    }
    if (request.toolName === "generate_image") {
      assertSvgImage(path, request.content);
    }
    const sourceTaskId = resolveSourceTaskId(kernel, agent.agentId, request.taskId);
    const existing = kernel
      .listArtifacts()
      .find((artifact) => artifact.artifactId === request.artifactId || (artifact.ownerAgentId === agent.agentId && artifact.path === path));
    assertQaEvidenceWriteAllowed(path, request.toolName);
    if (request.toolName === "render_svg_to_png") {
      return executeSvgRasterization(kernel, message, agent, request, path, now, sourceTaskId, existing);
    }
    const artifact: Artifact = {
      artifactId: existing?.artifactId ?? request.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, path),
      projectId: kernel.project.projectId,
      type: request.artifactType ?? existing?.type ?? inferArtifactType(agent.agentId, path),
      path,
      ownerAgentId: agent.agentId,
      stageId: kernel.project.currentStage,
      status: request.status ?? existing?.status ?? "draft",
      version: existing ? existing.version + 1 : 1,
      ...(sourceTaskId ? { sourceTaskId } : {}),
      sourceDecisionIds: existing?.sourceDecisionIds ?? [],
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(request.metadata ?? {}),
        toolName: request.toolName,
        toolSourceMessageId: message.messageId,
        toolExecutedAt: now,
        toolWriteMode: writeMode(request.toolName),
        toolContent: request.content
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    const registered = kernel.upsertArtifact(artifact);
    const writeResult = writeToolArtifactContent(kernel, registered, {
      content: request.content,
      mode: writeMode(request.toolName)
    });
    kernel.upsertArtifact({
      ...registered,
      metadata: {
        ...registered.metadata,
        toolContent: writeResult.content,
        toolHash: writeResult.hash,
        toolSizeBytes: writeResult.sizeBytes,
        toolMaterializedAt: writeResult.materializedAt
      },
      updatedAt: writeResult.materializedAt
    });

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
  now: string
): Promise<ToolExecutionResult> {
  const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
  const args = request.arguments ?? {};
  const sourceTaskId = resolveSourceTaskId(kernel, agent.agentId, request.taskId);
  const registeredReportPath = sourceTaskId
    ? kernel.findTask(sourceTaskId)?.outputArtifacts
        .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
        .find((artifact) => artifact?.type === "qa_report")?.path
    : undefined;
  const result = await new CocosPlaytestHarness(projectRoot, cocosEngineSettingsStore.getResolvedConfig()).run({
    ...(typeof args.maxDurationSec === "number" ? { maxDurationSec: args.maxDurationSec } : {}),
    ...(registeredReportPath ? { reportPath: registeredReportPath } : {})
  });
  const taskOutputIds = sourceTaskId ? kernel.findTask(sourceTaskId)?.outputArtifacts ?? [] : [];
  let primary: ToolExecutionResult | undefined;
  for (const item of result.evidence) {
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
        ...(existing?.metadata ?? {}),
        toolName: request.toolName,
        toolSourceMessageId: message.messageId,
        toolExecutedAt: now,
        playtestOperationId: result.operationId,
        playtestVerdict: result.verdict,
        playtestChecks: result.checks,
        playtestDefects: result.defects,
        playtestEvidencePaths: result.evidencePaths,
        playtestRuntime: result.runtime
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
    status: request.status ?? existing?.status ?? "draft",
    version: existing ? existing.version + 1 : 1,
    ...(sourceTaskId ? { sourceTaskId } : {}),
    sourceDecisionIds: existing?.sourceDecisionIds ?? [],
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(request.metadata ?? {}),
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
  const isServiceTool = toolName.startsWith("cocos_") || toolName === "run_playtest";
  if ((!path && !isServiceTool) || (!isServiceTool && !["run_typecheck", "render_svg_to_png"].includes(toolName) && !content.trim())) {
    return undefined;
  }

  const artifactId = stringValue(args.artifactId ?? args.artifact_id);
  const taskId = stringValue(args.taskId ?? args.task_id);
  const sourcePath = stringValue(args.sourcePath ?? args.source_path);
  const width = typeof args.width === "number" && Number.isFinite(args.width) ? args.width : undefined;
  const status = normalizeArtifactStatus(args.status);
  return {
    toolName,
    path: path || defaultServiceToolPath(toolName, args),
    content,
    ...(isServiceTool ? { arguments: args } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(artifactId ? { artifactId } : {}),
    artifactType: normalizeArtifactType(args.artifactType ?? args.artifact_type ?? args.type) ?? inferArtifactType(agent.agentId, path),
    ...(taskId ? { taskId } : {}),
    ...(status ? { status } : {}),
    ...(isRecord(args.metadata) ? { metadata: args.metadata } : {})
  };
}

function executeCocosBridgeTool(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  request: ToolRequest,
  now: string
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
  const sourceTaskId = resolveSourceTaskId(kernel, agent.agentId, request.taskId);
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
      ...(existing?.metadata ?? {}),
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
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: primaryEvidence.path,
    hash: primaryEvidence.hash,
    sizeBytes: primaryEvidence.sizeBytes,
    materializedAt: now
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
  if (normalized.includes("manifest")) {
    return "asset_manifest";
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

function writeMode(toolName: ExecutableToolName): "replace" | "append" {
  return toolName === "append_document" ? "append" : "replace";
}

function runTypeScriptSyntaxCheck(projectId: string, path: string): ToolExecutionResult {
  const target = resolveWorkspacePathTarget(projectId, path);
  if (!target.exists || target.type !== "file") {
    throw new Error(`待检查的 TypeScript 文件不存在：${path}`);
  }
  if (!/\.(ts|tsx)$/.test(path.toLowerCase())) {
    throw new Error(`run_typecheck 只接受 .ts 或 .tsx 文件：${path}`);
  }

  const source = readFileSync(target.absolutePath, "utf8");
  const result = ts.transpileModule(source, {
    fileName: target.absolutePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      strict: true
    }
  });
  const errors = (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  if (errors.length > 0) {
    throw new Error(`TypeScript 语法检查失败：${errors.slice(0, 5).join("；")}`);
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
  if (!normalized || normalized.startsWith("/") || normalized.includes("..") || normalized.includes("://")) {
    throw new Error(`不安全的工具写入路径：${path}`);
  }
  return normalized;
}

function resolveSourceTaskId(kernel: StudioKernel, agentId: AgentId, requestedTaskId?: TaskId): TaskId | undefined {
  if (requestedTaskId && kernel.findTask(requestedTaskId)) {
    return requestedTaskId;
  }

  const candidate = kernel
    .listTasks()
    .find((task) => task.ownerAgentId === agentId && task.stageId === kernel.project.currentStage && ["doing", "todo", "blocked"].includes(task.status));
  return candidate?.taskId;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
