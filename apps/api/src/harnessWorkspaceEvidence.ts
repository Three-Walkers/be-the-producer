import { readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { AgentContract, Artifact, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import { inferArtifactType, stableArtifactId, type ToolExecutionResult } from "./toolExecutor.js";
import { artifactFilePath, hashWorkspaceFile } from "./workspaceWriter.js";

export interface WorkspaceFileEvidence {
  path: string;
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
  const files = new Map<string, WorkspaceFileEvidence>();
  walkDirectory(projectRoot, projectRoot, files);
  return files;
}

export function recordHarnessWorkspaceChanges(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  invocationId: string,
  invocationChangedPaths?: string[]
): HarnessEvidenceResult {
  const workspaceChangedPaths = [...after.values()]
    .filter((file) => before.get(file.path)?.hash !== file.hash)
    .map((file) => file.path)
    .sort();
  const changedPaths = invocationChangedPaths
    ? [...new Set(invocationChangedPaths)].filter((path) => workspaceChangedPaths.includes(path)).sort()
    : workspaceChangedPaths;
  const deletedPaths = [...before.keys()].filter((path) => !after.has(path)).sort();
  const expectedArtifacts = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const violations = [
    ...changedPaths.filter((path) => !isAllowedAgentPath(agent, path, expectedArtifacts)),
    ...deletedPaths.map((path) => `删除：${path}`)
  ];
  const artifactIds = new Set<string>();
  const toolExecutions: ToolExecutionResult[] = [];
  const now = new Date().toISOString();

  for (const path of changedPaths) {
    if (violations.includes(path)) {
      continue;
    }
    const file = after.get(path);
    if (!file) {
      continue;
    }
    const existing = findArtifactForPath(kernel, task, path);
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
        toolExecutedAt: now,
        changedPath: path
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: file.updatedAt
    };
    const stored = kernel.upsertArtifact(artifact);
    stored.metadata = artifact.metadata;
    stored.status = "submitted";
    stored.updatedAt = file.updatedAt;
    kernel.recordArtifactMaterialization(stored.artifactId, {
      path,
      hash: file.hash,
      sizeBytes: file.sizeBytes,
      materializedAt: file.updatedAt
    });
    artifactIds.add(stored.artifactId);
    toolExecutions.push({
      toolName: "write_artifact",
      status: "completed",
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
    if (entry.isSymbolicLink() || (entry.isDirectory() && ignoredDirectoryNames.has(entry.name))) {
      continue;
    }
    const absolutePath = resolve(directory, entry.name);
    const path = relative(root, absolutePath).split(sep).join("/");
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

function isAllowedAgentPath(agent: AgentContract, path: string, expectedArtifacts: Artifact[]): boolean {
  if (expectedArtifacts.some((artifact) => path === artifact.path || path === artifactFilePath(artifact).replaceAll("\\", "/") || path.startsWith(`${artifact.path.replace(/\/+$/, "")}/`))) {
    return true;
  }
  return allowedRootsForAgent(agent).some((root) => path === root || path.startsWith(`${root}/`));
}

export function allowedRootsForAgent(agent: AgentContract): string[] {
  const ownWorkspace = agent.workspace.replace(/^\.\//, "").replace(/\/+$/, "");
  const common: Record<string, string[]> = {
    studio_orchestrator: ["shared/milestones", "docs/production"],
    producer: ["agents/producer", "docs/production", "shared/milestones"],
    game_designer: ["agents/design", "docs/design", "shared/milestones"],
    art_director: ["agents/art", "assets/art", "docs/art", "artifacts", "intermediate"],
    asset_production: ["agents/art/processed-assets", "assets/art", "artifacts", "intermediate"],
    cocos_tech_lead: ["agents/engineering", "assets", "settings", "docs/engineering", "intermediate"],
    gameplay_programmer: ["assets/scripts", "assets/resources", "docs/engineering", "intermediate"],
    cocos_automation: ["agents/cocos-automation", "assets", "settings", "builds", "intermediate"],
    qa_evaluator: ["agents/qa", "docs/qa", "artifacts", "outputs"],
    wechat_platform: ["shared/build-artifacts", "builds", "outputs", "release", "docs/release"],
    devops: ["agents/devops", "builds", "outputs", "release", "docs/release"],
    liveops_analytics: ["shared/release-notes", "docs/liveops", "release"]
  };
  return [...new Set([ownWorkspace, ...(common[agent.agentId] ?? [])])].filter(Boolean);
}
