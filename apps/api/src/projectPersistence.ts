import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  createStudioKernelFromSnapshot,
  migrateLocalRuntimeSnapshot,
  type StudioKernel,
  type StudioKernelSnapshot
} from "@game-pipeline/agent-runtime";
import type { ProjectStateRepository, ProjectSummary } from "./projectStateRepository.js";

export type { ProjectStateRepository, ProjectSummary } from "./projectStateRepository.js";

const SNAPSHOT_FILE_NAME = "studio-state.json";
const BACKUP_FILE_NAME = "studio-state.backup.json";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ProjectPersistenceIssue {
  projectId: string;
  source: "primary" | "backup" | "directory";
  kind: "invalid_project_id" | "invalid_snapshot" | "restore_failed" | "recovered_from_backup" | "repair_failed";
  message: string;
  occurredAt: string;
}

interface LoadedSnapshot {
  snapshot: StudioKernelSnapshot;
  kernel: StudioKernel;
  raw: string;
  migrated: boolean;
}

/**
 * Local, single-process filesystem adapter for ProjectStateRepository.
 *
 * This improves crash safety for the local runtime, but is intentionally not a
 * replacement for a transactional production database or distributed lock.
 */
export class ProjectPersistenceStore implements ProjectStateRepository {
  private readonly dataRoot: string;
  private readonly issues: ProjectPersistenceIssue[] = [];

  constructor(dataRoot = defaultDataRoot()) {
    this.dataRoot = resolve(dataRoot);
  }

  loadAll(): StudioKernel[] {
    return this.projectDirectories()
      .map((projectId) => this.tryLoad(projectId))
      .filter((kernel): kernel is StudioKernel => Boolean(kernel));
  }

  listSummaries(): ProjectSummary[] {
    return this.projectDirectories()
      .map((projectId) => this.loadRecoverableSnapshot(projectId)?.snapshot)
      .filter((snapshot): snapshot is StudioKernelSnapshot => Boolean(snapshot))
      .map((snapshot) => snapshotSummary(snapshot))
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  save(kernel: StudioKernel): StudioKernelSnapshot {
    const snapshot = kernel.toSnapshot();
    const projectId = assertSafeProjectId(kernel.project.projectId);
    if (snapshot.project.projectId !== projectId) {
      throw new Error("Snapshot project ID does not match the kernel project ID");
    }

    const raw = serializeValidatedSnapshot(snapshot, projectId);
    const projectDirectory = this.ensureProjectDirectory(projectId);
    const primaryPath = join(projectDirectory, SNAPSHOT_FILE_NAME);
    const backupPath = join(projectDirectory, BACKUP_FILE_NAME);
    rejectSymbolicLink(primaryPath);
    rejectSymbolicLink(backupPath);

    const currentPrimary = this.tryReadSnapshotFile(primaryPath, projectId);
    if (currentPrimary) {
      atomicWriteFile(backupPath, currentPrimary.raw);
    }

    atomicWriteFile(primaryPath, raw);
    return snapshot;
  }

  load(projectId: string): StudioKernel | undefined {
    assertSafeProjectId(projectId);
    const loaded = this.loadRecoverableSnapshot(projectId);
    if (loaded?.migrated) {
      this.save(loaded.kernel);
    }
    return loaded?.kernel;
  }

  delete(projectId: string): void {
    const projectDirectory = this.projectDirectory(assertSafeProjectId(projectId));
    rejectSymbolicLink(projectDirectory);
    rmSync(projectDirectory, {
      recursive: true,
      force: true
    });
  }

  listIssues(): ProjectPersistenceIssue[] {
    return this.issues.map((issue) => ({ ...issue }));
  }

  private projectDirectories(): string[] {
    if (!existsSync(this.dataRoot)) {
      return [];
    }

    return readdirSync(this.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((projectId) => {
        try {
          assertSafeProjectId(projectId);
          return true;
        } catch (error) {
          this.recordIssue(projectId, "directory", "invalid_project_id", error);
          return false;
        }
      });
  }

  private tryLoad(projectId: string): StudioKernel | undefined {
    try {
      const loaded = this.loadRecoverableSnapshot(projectId);
      if (loaded?.migrated) {
        this.save(loaded.kernel);
      }
      return loaded?.kernel;
    } catch (error) {
      this.recordIssue(projectId, "directory", "restore_failed", error);
      return undefined;
    }
  }

  private loadRecoverableSnapshot(projectId: string): LoadedSnapshot | undefined {
    const safeProjectId = assertSafeProjectId(projectId);
    const projectDirectory = this.projectDirectory(safeProjectId);
    rejectSymbolicLink(projectDirectory);
    const primaryPath = join(projectDirectory, SNAPSHOT_FILE_NAME);
    const backupPath = join(projectDirectory, BACKUP_FILE_NAME);
    rejectSymbolicLink(primaryPath);
    rejectSymbolicLink(backupPath);

    if (existsSync(primaryPath)) {
      try {
        return readSnapshotFile(primaryPath, safeProjectId);
      } catch (error) {
        this.recordIssue(safeProjectId, "primary", classifySnapshotError(error), error);
      }
    }

    if (!existsSync(backupPath)) {
      return undefined;
    }

    let recovered: LoadedSnapshot;
    try {
      recovered = readSnapshotFile(backupPath, safeProjectId);
    } catch (error) {
      this.recordIssue(safeProjectId, "backup", classifySnapshotError(error), error);
      return undefined;
    }

    this.recordIssue(
      safeProjectId,
      "backup",
      "recovered_from_backup",
      new Error("Primary snapshot was unavailable or invalid; loaded the last verified backup")
    );
    try {
      this.ensureProjectDirectory(safeProjectId);
      atomicWriteFile(primaryPath, recovered.raw);
    } catch (error) {
      this.recordIssue(safeProjectId, "primary", "repair_failed", error);
    }
    return recovered;
  }

  private tryReadSnapshotFile(path: string, projectId: string): LoadedSnapshot | undefined {
    if (!existsSync(path)) {
      return undefined;
    }
    try {
      return readSnapshotFile(path, projectId);
    } catch (error) {
      this.recordIssue(projectId, "primary", classifySnapshotError(error), error);
      return undefined;
    }
  }

  private ensureProjectDirectory(projectId: string): string {
    mkdirPrivate(this.dataRoot);
    const projectDirectory = this.projectDirectory(projectId);
    rejectSymbolicLink(projectDirectory);
    mkdirPrivate(projectDirectory);
    return projectDirectory;
  }

  private projectDirectory(projectId: string): string {
    const projectDirectory = resolve(this.dataRoot, projectId);
    if (dirname(projectDirectory) !== this.dataRoot) {
      throw new Error(`Project ID escapes the persistence root: ${projectId}`);
    }
    return projectDirectory;
  }

  private recordIssue(
    projectId: string,
    source: ProjectPersistenceIssue["source"],
    kind: ProjectPersistenceIssue["kind"],
    error: unknown
  ): void {
    this.issues.push({
      projectId,
      source,
      kind,
      message: error instanceof Error ? error.message : String(error),
      occurredAt: new Date().toISOString()
    });
  }
}

function snapshotSummary(snapshot: StudioKernelSnapshot): ProjectSummary {
  return {
    projectId: snapshot.project.projectId,
    name: snapshot.project.name,
    currentStage: snapshot.project.currentStage,
    status: snapshot.project.status,
    ...(snapshot.project.executionStatus ? { executionStatus: snapshot.project.executionStatus } : {}),
    ...(snapshot.agentLoop?.status ? { agentLoopStatus: snapshot.agentLoop.status } : {}),
    ...(snapshot.agentLoop?.waitingReason ? { agentLoopWaitingReason: snapshot.agentLoop.waitingReason } : {}),
    ...(snapshot.project.initialIdea ? { initialIdea: snapshot.project.initialIdea } : {}),
    createdAt: snapshot.project.createdAt,
    updatedAt: snapshot.project.updatedAt,
    savedAt: snapshot.savedAt
  };
}

function serializeValidatedSnapshot(snapshot: StudioKernelSnapshot, projectId: string): string {
  validateSnapshot(snapshot, projectId);
  try {
    createStudioKernelFromSnapshot(snapshot);
  } catch (error) {
    throw new SnapshotRestoreError(error);
  }
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function readSnapshotFile(path: string, projectId: string): LoadedSnapshot {
  let snapshot: unknown;
  const raw = readFileSync(path, "utf8");
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    throw new InvalidSnapshotError(`Snapshot is not valid JSON: ${errorMessage(error)}`);
  }

  validateSnapshot(snapshot, projectId);
  try {
    const migration = migrateLocalRuntimeSnapshot(snapshot, {
      legacyArtifactIdFor: stableLegacyArtifactId
    });
    return {
      snapshot: migration.snapshot,
      kernel: createStudioKernelFromSnapshot(migration.snapshot),
      raw,
      migrated: migration.changed
    };
  } catch (error) {
    throw new SnapshotRestoreError(error);
  }
}

function stableLegacyArtifactId(projectId: string, ownerAgentId: string, path: string): string {
  return `artifact_${createHash("sha1").update(`${projectId}:${ownerAgentId}:${path}`).digest("hex").slice(0, 12)}`;
}

function validateSnapshot(value: unknown, expectedProjectId: string): asserts value is StudioKernelSnapshot {
  const snapshot = requireRecord(value, "snapshot");
  if (snapshot.version !== 1) {
    throw new InvalidSnapshotError("Snapshot version must be 1");
  }
  requireString(snapshot.savedAt, "snapshot.savedAt");

  const project = requireRecord(snapshot.project, "snapshot.project");
  const projectId = requireString(project.projectId, "snapshot.project.projectId");
  if (projectId !== expectedProjectId) {
    throw new InvalidSnapshotError(`Snapshot project ID ${projectId} does not match directory ${expectedProjectId}`);
  }
  for (const field of ["name", "status", "currentStage", "producerId", "createdAt", "updatedAt"] as const) {
    requireString(project[field], `snapshot.project.${field}`);
  }

  const agentLoop = requireRecord(snapshot.agentLoop, "snapshot.agentLoop");
  if (requireString(agentLoop.projectId, "snapshot.agentLoop.projectId") !== expectedProjectId) {
    throw new InvalidSnapshotError("Snapshot agent loop belongs to a different project");
  }
  requireString(agentLoop.status, "snapshot.agentLoop.status");
  requireString(agentLoop.updatedAt, "snapshot.agentLoop.updatedAt");
  if (typeof agentLoop.iteration !== "number" || !Number.isSafeInteger(agentLoop.iteration) || agentLoop.iteration < 0) {
    throw new InvalidSnapshotError("snapshot.agentLoop.iteration must be a non-negative integer");
  }
  requireArray(agentLoop.activeAgentIds, "snapshot.agentLoop.activeAgentIds");
  requireArray(agentLoop.pendingTaskIds, "snapshot.agentLoop.pendingTaskIds");
  requireRecord(agentLoop.agents, "snapshot.agentLoop.agents");

  for (const field of [
    "rooms",
    "messages",
    "tasks",
    "artifacts",
    "artifactOperations",
    "artifactLedger",
    "claimVerifications",
    "claimRepairs",
    "memoryRecords",
    "auditEvents"
  ] as const) {
    requireArray(snapshot[field], `snapshot.${field}`);
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidSnapshotError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidSnapshotError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidSnapshotError(`${path} must be an array`);
  }
  return value;
}

function assertSafeProjectId(projectId: string): string {
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId.includes("..")) {
    throw new Error(`Invalid project ID for persistence path: ${projectId}`);
  }
  return projectId;
}

function rejectSymbolicLink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in the persistence path: ${path}`);
  }
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
  }
}

function atomicWriteFile(targetPath: string, content: string): void {
  const temporaryPath = join(dirname(targetPath), `.${SNAPSHOT_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", PRIVATE_FILE_MODE);
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, targetPath);
    fsyncDirectory(dirname(targetPath));
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") {
    return;
  }
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function classifySnapshotError(error: unknown): "invalid_snapshot" | "restore_failed" {
  return error instanceof SnapshotRestoreError ? "restore_failed" : "invalid_snapshot";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InvalidSnapshotError extends Error {}

class SnapshotRestoreError extends Error {
  constructor(error: unknown) {
    super(`Could not restore StudioKernel: ${errorMessage(error)}`);
  }
}

function defaultDataRoot(): string {
  return process.env.GAME_PIPELINE_DATA_ROOT ?? join(process.env.INIT_CWD ?? process.cwd(), ".local", "projects");
}
