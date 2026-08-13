import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AgentContract, Artifact, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import { inferArtifactType, stableArtifactId, type ToolExecutionResult } from "./toolExecutor.js";
import { artifactFilePath, hashWorkspaceFile } from "./workspaceWriter.js";
import { parsePlaytestMarker } from "./playtestEvidence.js";
import type { AgentHarnessToolOperation } from "./agentHarness.js";
import { isQaHarnessManagedPath } from "./qaEvidenceProtection.js";
import { assertAgentPathAuthorized } from "./toolAuthorization.js";
import { resolvePathWithinRoot } from "./pathSafety.js";

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
  invocationToolOperations?: AgentHarnessToolOperation[]
): HarnessEvidenceResult {
  const workspaceChangedPaths = [...after.values()]
    .filter((file) => before.get(file.path)?.hash !== file.hash)
    .map((file) => file.path)
    .sort();
  const changedPaths = invocationChangedPaths
    ? [...new Set(invocationChangedPaths)].filter((path) => after.has(path)).sort()
    : workspaceChangedPaths;
  const deletedPaths = [...before.keys()].filter((path) => !after.has(path)).sort();
  const protectedMutationPaths = changedPaths.filter((path) => {
    if (!isQaHarnessManagedPath(path)) return false;
    return invocationToolOperations?.filter((operation) => operation.path === path).at(-1)?.toolName !== "run_playtest";
  });
  const violations = [
    ...changedPaths.filter((path) => !isAllowedAgentPath(kernel, task, agent, path)),
    ...protectedMutationPaths.map((path) => `受保护 QA 机器证据被非 run_playtest 工具修改：${path}`),
    ...deletedPaths.map((path) => `删除：${path}`)
  ];
  const artifactIds = new Set<string>();
  const toolExecutions: ToolExecutionResult[] = [];
  const now = new Date().toISOString();

  for (const path of changedPaths) {
    if (violations.includes(path) || protectedMutationPaths.includes(path)) {
      continue;
    }
    const file = after.get(path);
    if (!file) {
      continue;
    }
    const existing = findArtifactForPath(kernel, task, path);
    const sourceOperation = invocationToolOperations?.filter((operation) => operation.path === path).at(-1);
    const sourceTool = sourceOperation?.toolName;
    const operationFailed = sourceOperation?.status === "failed" || sourceOperation?.bridgeOk === false;
    const playtest = path.endsWith(".md") ? parsePlaytestMarker(readFileSync(file.absolutePath, "utf8")) : undefined;
    const artifact: Artifact = {
      artifactId: existing?.artifactId ?? stableArtifactId(kernel.project.projectId, agent.agentId, path),
      projectId: kernel.project.projectId,
      type: existing?.type ?? inferArtifactType(agent.agentId, path),
      path: existing?.path ?? path,
      ownerAgentId: agent.agentId,
      stageId: kernel.project.currentStage,
      status: "submitted",
      version: (existing?.version ?? 0) + 1,
      sourceTaskId: task.taskId,
      sourceDecisionIds: existing?.sourceDecisionIds ?? [],
      metadata: {
        ...(existing?.metadata ?? {}),
        generatedBy: "claude_cli_harness",
        nativeHarnessManaged: true,
        harnessInvocationId: invocationId,
        ...(sourceTool ? { harnessToolName: sourceTool } : {}),
        ...(sourceOperation?.operationId ? { bridgeOperationId: sourceOperation.operationId } : {}),
        ...(sourceOperation?.operationType ? { bridgeOperationType: sourceOperation.operationType } : {}),
        ...(sourceOperation?.bridgeOk !== undefined ? { bridgeOk: sourceOperation.bridgeOk } : {}),
        ...(sourceOperation?.error ? { harnessToolError: sourceOperation.error } : {}),
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
    const stored = kernel.upsertArtifact(artifact);
    stored.metadata = artifact.metadata;
    stored.status = operationFailed || (playtest && playtest.verdict !== "pass") ? "change_requested" : "submitted";
    stored.updatedAt = file.updatedAt;
    kernel.recordArtifactMaterialization(stored.artifactId, {
      path,
      hash: file.hash,
      sizeBytes: file.sizeBytes,
      materializedAt: file.updatedAt,
      ...(sourceOperation?.directoryManifest ? { directoryManifest: sourceOperation.directoryManifest } : {})
    });
    artifactIds.add(stored.artifactId);
    toolExecutions.push({
      toolName: "write_artifact",
      status: operationFailed ? "failed" : "completed",
      path,
      artifactId: stored.artifactId,
      hash: file.hash,
      sizeBytes: file.sizeBytes
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
