import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import type { Artifact, MemoryRecord, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import {
  assertSafePathSegment,
  assertSafeAbsoluteFile,
  normalizeRelativePathWithinRoot,
  resolvePathWithinRoot
} from "./pathSafety.js";

export interface WorkspaceSyncResult {
  projectRoot: string;
  cocosProjectRoot: string;
  cocosAssetsRoot: string;
  filesWritten: string[];
}

export interface WorkspaceTreeEntry {
  path: string;
  type: "file" | "directory";
  sizeBytes?: number;
  updatedAt?: string;
}

export interface ArtifactWorkspaceTarget {
  projectRoot: string;
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  type?: "file" | "directory";
  sizeBytes?: number;
  updatedAt?: string;
}

export type WorkspacePathTarget = ArtifactWorkspaceTarget;

export interface WorkspacePathOpenTarget {
  requestedPath: string;
  target: WorkspacePathTarget;
  exact: boolean;
  nearestTarget?: WorkspacePathTarget;
}

export interface ArtifactPreviewResult {
  artifact: Artifact;
  target: Omit<ArtifactWorkspaceTarget, "absolutePath">;
  previewable: boolean;
  content?: string;
  language?: "markdown" | "json" | "text";
  reason?: string;
}

export interface ToolArtifactWriteResult {
  projectRoot: string;
  relativePath: string;
  absolutePath: string;
  content: string;
  hash: string;
  sizeBytes: number;
  materializedAt: string;
}

const defaultWorkspaceRoot = (): string =>
  process.env.STUDIO_WORKSPACE_ROOT ?? join(process.env.INIT_CWD ?? process.cwd(), "studio", "projects");

function ensureProjectWorkspaceRoot(projectId: string, workspaceRoot: string): string {
  const projectRoot = resolveProjectWorkspaceRoot(projectId, workspaceRoot);
  mkdirSync(projectRoot, { recursive: true });
  return resolvePathWithinRoot(workspaceRoot, assertSafePathSegment(projectId, "projectId"), {
    allowMissing: false,
    expectedKind: "directory",
    label: "项目工作区"
  }).absolutePath;
}

function ensureSafeDirectory(root: string, path: string, label: string): string {
  const requested = path === "." ? "." : safeWorkspacePath(path);
  let resolved = resolvePathWithinRoot(root, requested, {
    allowMissing: true,
    allowRoot: true,
    expectedKind: "directory",
    label
  });
  mkdirSync(resolved.absolutePath, { recursive: true });
  resolved = resolvePathWithinRoot(root, requested, {
    allowMissing: false,
    allowRoot: true,
    expectedKind: "directory",
    label
  });
  return resolved.absolutePath;
}

export function resolveProjectWorkspaceRoot(projectId: string, workspaceRoot = defaultWorkspaceRoot()): string {
  const safeProjectId = assertSafePathSegment(projectId, "projectId");
  return resolvePathWithinRoot(workspaceRoot, safeProjectId, {
    allowMissing: true,
    expectedKind: "directory",
    label: "项目工作区"
  }).absolutePath;
}

export function syncProjectWorkspace(kernel: StudioKernel, workspaceRoot = defaultWorkspaceRoot()): WorkspaceSyncResult {
  const projectRoot = ensureProjectWorkspaceRoot(kernel.project.projectId, workspaceRoot);
  const filesWritten: string[] = [];
  const taskBoard = kernel.buildTaskBoard();
  const messages = kernel.listMessages();
  const activities = kernel.listAgentActivities();
  const tasks = kernel.listTasks();
  const artifacts = kernel.listArtifacts();
  const claimRepairs = kernel.listClaimRepairs();
  const memory = kernel.memory.query({
    projectId: kernel.project.projectId,
    status: ["active", "draft", "superseded", "rejected", "archived"]
  });

  writeCocosProjectScaffold(projectRoot, kernel, filesWritten);
  writeJson(projectRoot, "shared/milestones/project.json", kernel.project, filesWritten);
  writeJson(projectRoot, "shared/workflow/workflow.json", kernel.getWorkflowSnapshot(), filesWritten);
  writeJson(projectRoot, "shared/workflow/events.json", kernel.listWorkflowEvents(), filesWritten);
  writeJson(projectRoot, "shared/task-board/current-status.json", taskBoard, filesWritten);
  writeJson(projectRoot, "shared/tasks/tasks.json", tasks, filesWritten);
  writeJson(projectRoot, "shared/chat/messages.json", messages, filesWritten);
  writeJson(projectRoot, "shared/chat/activities.json", activities, filesWritten);
  writeJsonLines(projectRoot, "shared/memory/project-memory.jsonl", memory, filesWritten);
  writeText(projectRoot, "README.md", renderProjectReadme(kernel, taskBoard.total, artifacts.length, memory.length, claimRepairs.length), filesWritten);

  for (const agent of kernel.agents.list()) {
    writeText(
      projectRoot,
      join(agent.workspace, "workspace-summary.md"),
      renderAgentSummary(agent.agentId, tasks, artifacts, messages, memory, claimRepairs),
      filesWritten
    );
  }

  for (const artifact of artifacts) {
    writeArtifactFile(projectRoot, kernel, artifact, tasks, memory, filesWritten);
  }

  writeJson(projectRoot, "shared/artifacts/artifacts.json", kernel.listArtifacts(), filesWritten);
  writeJson(projectRoot, "shared/artifacts/artifact-ledger.json", kernel.listArtifactLedger(), filesWritten);
  writeJson(projectRoot, "shared/artifacts/artifact-operations.json", kernel.listArtifactOperations(), filesWritten);
  writeJson(projectRoot, "shared/claims/claim-verifications.json", kernel.listClaimVerifications(), filesWritten);
  writeJson(projectRoot, "shared/claims/claim-repairs.json", claimRepairs, filesWritten);
  writeJson(projectRoot, "shared/audit/audit-events.json", kernel.listAuditEvents(), filesWritten);

  return {
    projectRoot,
    cocosProjectRoot: projectRoot,
    cocosAssetsRoot: join(projectRoot, "assets"),
    filesWritten
  };
}

export function readWorkspaceTree(projectId: string, workspaceRoot = defaultWorkspaceRoot()): {
  projectRoot: string;
  entries: WorkspaceTreeEntry[];
} {
  const projectRoot = resolveProjectWorkspaceRoot(projectId, workspaceRoot);
  if (!existsSync(projectRoot)) {
    return {
      projectRoot,
      entries: []
    };
  }

  return {
    projectRoot,
    entries: listWorkspaceEntries(projectRoot, projectRoot)
  };
}

export function deleteProjectWorkspace(projectId: string, workspaceRoot = defaultWorkspaceRoot()): void {
  const safeProjectId = assertSafePathSegment(projectId, "projectId");
  const projectRoot = resolvePathWithinRoot(workspaceRoot, safeProjectId, {
    allowMissing: true,
    expectedKind: "directory",
    label: "待删除项目工作区"
  }).absolutePath;
  rmSync(projectRoot, {
    recursive: true,
    force: true
  });
}

export function writeToolArtifactContent(
  kernel: StudioKernel,
  artifact: Artifact,
  input: { content: string; mode: "replace" | "append" },
  workspaceRoot = defaultWorkspaceRoot()
): ToolArtifactWriteResult {
  const projectRoot = ensureProjectWorkspaceRoot(kernel.project.projectId, workspaceRoot);
  const filesWritten: string[] = [];
  writeCocosProjectScaffold(projectRoot, kernel, filesWritten);

  const relativePath = safeWorkspacePath(artifactFilePath(artifact));
  const absolutePath = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    expectedKind: "file",
    label: "交付物路径"
  }).absolutePath;

  const previousContent = input.mode === "append" && existsSync(absolutePath) && statSync(absolutePath).isFile() ? readFileSync(absolutePath, "utf8") : "";
  const separator = previousContent && !previousContent.endsWith("\n") ? "\n" : "";
  const content = input.mode === "append" && previousContent ? `${previousContent}${separator}${input.content}` : input.content;
  writeText(projectRoot, relativePath, content.endsWith("\n") ? content : `${content}\n`, filesWritten);

  const stats = statSync(absolutePath);
  const hash = hashWorkspaceFile(absolutePath);
  const materializedAt = stats.mtime.toISOString();
  return {
    projectRoot,
    relativePath: relative(projectRoot, absolutePath).split(sep).join("/"),
    absolutePath,
    content: readFileSync(absolutePath, "utf8"),
    hash,
    sizeBytes: stats.size,
    materializedAt
  };
}

export function resolveArtifactWorkspaceTarget(
  projectId: string,
  artifact: Artifact,
  workspaceRoot = defaultWorkspaceRoot()
): ArtifactWorkspaceTarget {
  const projectRoot = resolveProjectWorkspaceRoot(projectId, workspaceRoot);
  const relativePath = safeWorkspacePath(artifactFilePath(artifact));
  const resolved = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    expectedKind: "file",
    label: "交付物路径"
  });
  const absolutePath = resolved.absolutePath;

  if (!existsSync(absolutePath)) {
    return {
      projectRoot,
      relativePath: relativePath.split(sep).join("/"),
      absolutePath,
      exists: false
    };
  }

  const stats = statSync(absolutePath);
  return {
    projectRoot,
    relativePath: relative(projectRoot, absolutePath).split(sep).join("/"),
    absolutePath,
    exists: true,
    type: stats.isDirectory() ? "directory" : "file",
    ...(stats.isFile() ? { sizeBytes: stats.size } : {}),
    updatedAt: stats.mtime.toISOString()
  };
}

export function resolveWorkspacePathTarget(
  projectId: string,
  path: string,
  workspaceRoot = defaultWorkspaceRoot()
): WorkspacePathTarget {
  const projectRoot = resolveProjectWorkspaceRoot(projectId, workspaceRoot);
  const relativePath = safeWorkspacePath(path);
  const resolved = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    label: "工作区路径"
  });
  const absolutePath = resolved.absolutePath;

  if (!existsSync(absolutePath)) {
    return {
      projectRoot,
      relativePath: relativePath.split(sep).join("/"),
      absolutePath,
      exists: false
    };
  }

  const stats = statSync(absolutePath);
  return {
    projectRoot,
    relativePath: relative(projectRoot, absolutePath).split(sep).join("/"),
    absolutePath,
    exists: true,
    type: stats.isDirectory() ? "directory" : "file",
    ...(stats.isFile() ? { sizeBytes: stats.size } : {}),
    updatedAt: stats.mtime.toISOString()
  };
}

export function resolveWorkspacePathOpenTarget(
  projectId: string,
  path: string,
  workspaceRoot = defaultWorkspaceRoot()
): WorkspacePathOpenTarget {
  const requested = resolveWorkspacePathTarget(projectId, path, workspaceRoot);
  if (requested.exists) {
    return {
      requestedPath: requested.relativePath,
      target: requested,
      exact: true
    };
  }

  const projectRoot = resolveProjectWorkspaceRoot(projectId, workspaceRoot);
  let fallbackRelativePath = dirname(requested.relativePath);
  while (fallbackRelativePath && fallbackRelativePath !== "." && fallbackRelativePath !== "..") {
    const candidatePath = safeWorkspacePath(fallbackRelativePath);
    const absolutePath = resolvePathWithinRoot(projectRoot, candidatePath, {
      allowMissing: true,
      label: "工作区回退路径"
    }).absolutePath;

    if (existsSync(absolutePath)) {
      const stats = statSync(absolutePath);
      return {
        requestedPath: requested.relativePath,
        target: requested,
        exact: false,
        nearestTarget: {
          projectRoot,
          relativePath: relative(projectRoot, absolutePath).split(sep).join("/"),
          absolutePath,
          exists: true,
          type: stats.isDirectory() ? "directory" : "file",
          ...(stats.isFile() ? { sizeBytes: stats.size } : {}),
          updatedAt: stats.mtime.toISOString()
        }
      };
    }

    fallbackRelativePath = dirname(fallbackRelativePath);
  }

  if (existsSync(projectRoot)) {
    const stats = statSync(projectRoot);
    return {
      requestedPath: requested.relativePath,
      target: requested,
      exact: false,
      nearestTarget: {
        projectRoot,
        relativePath: ".",
        absolutePath: projectRoot,
        exists: true,
        type: stats.isDirectory() ? "directory" : "file",
        ...(stats.isFile() ? { sizeBytes: stats.size } : {}),
        updatedAt: stats.mtime.toISOString()
      }
    };
  }

  return {
    requestedPath: requested.relativePath,
    target: requested,
    exact: false
  };
}

export function readArtifactPreview(projectId: string, artifact: Artifact): ArtifactPreviewResult {
  const target = resolveArtifactWorkspaceTarget(projectId, artifact);
  const publicTarget = toPublicTarget(target);
  if (!target.exists) {
    return {
      artifact,
      target: publicTarget,
      previewable: false,
      reason: "交付物文件尚未写入本地工作空间。"
    };
  }

  if (target.type !== "file") {
    return {
      artifact,
      target: publicTarget,
      previewable: false,
      reason: "该交付物是目录或二进制资产，暂不支持内嵌预览。"
    };
  }

  if (!isPreviewableDocument(target.relativePath)) {
    return {
      artifact,
      target: publicTarget,
      previewable: false,
      reason: "该文件类型暂不支持内嵌预览，请在 Finder 中查看。"
    };
  }

  const maxPreviewBytes = 512 * 1024;
  if ((target.sizeBytes ?? 0) > maxPreviewBytes) {
    return {
      artifact,
      target: publicTarget,
      previewable: false,
      reason: "该文档超过 512KB，暂不在页面内预览，请在 Finder 中查看。"
    };
  }

  const rawContent = readFileSync(target.absolutePath, "utf8");
  const language = previewLanguage(target.relativePath);
  const content = language === "json" ? formatJsonPreview(rawContent) : rawContent;
  return {
    artifact,
    target: publicTarget,
    previewable: true,
    content,
    language
  };
}

export function readArtifactContentForModel(projectId: string, artifact: Artifact, maxCharacters = 12_000): string | undefined {
  const target = resolveArtifactWorkspaceTarget(projectId, artifact);
  if (!target.exists || target.type !== "file" || !isModelReadableText(target.relativePath)) {
    return undefined;
  }
  const content = readFileSync(target.absolutePath, "utf8");
  if (content.length <= maxCharacters) {
    return content;
  }
  return `${content.slice(0, maxCharacters)}\n\n[内容已截断，共 ${content.length} 字符]`;
}

export function isPreviewableDocument(path: string): boolean {
  return [".md", ".markdown", ".txt", ".json", ".jsonl", ".log"].includes(extname(path).toLowerCase());
}

function isModelReadableText(path: string): boolean {
  return [
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".jsonl",
    ".log",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".cjs",
    ".css",
    ".html",
    ".xml",
    ".yaml",
    ".yml",
    ".toml"
  ].includes(extname(path).toLowerCase());
}

function listWorkspaceEntries(root: string, current: string): WorkspaceTreeEntry[] {
  const entries: WorkspaceTreeEntry[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const name = entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`工作区读取拒绝符号链接：${relative(root, join(current, name)).split(sep).join("/")}`);
    }
    if (name === "secrets") {
      continue;
    }
    const entryPath = relative(root, join(current, name)).split(sep).join("/");
    const absolutePath = resolvePathWithinRoot(root, entryPath, {
      allowMissing: false,
      label: "工作区读取路径"
    }).absolutePath;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      entries.push({
        path: entryPath,
        type: "directory",
        updatedAt: stats.mtime.toISOString()
      });
      entries.push(...listWorkspaceEntries(root, absolutePath));
      continue;
    }

    entries.push({
      path: entryPath,
      type: "file",
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString()
    });
  }
  return entries;
}

function writeJson(projectRoot: string, path: string, value: unknown, filesWritten: string[]): void {
  writeText(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`, filesWritten);
}

function writeJsonLines(projectRoot: string, path: string, records: MemoryRecord[], filesWritten: string[]): void {
  writeText(projectRoot, path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, filesWritten);
}

function writeCocosProjectScaffold(projectRoot: string, kernel: StudioKernel, filesWritten: string[]): void {
  const now = new Date().toISOString();
  const packageName = sanitizePackageName(kernel.project.name, kernel.project.projectId);
  const cocosMetadata = {
    projectId: kernel.project.projectId,
    projectName: kernel.project.name,
    producerId: kernel.project.producerId,
    currentStage: kernel.project.currentStage,
    executionStatus: kernel.project.executionStatus,
    cocosProjectRoot: ".",
    cocosAssetsRoot: "assets",
    generatedBy: "Be The Producer",
    updatedAt: now,
    categories: {
      cocosAssets: ["assets/scenes", "assets/scripts", "assets/prefabs", "assets/resources", "assets/art", "assets/audio"],
      designDocs: ["docs/design", "intermediate/design", "artifacts/design"],
      artPipeline: ["docs/art", "intermediate/art", "artifacts/art", "assets/art"],
      engineering: ["docs/technical", "intermediate/engineering", "assets/scripts", "cocos/import-map"],
      qa: ["docs/qa", "intermediate/qa", "artifacts/qa"],
      buildsAndRelease: ["builds/wechat-dev", "builds/wechat-release", "outputs/playable", "outputs/release", "release/deployments", "release/rollback"]
    }
  };

  writeTextIfMissing(
    projectRoot,
    "package.json",
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        description: `${kernel.project.name} Cocos Creator project generated by Be The Producer.`,
        scripts: {
          "btp:workspace": "echo This folder is the Be The Producer project workspace and Cocos Creator project root."
        },
        creator: {
          version: "3.x"
        },
        beTheProducer: {
          projectId: kernel.project.projectId,
          generated: true
        }
      },
      null,
      2
    )}\n`,
    filesWritten
  );
  writeTextIfMissing(
    projectRoot,
    "tsconfig.json",
    `${JSON.stringify(
      {
        extends: "./temp/tsconfig.cocos.json",
        compilerOptions: {
          strict: true,
          noImplicitAny: false,
          experimentalDecorators: true
        },
        include: ["assets/**/*.ts", "cocos/**/*.ts"]
      },
      null,
      2
    )}\n`,
    filesWritten
  );
  writeTextIfMissing(
    projectRoot,
    ".gitignore",
    ["library/", "temp/", "local/", "build/", "*.log", ".DS_Store", "node_modules/"].join("\n") + "\n",
    filesWritten
  );
  writeJson(projectRoot, "settings/be-the-producer.project.json", cocosMetadata, filesWritten);
  writeJson(projectRoot, "shared/cocos/project-root.json", cocosMetadata, filesWritten);
  writeTextIfMissing(
    projectRoot,
    "assets/README.md",
    [
      "# Cocos Assets",
      "",
      "This directory is the Cocos Creator assets root for the project.",
      "",
      "- scenes: playable scenes and scene blueprints",
      "- scripts: TypeScript gameplay and UI code",
      "- prefabs: reusable Cocos prefabs",
      "- resources: runtime-loadable resources",
      "- art: approved visual assets",
      "- audio: approved audio assets"
    ].join("\n") + "\n",
    filesWritten
  );

  for (const directory of cocosWorkspaceDirectories()) {
    writeText(projectRoot, join(directory, ".gitkeep"), "", filesWritten);
  }
}

function cocosWorkspaceDirectories(): string[] {
  return [
    "assets/scenes",
    "assets/scripts",
    "assets/prefabs",
    "assets/resources",
    "assets/art",
    "assets/audio",
    "docs/design",
    "docs/art",
    "docs/technical",
    "docs/qa",
    "intermediate/design",
    "intermediate/art",
    "intermediate/engineering",
    "intermediate/qa",
    "artifacts/design",
    "artifacts/art",
    "artifacts/builds",
    "artifacts/qa",
    "artifacts/release",
    "outputs/playable",
    "outputs/release",
    "builds/wechat-dev",
    "builds/wechat-release",
    "release/deployments",
    "release/rollback",
    "cocos/extensions",
    "cocos/import-map"
  ];
}

function writeTextIfMissing(projectRoot: string, path: string, content: string, filesWritten: string[]): void {
  const safePath = safeWorkspacePath(path);
  const absolutePath = resolvePathWithinRoot(projectRoot, safePath, {
    allowMissing: true,
    expectedKind: "file",
    label: "工作区写入路径"
  }).absolutePath;
  if (existsSync(absolutePath)) {
    return;
  }

  writeText(projectRoot, path, content, filesWritten);
}

function writeText(projectRoot: string, path: string, content: string, filesWritten: string[]): void {
  const safePath = safeWorkspacePath(path);
  let resolved = resolvePathWithinRoot(projectRoot, safePath, {
    allowMissing: true,
    expectedKind: "file",
    label: "工作区写入路径"
  });
  ensureSafeDirectory(projectRoot, dirname(safePath), "工作区写入父目录");
  resolved = resolvePathWithinRoot(projectRoot, safePath, {
    allowMissing: true,
    expectedKind: "file",
    label: "工作区写入路径"
  });
  const absolutePath = resolved.absolutePath;
  if (existsSync(absolutePath) && statSync(absolutePath).isFile() && readFileSync(absolutePath, "utf8") === content) {
    return;
  }

  writeFileSync(absolutePath, content, "utf8");
  filesWritten.push(relative(projectRoot, absolutePath).split(sep).join("/"));
}

function writeArtifactFile(
  projectRoot: string,
  kernel: StudioKernel,
  artifact: Artifact,
  tasks: Task[],
  memory: MemoryRecord[],
  filesWritten: string[]
): void {
  const targetPath = artifactFilePath(artifact);
  const sourceTask = artifact.sourceTaskId ? tasks.find((task) => task.taskId === artifact.sourceTaskId) : undefined;
  const sourceMemory = memory.filter((record) => record.sourceArtifactId === artifact.artifactId || record.ownerAgent === artifact.ownerAgentId);
  const artifactDocument = artifactDocumentView(artifact);
  const toolContent = typeof artifact.metadata.toolContent === "string" ? artifact.metadata.toolContent : undefined;

  if (artifact.metadata.nativeHarnessManaged === true) {
    const absolutePath = resolvePathWithinRoot(projectRoot, safeWorkspacePath(targetPath), {
      allowMissing: true,
      expectedKind: "file",
      label: "Harness 交付物路径"
    }).absolutePath;
    if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
      recordArtifactFileEvidence(projectRoot, kernel, artifact, targetPath);
      return;
    }
  }

  if (toolContent !== undefined) {
    writeText(projectRoot, targetPath, toolContent.endsWith("\n") ? toolContent : `${toolContent}\n`, filesWritten);
    recordArtifactFileEvidence(projectRoot, kernel, artifact, targetPath);
    return;
  }

  if (targetPath.endsWith(".json")) {
    writeJson(projectRoot, targetPath, { artifact: artifactDocument, sourceTask, relatedMemory: sourceMemory }, filesWritten);
    return;
  }

  writeText(projectRoot, targetPath, renderArtifactMarkdown(artifact, sourceTask, sourceMemory), filesWritten);
}

function artifactDocumentView(artifact: Artifact): Artifact {
  const artifactWithoutChecksum = { ...artifact };
  delete artifactWithoutChecksum.checksum;
  return artifactWithoutChecksum;
}

export function artifactFilePath(artifact: Artifact): string {
  const extension = extname(artifact.path);
  if (extension) {
    return artifact.path;
  }

  if (artifact.type === "build") {
    return join(artifact.path, "build-report.json");
  }

  return join(artifact.path, "README.md");
}

function safeWorkspacePath(path: string): string {
  return normalizeRelativePathWithinRoot(path, { label: "工作区路径" });
}

function recordArtifactFileEvidence(projectRoot: string, kernel: StudioKernel, artifact: Artifact, path: string): void {
  const safePath = safeWorkspacePath(path);
  const absolutePath = resolvePathWithinRoot(projectRoot, safePath, {
    allowMissing: true,
    expectedKind: "file",
    label: "交付物证据路径"
  }).absolutePath;
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return;
  }

  const stats = statSync(absolutePath);
  const directoryManifest = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId)?.directoryManifest;
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path: relative(projectRoot, absolutePath).split(sep).join("/"),
    hash: hashWorkspaceFile(absolutePath),
    sizeBytes: stats.size,
    materializedAt: stats.mtime.toISOString(),
    ...(directoryManifest ? { directoryManifest } : {})
  });
}

export function hashWorkspaceFile(absolutePath: string): string {
  const safePath = assertSafeAbsoluteFile(absolutePath, "待哈希工作区文件");
  return createHash("sha256").update(readFileSync(safePath)).digest("hex");
}

function sanitizePackageName(projectName: string, projectId: string): string {
  const safeName = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9~-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  const base = safeName(projectName || projectId);
  return base || safeName(projectId) || "be-the-producer-game";
}

function toPublicTarget(target: ArtifactWorkspaceTarget): Omit<ArtifactWorkspaceTarget, "absolutePath"> {
  return {
    projectRoot: target.projectRoot,
    relativePath: target.relativePath,
    exists: target.exists,
    ...(target.type ? { type: target.type } : {}),
    ...(target.sizeBytes !== undefined ? { sizeBytes: target.sizeBytes } : {}),
    ...(target.updatedAt ? { updatedAt: target.updatedAt } : {})
  };
}

function previewLanguage(path: string): "markdown" | "json" | "text" {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".json" || extension === ".jsonl") {
    return "json";
  }
  return "text";
}

function formatJsonPreview(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function renderProjectReadme(kernel: StudioKernel, totalTasks: number, totalArtifacts: number, totalMemory: number, totalClaimRepairs: number): string {
  return `# ${kernel.project.name}

Project ID: ${kernel.project.projectId}

Current stage: ${kernel.project.currentStage}

This folder is the local project workspace and the Cocos Creator project root. All assets, intermediate outputs, reviewable artifacts, build records, producer decisions, agent workspaces, task state, memory, and audit events are stored inside this project folder.

## Snapshot

- Tasks: ${totalTasks}
- Artifacts: ${totalArtifacts}
- Claim repairs: ${totalClaimRepairs}
- Memory records: ${totalMemory}

## Key Files

- package.json
- assets/
- settings/be-the-producer.project.json
- shared/cocos/project-root.json
- shared/task-board/current-status.json
- shared/chat/messages.json
- shared/audit/audit-events.json
- shared/memory/project-memory.jsonl
- shared/artifacts/artifacts.json
- shared/claims/claim-repairs.json
`;
}

function renderAgentSummary(
  agentId: string,
  tasks: Task[],
  artifacts: Artifact[],
  messages: StudioMessage[],
  memory: MemoryRecord[],
  claimRepairs: ReturnType<StudioKernel["listClaimRepairs"]>
): string {
  const ownedTasks = tasks.filter((task) => task.ownerAgentId === agentId);
  const ownedArtifacts = artifacts.filter((artifact) => artifact.ownerAgentId === agentId);
  const agentMessages = messages.filter((message) => message.senderId === agentId);
  const agentMemory = memory.filter((record) => record.ownerAgent === agentId);
  const ownedRepairs = claimRepairs.filter((repair) => repair.agentId === agentId);

  return `# ${agentId} Workspace

## Tasks

${renderTaskList(ownedTasks)}

## Claim Repairs

${renderClaimRepairList(ownedRepairs)}

## Artifacts

${renderArtifactList(ownedArtifacts)}

## Recent Messages

${renderMessageList(agentMessages.slice(-10))}

## Memory

${agentMemory.map((record) => `- ${record.type} [${record.status}]: ${record.content}`).join("\n") || "- No memory records yet."}
`;
}

function renderArtifactMarkdown(artifact: Artifact, sourceTask: Task | undefined, sourceMemory: MemoryRecord[]): string {
  return `# ${artifact.artifactId}

Type: ${artifact.type}

Owner: ${artifact.ownerAgentId}

Stage: ${artifact.stageId}

Status: ${artifact.status}

Version: ${artifact.version}

## Source Task

${sourceTask ? `- ${sourceTask.title} [${sourceTask.status}]` : "- No source task recorded."}

## Metadata

\`\`\`json
${JSON.stringify(artifact.metadata, null, 2)}
\`\`\`

## Related Memory

${sourceMemory.map((record) => `- ${record.type} [${record.status}]: ${record.content}`).join("\n") || "- No related memory records."}
`;
}

function renderTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "- No tasks assigned yet.";
  }

  return tasks.map((task) => `- ${task.title} [${task.status}] (${task.taskId})`).join("\n");
}

function renderArtifactList(artifacts: Artifact[]): string {
  if (artifacts.length === 0) {
    return "- No artifacts owned yet.";
  }

  return artifacts.map((artifact) => `- ${artifact.artifactId} [${artifact.status}] -> ${artifact.path}`).join("\n");
}

function renderClaimRepairList(repairs: ReturnType<StudioKernel["listClaimRepairs"]>): string {
  if (repairs.length === 0) {
    return "- No claim repairs assigned.";
  }

  return repairs
    .map((repair) => {
      const target = repair.claimedPath ?? repair.claimId;
      const next = repair.status === "resolved" ? `resolved via ${repair.resolution}` : repair.action;
      return `- ${target} [${repair.status}] (${repair.taskId}) -> ${next}`;
    })
    .join("\n");
}

function renderMessageList(messages: StudioMessage[]): string {
  if (messages.length === 0) {
    return "- No messages sent yet.";
  }

  return messages.map((message) => `- ${message.createdAt} ${message.messageType}: ${message.content}`).join("\n");
}
