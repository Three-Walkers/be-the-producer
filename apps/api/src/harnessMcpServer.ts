import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { rasterizeSvgFile } from "./svgRasterizer.js";
import { CocosEngineBridge, type CocosBridgeResult } from "./cocosEngineBridge.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { CocosPlaytestHarness } from "./cocosPlaytestHarness.js";
import { assertQaEvidenceWriteAllowed } from "./qaEvidenceProtection.js";
import {
  assertContractPathContent,
  assertContractRevisionAdvance,
  contractArtifactTypeForPath
} from "./contractArtifacts.js";
import type { ArtifactInputProvenance } from "@game-pipeline/shared-schemas";
import type { AgentHarnessAuthorization, AgentHarnessAuthorizationArtifact } from "./agentHarness.js";
import { normalizeRelativePathWithinRoot, resolvePathWithinRoot } from "./pathSafety.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const projectRoot = resolve(requiredEnvironment("BTP_PROJECT_ROOT"));
const agentId = requiredEnvironment("BTP_AGENT_ID");
const toolMode = parseToolMode(requiredEnvironment("BTP_TOOL_MODE"));
const authorization = parseAuthorization(requiredEnvironment("BTP_AUTHORIZATION"));
assertAuthorizationEnvelope();
const taskInputEvidence = parseTaskInputEvidence(process.env.BTP_TASK_INPUT_EVIDENCE);
const controlPath = process.env.BTP_CONTROL_PATH?.trim();
const operationLogPath = process.env.BTP_OPERATION_LOG_PATH?.trim();
const reader = createInterface({ input: process.stdin, terminal: false });

reader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  void handleRequest(request);
});

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") {
    return;
  }
  if (request.id === undefined) {
    return;
  }
  try {
    switch (request.method) {
      case "initialize":
        respond(request.id, {
          protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "btp-workspace", version: "1.0.0" }
        });
        return;
      case "ping":
        respond(request.id, {});
        return;
      case "tools/list":
        respond(request.id, { tools: toolDefinitions() });
        return;
      case "tools/call":
        respond(request.id, await callTool(request.params));
        return;
      default:
        respondError(request.id, -32601, `Method not found: ${request.method ?? "unknown"}`);
    }
  } catch (error) {
    respond(request.id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true
    });
  }
}

function toolDefinitions(): Array<Record<string, unknown>> {
  const readTools: Array<Record<string, unknown>> = [
    {
      name: "read_file",
      title: "Read authorized project file",
      description: "Read one UTF-8 project file allowed by the current task-bound authorization.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Authorized project-relative file path" },
          maxBytes: { type: "integer", minimum: 1, maximum: 1048576 }
        },
        required: ["path"],
        additionalProperties: false
      }
    },
    {
      name: "list_files",
      title: "List authorized project files",
      description: "List files below a task-authorized input/output or minimal role read root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Authorized project-relative directory" },
          limit: { type: "integer", minimum: 1, maximum: 300 }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  ];
  if (toolMode === "conversation") {
    return readTools;
  }
  const tools: Array<Record<string, unknown>> = [
    ...readTools,
    {
      name: "write_artifact",
      title: "Write project artifact",
      description: "Create or replace exactly one current-task output artifact path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative destination path" },
          content: { type: "string", description: "Complete UTF-8 file content" }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    },
    {
      name: "append_document",
      title: "Append project document",
      description: "Append UTF-8 text to an existing or new document inside authorized project paths.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    },
    {
      name: "report_task_status",
      title: "Report task loop status",
      description: "Report whether this task should continue, wait for producer input, hand off, enter review, or stop on a real blocker. Call this once at the end of every turn.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["continue", "waiting_for_producer", "handoff", "ready_for_review", "blocked"]
          },
          reason: { type: "string", description: "Concrete reason grounded in work performed or a real dependency" },
          handoffAgentIds: {
            type: "array",
            items: { type: "string" },
            description: "Role IDs that should take over when status is handoff"
          }
        },
        required: ["status", "reason"],
        additionalProperties: false
      }
    }
  ];
  if (["art_director", "asset_production"].includes(agentId)) {
    tools.push({
      name: "render_svg_to_png",
      title: "Render SVG source to PNG",
      description: "Rasterize an authorized SVG source into a transparent PNG runtime asset for Cocos Creator. The PNG is recorded as tool evidence.",
      inputSchema: {
        type: "object",
        properties: {
          sourcePath: { type: "string", description: "Authorized project-relative .svg source path" },
          path: { type: "string", description: "Authorized project-relative .png output path" },
          width: { type: "integer", minimum: 1, maximum: 4096, description: "Optional output width; aspect ratio is preserved" }
        },
        required: ["sourcePath", "path"],
        additionalProperties: false
      }
    });
  }
  if (agentId === "qa_evaluator") {
    tools.push({
      name: "run_playtest",
      title: "Run real Cocos playtest",
      description: "Build a QA-only Cocos Web package, drive it in Chrome through start, gameplay, terminal and restart states, then write screenshots, console logs and a machine-verifiable report. A failed verdict is valid evidence and must be handed back to the responsible Agent.",
      inputSchema: {
        type: "object",
        properties: {
          maxDurationSec: { type: "integer", minimum: 10, maximum: 120, description: "Maximum real-time gameplay window before the run is considered incomplete" }
        },
        additionalProperties: false
      }
    });
  }
  if (agentId === "cocos_automation") {
    tools.push(
      {
        name: "cocos_validate_project",
        title: "Validate Cocos Creator project",
        description: "Validate the real Cocos project root and configured Creator 3.8+ executable before performing editor operations.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "cocos_import_assets",
        title: "Import manifest assets into Cocos",
        description: "Validate runtime assets from AssetManifest, copy them into assets/resources, and create an auditable native-import report.",
        inputSchema: {
          type: "object",
          properties: { manifestPath: { type: "string", description: "Project-relative AssetManifest JSON path" } },
          additionalProperties: false
        }
      },
      {
        name: "cocos_apply_blueprint",
        title: "Apply SceneBlueprint",
        description: "Apply a structured SceneBlueprint through the controlled bridge and generate a Cocos scene, runtime descriptor, bootstrap component, and operation report.",
        inputSchema: {
          type: "object",
          properties: {
            blueprintPath: { type: "string", description: "Project-relative SceneBlueprint JSON path" },
            scenePath: { type: "string", description: "Destination under assets/scenes ending in .scene" }
          },
          additionalProperties: false
        }
      },
      {
        name: "cocos_build",
        title: "Build WeChat game with Cocos Creator",
        description: "Invoke the configured real Cocos Creator CLI for a wechatgame build. Success requires a successful Creator exit code and fresh non-empty build output.",
        inputSchema: {
          type: "object",
          properties: {
            platform: { type: "string", enum: ["wechatgame"] },
            debug: { type: "boolean" },
            outputDir: { type: "string", description: "Project-relative output under shared/build-artifacts or builds" },
            configPath: { type: "string", description: "Optional exported Creator build config JSON" }
          },
          additionalProperties: false
        }
      }
    );
  }
  return tools;
}

async function callTool(params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = isRecord(params?.arguments) ? params.arguments : {};
  if (!toolDefinitions().some((tool) => tool.name === name)) {
    throw new Error(`当前 ${toolMode} 会话未授权 MCP 工具：${name || "unknown"}`);
  }
  if (name === "read_file") {
    const target = resolveAuthorizedTarget(requiredString(args.path, "path"), false, "read");
    if (!existsSync(target.absolutePath) || !statSync(target.absolutePath).isFile()) {
      throw new Error(`待读取文件不存在：${target.relativePath}`);
    }
    const maxBytes = typeof args.maxBytes === "number"
      ? Math.max(1, Math.min(1_048_576, Math.floor(args.maxBytes)))
      : 256 * 1024;
    const body = readFileSync(target.absolutePath);
    if (body.byteLength > maxBytes) {
      throw new Error(`文件 ${target.relativePath} 为 ${body.byteLength} bytes，超过本次读取上限 ${maxBytes} bytes。`);
    }
    return {
      content: [{ type: "text", text: body.toString("utf8") }],
      structuredContent: { path: target.relativePath, sizeBytes: body.byteLength }
    };
  }
  if (name === "write_artifact" || name === "append_document") {
    const path = requiredString(args.path, "path");
    const content = requiredString(args.content, "content", true);
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) {
      throw new Error("单次 MCP 文本写入不能超过 5 MB。");
    }
    let target = resolveAuthorizedTarget(path, false, "artifact_write");
    assertQaEvidenceWriteAllowed(target.relativePath, name);
    assertContractPathContent(target.relativePath, content, name === "append_document" ? "append" : "write");
    const contractType = contractArtifactTypeForPath(target.relativePath);
    if (contractType && name === "write_artifact") {
      const previousContent = existsSync(target.absolutePath) && statSync(target.absolutePath).isFile()
        ? readFileSync(target.absolutePath, "utf8")
        : undefined;
      assertContractRevisionAdvance(contractType, previousContent, content);
    }
    mkdirSync(dirname(target.absolutePath), { recursive: true });
    target = resolveAuthorizedTarget(path, false, "artifact_write");
    if (name === "append_document") {
      const needsSeparator = existsSync(target.absolutePath) && statSync(target.absolutePath).size > 0 && !readFileSync(target.absolutePath, "utf8").endsWith("\n");
      appendFileSync(target.absolutePath, `${needsSeparator ? "\n" : ""}${content}${content.endsWith("\n") ? "" : "\n"}`, "utf8");
    } else {
      writeFileSync(target.absolutePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    }
    const stats = statSync(target.absolutePath);
    const hash = createHash("sha256").update(readFileSync(target.absolutePath)).digest("hex");
    recordOperation({ toolName: name, path: target.relativePath, hash, sizeBytes: stats.size, status: "completed" });
    return {
      content: [{ type: "text", text: `写入成功：${target.relativePath}；hash=${hash}；size=${stats.size} bytes` }],
      structuredContent: { path: target.relativePath, hash, sizeBytes: stats.size }
    };
  }
  if (name === "list_files") {
    const requestedPath = requiredString(args.path, "path");
    const target = resolveAuthorizedTarget(requestedPath, true, "read");
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(300, Math.floor(args.limit))) : 120;
    const files = listFiles(target.absolutePath, limit).map((absolutePath) => relative(projectRoot, absolutePath).split(sep).join("/"));
    return {
      content: [{ type: "text", text: files.length > 0 ? files.join("\n") : "目录中暂无文件。" }],
      structuredContent: { path: target.relativePath, files }
    };
  }
  if (name === "render_svg_to_png" && ["art_director", "asset_production"].includes(agentId)) {
    const source = resolveAuthorizedTarget(requiredString(args.sourcePath, "sourcePath"), false, "read");
    const targetPath = requiredString(args.path, "path");
    let target = resolveAuthorizedTarget(targetPath, false, "service_write");
    mkdirSync(dirname(target.absolutePath), { recursive: true });
    target = resolveAuthorizedTarget(targetPath, false, "service_write");
    const width = typeof args.width === "number" ? args.width : undefined;
    const rendered = rasterizeSvgFile(source.absolutePath, target.absolutePath, width);
    recordOperation({ toolName: name, path: target.relativePath, hash: rendered.hash, sizeBytes: rendered.sizeBytes, status: "completed" });
    return {
      content: [{
        type: "text",
        text: `PNG 渲染成功：${source.relativePath} → ${target.relativePath}；${rendered.width}x${rendered.height}；hash=${rendered.hash}；size=${rendered.sizeBytes} bytes`
      }],
      structuredContent: {
        sourcePath: source.relativePath,
        path: target.relativePath,
        hash: rendered.hash,
        sizeBytes: rendered.sizeBytes,
        width: rendered.width,
        height: rendered.height
      }
    };
  }
  if (name === "report_task_status") {
    if (!controlPath) {
      throw new Error("本轮 Harness 没有配置状态回传通道。");
    }
    const status = requiredString(args.status, "status");
    const allowedStatuses = new Set(["continue", "waiting_for_producer", "handoff", "ready_for_review", "blocked"]);
    if (!allowedStatuses.has(status)) {
      throw new Error(`不支持的任务状态：${status}`);
    }
    const reason = requiredString(args.reason, "reason");
    const handoffAgentIds = Array.isArray(args.handoffAgentIds)
      ? args.handoffAgentIds.filter((agentId): agentId is string => typeof agentId === "string" && Boolean(agentId.trim()))
      : [];
    mkdirSync(dirname(controlPath), { recursive: true });
    writeFileSync(controlPath, `${JSON.stringify({ status, reason, handoffAgentIds }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return {
      content: [{ type: "text", text: `任务状态已回传：${status}；${reason}` }],
      structuredContent: { status, reason, handoffAgentIds }
    };
  }
  if (name === "run_playtest" && agentId === "qa_evaluator") {
    const reportArtifact = taskOutputArtifacts().find((artifact) => artifact.type === "qa_report");
    const playtestContract = taskInputArtifacts().find((artifact) => artifact.type === "playtest_contract");
    if (!reportArtifact) {
      throw new Error(`任务 ${authorization.taskId ?? "missing"} 没有登记 qa_report 输出，run_playtest 已拒绝。`);
    }
    assertPathAuthorized(reportArtifact.path, "artifact_write");
    for (const path of ["agents/qa/playtest-runs", "shared/build-artifacts/playtest", "agents/cocos-automation/build-ops", "agents/cocos-automation/cocos-build-logs"]) {
      assertPathAuthorized(path, "service_write");
    }
    const maxDurationSec = typeof args.maxDurationSec === "number" ? Math.max(10, Math.min(120, Math.floor(args.maxDurationSec))) : undefined;
    const result = await new CocosPlaytestHarness(projectRoot, cocosEngineSettingsStore.getResolvedConfig()).run({
      ...(maxDurationSec ? { maxDurationSec } : {}),
      taskInputEvidence,
      ...(playtestContract ? { playtestContractPath: playtestContract.path } : {}),
      reportPath: reportArtifact.path
    });
    for (const item of result.evidence) {
      assertServiceEvidenceAuthorized(item.path, result.reportPath);
      recordOperation({
        toolName: name,
        path: item.path,
        hash: item.hash,
        sizeBytes: item.sizeBytes,
        status: result.ok ? "completed" : "failed",
        operationId: result.operationId,
        operationType: "playtest",
        ...(result.ok ? {} : { error: result.summary })
      });
    }
    return {
      content: [{
        type: "text",
        text: `${result.summary}\n结论：${result.verdict}\n缺陷：${result.defects.length}\n报告：${result.reportPath}\n证据：${result.evidencePaths.join("、") || "无"}`
      }],
      structuredContent: {
        operationId: result.operationId,
        verdict: result.verdict,
        reportPath: result.reportPath,
        checks: result.checks,
        defects: result.defects,
        evidencePaths: result.evidencePaths,
        runtime: result.runtime
      }
    };
  }
  if (agentId === "cocos_automation" && name.startsWith("cocos_")) {
    assertCocosRequestAuthorized(name, args);
    const bridge = new CocosEngineBridge(projectRoot, cocosEngineSettingsStore.getResolvedConfig());
    let result: CocosBridgeResult;
    if (name === "cocos_validate_project") {
      result = bridge.validateProject();
    } else if (name === "cocos_import_assets") {
      result = bridge.importAssets({
        ...(typeof args.manifestPath === "string" && args.manifestPath.trim() ? { manifestPath: args.manifestPath } : {})
      });
    } else if (name === "cocos_apply_blueprint") {
      result = bridge.applySceneBlueprint({
        ...(typeof args.blueprintPath === "string" && args.blueprintPath.trim() ? { blueprintPath: args.blueprintPath } : {}),
        ...(typeof args.scenePath === "string" && args.scenePath.trim() ? { scenePath: args.scenePath } : {})
      });
    } else if (name === "cocos_build") {
      result = bridge.build({
        ...(args.platform === "wechatgame" ? { platform: args.platform } : {}),
        ...(typeof args.debug === "boolean" ? { debug: args.debug } : {}),
        ...(typeof args.outputDir === "string" && args.outputDir.trim() ? { outputDir: args.outputDir } : {}),
        ...(typeof args.configPath === "string" && args.configPath.trim() ? { configPath: args.configPath } : {})
      });
    } else {
      throw new Error(`不支持的 Cocos Bridge 工具：${name}`);
    }
    for (const item of result.evidence) {
      assertServiceEvidenceAuthorized(item.path, result.reportPath);
      recordOperation({
        toolName: name,
        path: item.path,
        hash: item.hash,
        sizeBytes: item.sizeBytes,
        status: result.ok ? "completed" : "failed",
        bridgeOk: result.ok,
        operationId: result.operationId,
        operationType: result.operationType,
        ...(item.path === result.reportPath && isDirectoryManifest(result.details.outputManifest)
          ? { directoryManifest: result.details.outputManifest }
          : {}),
        ...(result.error ? { error: result.error } : {})
      });
    }
    return {
      content: [{ type: "text", text: `${result.summary}${result.error ? `\n错误：${result.error}` : ""}\n报告：${result.reportPath}` }],
      structuredContent: result,
      isError: !result.ok
    };
  }
  throw new Error(`不支持的 BTP MCP 工具：${name || "unknown"}`);
}

function parseTaskInputEvidence(raw: string | undefined): ArtifactInputProvenance[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is ArtifactInputProvenance =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
      typeof (entry as ArtifactInputProvenance).artifactId === "string" &&
      typeof (entry as ArtifactInputProvenance).version === "number" &&
      typeof (entry as ArtifactInputProvenance).path === "string" &&
      typeof (entry as ArtifactInputProvenance).evidencePath === "string" &&
      typeof (entry as ArtifactInputProvenance).hash === "string" &&
      typeof (entry as ArtifactInputProvenance).sizeBytes === "number"
    );
  } catch {
    return [];
  }
}

function isDirectoryManifest(value: unknown): value is import("@game-pipeline/shared-schemas").ArtifactDirectoryManifest {
  return isRecord(value) && value.schemaVersion === 1 && typeof value.rootPath === "string" &&
    typeof value.digest === "string" && Array.isArray(value.files) && value.files.every((entry) =>
      isRecord(entry) && typeof entry.path === "string" && typeof entry.hash === "string" && typeof entry.sizeBytes === "number"
    );
}

function parseToolMode(value: string): "conversation" | "task" {
  if (value !== "conversation" && value !== "task") {
    throw new Error(`BTP_TOOL_MODE must be conversation or task, received ${value}`);
  }
  return value;
}

function parseAuthorization(value: string): AgentHarnessAuthorization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("BTP_AUTHORIZATION must be valid JSON.");
  }
  if (!isRecord(parsed) || !["conversation", "task"].includes(String(parsed.mode)) ||
    !Array.isArray(parsed.inputArtifactIds) || !Array.isArray(parsed.outputArtifactIds) ||
    !Array.isArray(parsed.artifacts) || !Array.isArray(parsed.readRoots) ||
    !Array.isArray(parsed.serviceReadPaths) || !Array.isArray(parsed.serviceWritePaths)) {
    throw new Error("BTP_AUTHORIZATION has an invalid envelope.");
  }
  const artifacts = parsed.artifacts.map((candidate, index): AgentHarnessAuthorizationArtifact => {
    if (!isRecord(candidate) || typeof candidate.artifactId !== "string" || typeof candidate.type !== "string" ||
      typeof candidate.path !== "string" || typeof candidate.ownerAgentId !== "string" ||
      (candidate.sourceTaskId !== undefined && typeof candidate.sourceTaskId !== "string")) {
      throw new Error(`BTP_AUTHORIZATION artifact[${index}] has invalid identity fields.`);
    }
    return {
      artifactId: requiredString(candidate.artifactId, `artifact[${index}].artifactId`),
      type: candidate.type as AgentHarnessAuthorizationArtifact["type"],
      path: normalizeAuthorizationPath(candidate.path),
      ownerAgentId: requiredString(candidate.ownerAgentId, `artifact[${index}].ownerAgentId`),
      ...(candidate.sourceTaskId ? { sourceTaskId: candidate.sourceTaskId } : {})
    };
  });
  const artifactIds = artifacts.map((artifact) => artifact.artifactId);
  const artifactPaths = artifacts.map((artifact) => artifact.path);
  if (new Set(artifactIds).size !== artifactIds.length || new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("BTP_AUTHORIZATION artifact ids and paths must be unique.");
  }
  return {
    mode: parsed.mode as AgentHarnessAuthorization["mode"],
    ...(typeof parsed.taskId === "string" && parsed.taskId.trim() ? { taskId: parsed.taskId.trim() } : {}),
    inputArtifactIds: parseAuthorizationStringList(parsed.inputArtifactIds, "inputArtifactIds", false),
    outputArtifactIds: parseAuthorizationStringList(parsed.outputArtifactIds, "outputArtifactIds", false),
    artifacts,
    readRoots: parseAuthorizationStringList(parsed.readRoots, "readRoots", true),
    serviceReadPaths: parseAuthorizationStringList(parsed.serviceReadPaths, "serviceReadPaths", true),
    serviceWritePaths: parseAuthorizationStringList(parsed.serviceWritePaths, "serviceWritePaths", true)
  };
}

function parseAuthorizationStringList(value: unknown[], label: string, paths: boolean): string[] {
  const values = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`BTP_AUTHORIZATION ${label}[${index}] must be a non-empty string.`);
    return paths ? normalizeAuthorizationPath(item) : item.trim();
  });
  return [...new Set(values)];
}

function normalizeAuthorizationPath(path: string): string {
  const normalized = normalizeRelativePathWithinRoot(path.replaceAll("\\", "/"), { label: "Harness authorization path" })
    .split(sep)
    .join("/");
  assertNotInternalPath(normalized);
  return normalized;
}

function assertAuthorizationEnvelope(): void {
  if (authorization.mode !== toolMode) throw new Error("Harness tool mode and authorization mode differ.");
  if (toolMode === "task" && !authorization.taskId) throw new Error("Task harness authorization requires taskId.");
  if (toolMode === "conversation" && (authorization.outputArtifactIds.length > 0 || authorization.serviceWritePaths.length > 0)) {
    throw new Error("Conversation harness authorization must be read-only.");
  }
  const artifactIds = new Set(authorization.artifacts.map((artifact) => artifact.artifactId));
  for (const artifactId of [...authorization.inputArtifactIds, ...authorization.outputArtifactIds]) {
    if (!artifactIds.has(artifactId)) throw new Error(`Authorization references unknown artifact ${artifactId}.`);
  }
  for (const artifact of taskOutputArtifacts()) {
    if (artifact.ownerAgentId !== agentId || artifact.sourceTaskId !== authorization.taskId) {
      throw new Error(`Output artifact ${artifact.artifactId} owner/sourceTask does not match this task authorization.`);
    }
  }
}

function taskOutputArtifacts(): AgentHarnessAuthorizationArtifact[] {
  return authorization.artifacts.filter((artifact) => authorization.outputArtifactIds.includes(artifact.artifactId));
}

function taskInputArtifacts(): AgentHarnessAuthorizationArtifact[] {
  return authorization.artifacts.filter((artifact) => authorization.inputArtifactIds.includes(artifact.artifactId));
}

function assertPathAuthorized(path: string, access: "read" | "artifact_write" | "service_write"): void {
  resolveAuthorizedTarget(path, true, access);
}

function assertServiceEvidenceAuthorized(path: string, reportPath: string): void {
  const registeredOutput = taskOutputArtifacts().find((artifact) =>
    path === artifact.path || path.startsWith(`${artifact.path.replace(/\/+$/, "")}/`)
  );
  if (registeredOutput && (path === reportPath || registeredOutput.type === "build")) {
    assertPathAuthorized(registeredOutput.path, "artifact_write");
    return;
  }
  assertPathAuthorized(path, "service_write");
}

function assertCocosRequestAuthorized(name: string, args: Record<string, unknown>): void {
  if (name === "cocos_validate_project") {
    for (const path of ["package.json", "assets", "settings"]) assertPathAuthorized(path, "read");
    assertPathAuthorized("agents/cocos-automation/validation", "service_write");
    return;
  }
  if (name === "cocos_import_assets") {
    const manifestPath = typeof args.manifestPath === "string" ? args.manifestPath : "agents/art/asset-manifest.json";
    const manifestTarget = resolveAuthorizedTarget(manifestPath, false, "read");
    const manifest = JSON.parse(readFileSync(manifestTarget.absolutePath, "utf8")) as unknown;
    for (const runtimePath of collectManifestRuntimePaths(manifest)) assertPathAuthorized(runtimePath, "read");
    for (const path of ["assets/resources/btp-art", "assets/resources/btp/asset-map.json", "agents/cocos-automation/imports"]) {
      assertPathAuthorized(path, "service_write");
    }
    return;
  }
  if (name === "cocos_apply_blueprint") {
    const blueprintPath = typeof args.blueprintPath === "string" ? args.blueprintPath : "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json";
    const scenePath = typeof args.scenePath === "string" ? args.scenePath : "assets/scenes/MainGame.scene";
    assertPathAuthorized(blueprintPath, "read");
    assertPathAuthorized("assets/scripts", "read");
    for (const path of [scenePath, `${scenePath}.meta`, "assets/resources/btp", "assets/scripts/btp", "agents/cocos-automation/scene-ops"]) {
      assertPathAuthorized(path, "service_write");
    }
    return;
  }
  if (name === "cocos_build") {
    const registeredBuilds = taskOutputArtifacts().filter((artifact) => artifact.type === "build");
    const outputDir = typeof args.outputDir === "string" ? args.outputDir : registeredBuilds[0]?.path;
    if (!outputDir || !registeredBuilds.some((artifact) => artifact.path === outputDir)) {
      throw new Error(`cocos_build outputDir 必须精确等于当前任务登记的 build 产物路径：${outputDir ?? "missing"}`);
    }
    assertPathAuthorized(outputDir, "artifact_write");
    assertPathAuthorized(outputDir, "service_write");
    for (const path of ["assets/scenes", "package.json", "settings"]) assertPathAuthorized(path, "read");
    for (const path of ["agents/cocos-automation/build-ops", "agents/cocos-automation/cocos-build-logs"]) {
      assertPathAuthorized(path, "service_write");
    }
    const configPath = typeof args.configPath === "string" && args.configPath.trim()
      ? args.configPath
      : cocosEngineSettingsStore.getResolvedConfig().buildConfigPath;
    if (configPath) assertPathAuthorized(configPath, "read");
  }
}

function collectManifestRuntimePaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) return;
    const runtimePath = candidate.runtimePath ?? candidate.runtime_path ?? candidate.cocosPath ?? candidate.cocos_path;
    if (typeof runtimePath === "string" && runtimePath.trim()) paths.push(runtimePath);
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...new Set(paths)];
}

function recordOperation(operation: import("./agentHarness.js").AgentHarnessToolOperation): void {
  if (!operationLogPath) {
    return;
  }
  mkdirSync(dirname(operationLogPath), { recursive: true });
  appendFileSync(
    operationLogPath,
    `${JSON.stringify({ ...operation, recordedAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function resolveAuthorizedTarget(
  path: string,
  allowDirectory: boolean,
  access: "read" | "artifact_write" | "service_write"
): { relativePath: string; absolutePath: string } {
  const relativePath = normalizeRelativePathWithinRoot(path, { label: "MCP 项目路径" }).split(sep).join("/");
  const inputPaths = authorization.artifacts
    .filter((artifact) => authorization.inputArtifactIds.includes(artifact.artifactId))
    .map((artifact) => artifact.path);
  const outputPaths = authorization.artifacts
    .filter((artifact) => authorization.outputArtifactIds.includes(artifact.artifactId))
    .map((artifact) => artifact.path);
  assertNotInternalPath(relativePath);
  const allowedPaths = access === "read"
    ? [...inputPaths, ...outputPaths, ...authorization.readRoots, ...authorization.serviceReadPaths]
    : access === "artifact_write"
      ? outputPaths
      : authorization.serviceWritePaths;
  const allowed = access === "artifact_write"
    ? allowedPaths.includes(relativePath)
    : allowedPaths.some((root) => relativePath === root || relativePath.startsWith(`${root.replace(/\/+$/, "")}/`));
  if (!allowed) {
    throw new Error(`该角色无权写入或枚举此路径：${relativePath}`);
  }
  const target = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    ...(allowDirectory ? {} : { expectedKind: "file" as const }),
    label: "MCP 项目路径"
  });
  return { relativePath, absolutePath: target.absolutePath };
}

function assertNotInternalPath(path: string): void {
  const roots = [".git", ".be-the-producer", "node_modules", "library", "temp", "local"];
  if (roots.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error(`Harness 不允许访问内部或临时目录：${path}`);
  }
}

function listFiles(directory: string, limit: number): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  if (statSync(directory).isFile()) {
    return [directory];
  }
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (files.length >= limit) {
        return;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`MCP 文件枚举拒绝符号链接：${relative(projectRoot, join(current, entry.name)).split(sep).join("/")}`);
      }
      if ([".git", ".be-the-producer", "node_modules", "library", "temp"].includes(entry.name)) {
        continue;
      }
      const childPath = relative(projectRoot, join(current, entry.name)).split(sep).join("/");
      const absolutePath = resolvePathWithinRoot(projectRoot, childPath, {
        allowMissing: false,
        label: "MCP 文件枚举路径"
      }).absolutePath;
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  };
  visit(directory);
  return files;
}

function respond(id: JsonRpcRequest["id"], result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: JsonRpcRequest["id"], code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} 必须是${allowEmpty ? "" : "非空"}字符串。`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
