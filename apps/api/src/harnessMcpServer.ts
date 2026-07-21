import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { rasterizeSvgFile } from "./svgRasterizer.js";
import { CocosEngineBridge, type CocosBridgeResult } from "./cocosEngineBridge.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { CocosPlaytestHarness } from "./cocosPlaytestHarness.js";
import { assertQaEvidenceWriteAllowed } from "./qaEvidenceProtection.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const projectRoot = resolve(requiredEnvironment("BTP_PROJECT_ROOT"));
const agentId = requiredEnvironment("BTP_AGENT_ID");
const allowedRoots = parseStringArray(process.env.BTP_ALLOWED_ROOTS);
const expectedPaths = parseStringArray(process.env.BTP_EXPECTED_PATHS);
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
  const tools: Array<Record<string, unknown>> = [
    {
      name: "write_artifact",
      title: "Write project artifact",
      description: "Create or replace a text file inside this role's authorized project paths. Use this instead of merely describing a file.",
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
      name: "list_files",
      title: "List project files",
      description: "List files below an authorized project-relative directory so the Agent can inspect actual workspace state.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Authorized project-relative directory; defaults to the role workspace" },
          limit: { type: "integer", minimum: 1, maximum: 300 }
        },
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
  if (process.env.BTP_ALLOW_PROJECT_CHECKS === "true") {
    tools.push({
      name: "run_project_check",
      title: "Run controlled project check",
      description: "Run one controlled validation command in the Cocos project without arbitrary shell access.",
      inputSchema: {
        type: "object",
        properties: {
          check: { type: "string", enum: ["typescript", "build", "tests", "git-diff"] }
        },
        required: ["check"],
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
  if (name === "write_artifact" || name === "append_document") {
    const path = requiredString(args.path, "path");
    const content = requiredString(args.content, "content", true);
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) {
      throw new Error("单次 MCP 文本写入不能超过 5 MB。");
    }
    const target = resolveAuthorizedTarget(path, false);
    assertQaEvidenceWriteAllowed(target.relativePath, name);
    mkdirSync(dirname(target.absolutePath), { recursive: true });
    if (name === "append_document") {
      const needsSeparator = existsSync(target.absolutePath) && statSync(target.absolutePath).size > 0 && !readFileSync(target.absolutePath, "utf8").endsWith("\n");
      appendFileSync(target.absolutePath, `${needsSeparator ? "\n" : ""}${content}${content.endsWith("\n") ? "" : "\n"}`, "utf8");
    } else {
      writeFileSync(target.absolutePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
    }
    const stats = statSync(target.absolutePath);
    const hash = createHash("sha256").update(readFileSync(target.absolutePath)).digest("hex");
    recordOperation(name, target.relativePath, hash, stats.size);
    return {
      content: [{ type: "text", text: `写入成功：${target.relativePath}；hash=${hash}；size=${stats.size} bytes` }],
      structuredContent: { path: target.relativePath, hash, sizeBytes: stats.size }
    };
  }
  if (name === "list_files") {
    const requestedPath = typeof args.path === "string" && args.path.trim() ? args.path : allowedRoots[0] ?? "";
    const target = resolveAuthorizedTarget(requestedPath, true);
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(300, Math.floor(args.limit))) : 120;
    const files = listFiles(target.absolutePath, limit).map((absolutePath) => relative(projectRoot, absolutePath).split(sep).join("/"));
    return {
      content: [{ type: "text", text: files.length > 0 ? files.join("\n") : "目录中暂无文件。" }],
      structuredContent: { path: target.relativePath, files }
    };
  }
  if (name === "render_svg_to_png" && ["art_director", "asset_production"].includes(agentId)) {
    const source = resolveAuthorizedTarget(requiredString(args.sourcePath, "sourcePath"), false);
    const target = resolveAuthorizedTarget(requiredString(args.path, "path"), false);
    const width = typeof args.width === "number" ? args.width : undefined;
    const rendered = rasterizeSvgFile(source.absolutePath, target.absolutePath, width);
    recordOperation(name, target.relativePath, rendered.hash, rendered.sizeBytes);
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
  if (name === "run_project_check" && process.env.BTP_ALLOW_PROJECT_CHECKS === "true") {
    const check = requiredString(args.check, "check");
    const command = projectCheckCommand(check);
    const result = spawnSync(command.executable, command.args, {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: safeCommandEnvironment()
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-8_000);
    const ok = result.status === 0;
    return {
      content: [{ type: "text", text: `${check} ${ok ? "通过" : "失败"}（exit=${result.status ?? "null"}）${output ? `\n${output}` : ""}` }],
      structuredContent: { check, ok, exitCode: result.status, output },
      isError: !ok
    };
  }
  if (name === "run_playtest" && agentId === "qa_evaluator") {
    const maxDurationSec = typeof args.maxDurationSec === "number" ? Math.max(10, Math.min(120, Math.floor(args.maxDurationSec))) : undefined;
    const result = await new CocosPlaytestHarness(projectRoot, cocosEngineSettingsStore.getResolvedConfig()).run({
      ...(maxDurationSec ? { maxDurationSec } : {}),
      ...(expectedPaths.find((path) => path.startsWith("agents/qa/") && path.endsWith(".md"))
        ? { reportPath: expectedPaths.find((path) => path.startsWith("agents/qa/") && path.endsWith(".md")) as string }
        : {})
    });
    for (const item of result.evidence) {
      recordOperation(name, item.path, item.hash, item.sizeBytes);
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
      recordOperation(name, item.path, item.hash, item.sizeBytes);
    }
    return {
      content: [{ type: "text", text: `${result.summary}${result.error ? `\n错误：${result.error}` : ""}\n报告：${result.reportPath}` }],
      structuredContent: result,
      isError: !result.ok
    };
  }
  throw new Error(`不支持的 BTP MCP 工具：${name || "unknown"}`);
}

function recordOperation(toolName: string, path: string, hash: string, sizeBytes: number): void {
  if (!operationLogPath) {
    return;
  }
  mkdirSync(dirname(operationLogPath), { recursive: true });
  appendFileSync(
    operationLogPath,
    `${JSON.stringify({ toolName, path, hash, sizeBytes, recordedAt: new Date().toISOString() })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function projectCheckCommand(check: string): { executable: string; args: string[] } {
  switch (check) {
    case "typescript":
      return { executable: "npx", args: ["--no-install", "tsc", "--noEmit"] };
    case "build":
      return { executable: "npm", args: ["run", "build", "--if-present"] };
    case "tests":
      return { executable: "npm", args: ["test", "--if-present"] };
    case "git-diff":
      return { executable: "git", args: ["diff", "--check"] };
    default:
      throw new Error(`不支持的项目检查：${check}`);
  }
}

function safeCommandEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(projectRoot, ".be-the-producer", "command-home"),
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    CI: "1"
  };
}

function resolveAuthorizedTarget(path: string, allowDirectory: boolean): { relativePath: string; absolutePath: string } {
  const cleaned = normalize(path.trim().replace(/^\.\/+/, ""));
  if (!cleaned || isAbsolute(cleaned) || cleaned.startsWith("..") || cleaned.includes(`${sep}..${sep}`)) {
    throw new Error(`不安全的项目路径：${path}`);
  }
  const relativePath = cleaned.split(sep).join("/");
  const allowed = allowedRoots.some((root) => relativePath === root || relativePath.startsWith(`${root}/`)) || expectedPaths.some((expected) => relativePath === expected || relativePath.startsWith(`${expected.replace(/\/+$/, "")}/`));
  if (!allowed) {
    throw new Error(`该角色无权写入或枚举此路径：${relativePath}`);
  }
  const absolutePath = resolve(projectRoot, cleaned);
  const inside = relative(projectRoot, absolutePath);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`路径超出项目根目录：${relativePath}`);
  }
  if (!allowDirectory && existsSync(absolutePath) && statSync(absolutePath).isDirectory()) {
    throw new Error(`目标是目录而不是文件：${relativePath}`);
  }
  return { relativePath, absolutePath };
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
      if (files.length >= limit || entry.isSymbolicLink() || [".git", ".be-the-producer", "node_modules", "library", "temp"].includes(entry.name)) {
        continue;
      }
      const absolutePath = join(current, entry.name);
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

function parseStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").map((item) => item.replace(/^\.\//, "").replace(/\/+$/, "")) : [];
  } catch {
    return [];
  }
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
