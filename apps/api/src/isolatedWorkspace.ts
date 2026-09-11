import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspaceSnapshot } from "./harnessWorkspaceEvidence.js";
import { resolvePathWithinRoot } from "./pathSafety.js";

const excludedDirectoryNames = new Set([".git", ".be-the-producer", "node_modules", "library", "temp", "local"]);

export interface IsolatedWorkspace {
  root: string;
  dispose(): void;
}

export interface WorkspaceCommitTransaction {
  finalize(): void;
  rollback(): void;
}

export function createIsolatedWorkspace(projectRoot: string, label: string): IsolatedWorkspace {
  // Snapshot validation rejects symlinks before any content is copied into the worker boundary.
  captureWorkspaceSnapshot(projectRoot);
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 48) || "agent";
  const transactionRoot = mkdtempSync(join(tmpdir(), `btp-${safeLabel}-`));
  const workspaceRoot = join(transactionRoot, "workspace");
  cpSync(projectRoot, workspaceRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    filter: (source) => shouldCopyWorkspacePath(projectRoot, source)
  });
  return {
    root: workspaceRoot,
    dispose: () => rmSync(transactionRoot, { recursive: true, force: true })
  };
}

export function stageWorkspaceCommit(
  canonicalRoot: string,
  stagingRoot: string,
  changedPaths: string[],
  deletedPaths: string[] = []
): WorkspaceCommitTransaction {
  const transactionRoot = mkdtempSync(join(tmpdir(), "btp-workspace-commit-"));
  const backupRoot = join(transactionRoot, "backup");
  const applied: Array<{ path: string; target: string; backup?: string }> = [];
  let closed = false;
  try {
    for (const path of [...new Set(deletedPaths)].sort()) {
      if (changedPaths.includes(path)) throw new Error(`提交路径不能同时写入和删除：${path}`);
      const staged = resolvePathWithinRoot(stagingRoot, path, { allowMissing: true, label: "Agent 旧构建文件" });
      if (existsSync(staged.absolutePath)) throw new Error(`删除路径仍存在于新工作区：${path}`);
      const target = resolvePathWithinRoot(canonicalRoot, path, { allowMissing: false, expectedKind: "file", label: "Agent 旧构建输出" }).absolutePath;
      const backup = join(backupRoot, path.split("/").join(sep));
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      copyFileSync(target, backup);
      applied.push({ path, target, backup });
      unlinkSync(target);
    }
    for (const path of [...new Set(changedPaths)].sort()) {
      const source = resolvePathWithinRoot(stagingRoot, path, {
        allowMissing: false,
        expectedKind: "file",
        label: "Agent staging 文件"
      }).absolutePath;
      const target = resolvePathWithinRoot(canonicalRoot, path, {
        allowMissing: true,
        label: "Agent 正式工作区文件"
      }).absolutePath;
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      let backup: string | undefined;
      if (existsSync(target)) {
        if (!lstatSync(target).isFile()) {
          throw new Error(`Agent 提交目标不是普通文件：${path}`);
        }
        backup = join(backupRoot, path.split("/").join(sep));
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        copyFileSync(target, backup);
      }
      const temporaryTarget = join(dirname(target), `.${basename(target)}.btp-${randomUUID()}.tmp`);
      copyFileSync(source, temporaryTarget);
      renameSync(temporaryTarget, target);
      applied.push({ path, target, ...(backup ? { backup } : {}) });
    }
  } catch (error) {
    rollbackApplied(applied);
    rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    finalize: () => {
      if (closed) return;
      closed = true;
      rmSync(transactionRoot, { recursive: true, force: true });
    },
    rollback: () => {
      if (closed) return;
      closed = true;
      rollbackApplied(applied);
      rmSync(transactionRoot, { recursive: true, force: true });
    }
  };
}

function shouldCopyWorkspacePath(projectRoot: string, source: string): boolean {
  const path = relative(projectRoot, source).split(sep).join("/");
  if (!path) return true;
  return !path.split("/").some((segment) => excludedDirectoryNames.has(segment));
}

function rollbackApplied(applied: Array<{ target: string; backup?: string }>): void {
  for (const entry of [...applied].reverse()) {
    if (entry.backup && existsSync(entry.backup)) {
      const temporaryTarget = join(dirname(entry.target), `.${basename(entry.target)}.rollback-${randomUUID()}.tmp`);
      copyFileSync(entry.backup, temporaryTarget);
      renameSync(temporaryTarget, entry.target);
    } else if (existsSync(entry.target)) {
      unlinkSync(entry.target);
    }
  }
}
