import {
  getQualityReviewArtifactContracts,
  workflowTaskStages,
  type StudioKernel
} from "@game-pipeline/agent-runtime";
import type {
  ArtifactDirectoryManifest,
  ArtifactEvidenceStatus,
  ArtifactInputProvenance,
  Task
} from "@game-pipeline/shared-schemas";
import { artifactReadyForConsumption } from "./taskOutputEvidence.js";
import { qualityReviewReadyForGate } from "./qualityReviewArtifacts.js";

interface FrozenArtifactEvidence {
  artifactId: string;
  artifactVersion?: number;
  ledger?: {
    status: ArtifactEvidenceStatus;
    path: string;
    hash: string | undefined;
    sizeBytes: number | undefined;
    sourceOperationId: string;
    inputArtifacts: ArtifactInputProvenance[] | undefined;
    directoryManifest: ArtifactDirectoryManifest | undefined;
  };
}

export interface ReviewOutputEvidenceBaseline {
  taskIds: string[];
  artifacts: Map<string, FrozenArtifactEvidence>;
}

export interface ReviewOutputEvidenceReconciliationResult {
  changed: boolean;
  taskIds: string[];
  artifactIds: string[];
}

/**
 * Repairs historical review receipts that predate write-time locator checks.
 * The receipt is never rewritten or silently clamped: its evidence is
 * invalidated and the independent reviewer is queued to produce a fresh,
 * grounded receipt.
 */
export function reconcileInvalidQualityReviewEvidence(
  kernel: StudioKernel,
  now = new Date().toISOString()
): ReviewOutputEvidenceReconciliationResult {
  const executableStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const reopenedTaskIds: string[] = [];
  const invalidatedArtifactIds: string[] = [];

  for (const contract of getQualityReviewArtifactContracts()) {
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === contract.artifactId);
    if (!artifact?.metadata.toolExecutedAt) continue;
    const result = qualityReviewReadyForGate(kernel, contract.artifactId, false);
    if (result.ok) continue;

    const task = kernel.findTask(contract.sourceTaskId);
    if (!task || !executableStages.has(task.stageId)) continue;
    const reason = result.reason ?? "quality_review_evidence_not_grounded";
    if (
      artifact.metadata.qualityReviewEvidenceInvalidationReason !== reason ||
      artifact.metadata.toolExecutedAt !== undefined
    ) {
      invalidateArtifactEvidence(kernel, contract.artifactId, now, reason);
      invalidatedArtifactIds.push(contract.artifactId);
    }
    reopenTaskForEvidenceRepair(kernel, task, now, `质量审查证据失效：${reason}`);
    reopenedTaskIds.push(task.taskId);
  }

  return {
    changed: reopenedTaskIds.length > 0,
    taskIds: [...new Set(reopenedTaskIds)],
    artifactIds: [...new Set(invalidatedArtifactIds)]
  };
}

/**
 * Freezes the evidence receipts for review-complete work before workspace sync.
 * Sync is allowed to materialize pending work, but it must not silently bless a
 * different file for a task that was already waiting for review or marked done.
 */
export function captureCurrentStageReviewOutputEvidence(kernel: StudioKernel): ReviewOutputEvidenceBaseline {
  const executableStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const tasks = kernel
    .listTasks()
    .filter(
      (task) =>
        executableStages.has(task.stageId) &&
        task.taskLevel !== "task_group" &&
        ["review", "done"].includes(task.status)
    );
  const artifacts = new Map<string, FrozenArtifactEvidence>();
  for (const artifactId of new Set(tasks.flatMap((task) => task.outputArtifacts))) {
    artifacts.set(artifactId, freezeArtifactEvidence(kernel, artifactId));
  }
  return { taskIds: tasks.map((task) => task.taskId), artifacts };
}

/**
 * Revalidates review/done outputs after workspace sync. A receipt change during
 * sync is treated as stale even if sync just re-recorded the new bytes as
 * verified: review-complete output may only change through a fresh task run.
 */
export function reconcileCurrentStageReviewOutputEvidence(
  kernel: StudioKernel,
  baseline: ReviewOutputEvidenceBaseline,
  now = new Date().toISOString()
): ReviewOutputEvidenceReconciliationResult {
  const executableStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const reopenedTaskIds: string[] = [];
  const invalidatedArtifactIds = new Set<string>();

  for (const taskId of baseline.taskIds) {
    const task = kernel.findTask(taskId);
    if (
      !task ||
      !executableStages.has(task.stageId) ||
      task.taskLevel === "task_group" ||
      !["review", "done"].includes(task.status)
    ) {
      continue;
    }
    const staleArtifactIds = task.outputArtifacts.filter((artifactId) => {
      const frozen = baseline.artifacts.get(artifactId);
      return (
        !artifactIsReadyForConsumption(kernel, artifactId) ||
        (frozen !== undefined && !artifactEvidenceMatches(kernel, frozen))
      );
    });
    if (staleArtifactIds.length === 0) {
      continue;
    }

    for (const artifactId of staleArtifactIds) {
      if (!invalidatedArtifactIds.has(artifactId)) {
        invalidateArtifactEvidence(kernel, artifactId, now);
        invalidatedArtifactIds.add(artifactId);
      }
    }
    reopenTaskForEvidenceRepair(kernel, task, now);
    reopenedTaskIds.push(task.taskId);
  }

  return {
    changed: reopenedTaskIds.length > 0,
    taskIds: reopenedTaskIds,
    artifactIds: [...invalidatedArtifactIds]
  };
}

function artifactIsReadyForConsumption(kernel: StudioKernel, artifactId: string): boolean {
  try {
    return artifactReadyForConsumption(kernel, artifactId);
  } catch {
    // Unsafe paths and filesystem races are stale evidence, not reasons to make
    // the entire checkpoint fail before the task can be reopened for repair.
    return false;
  }
}

function freezeArtifactEvidence(kernel: StudioKernel, artifactId: string): FrozenArtifactEvidence {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  return {
    artifactId,
    ...(artifact ? { artifactVersion: artifact.version } : {}),
    ...(ledger
      ? {
          ledger: {
            status: ledger.status,
            path: ledger.path,
            hash: ledger.hash,
            sizeBytes: ledger.sizeBytes,
            sourceOperationId: ledger.sourceOperationId,
            inputArtifacts: cloneInputArtifacts(ledger.inputArtifacts),
            directoryManifest: ledger.directoryManifest
              ? {
                  ...ledger.directoryManifest,
                  files: ledger.directoryManifest.files.map((entry) => ({ ...entry }))
                }
              : undefined
          }
        }
      : {})
  };
}

function artifactEvidenceMatches(kernel: StudioKernel, frozen: FrozenArtifactEvidence): boolean {
  const current = freezeArtifactEvidence(kernel, frozen.artifactId);
  return (
    frozen.artifactVersion === current.artifactVersion &&
    JSON.stringify(frozen.ledger) === JSON.stringify(current.ledger)
  );
}

function cloneInputArtifacts(inputs: ArtifactInputProvenance[] | undefined): ArtifactInputProvenance[] | undefined {
  return inputs?.map((input) => ({ ...input }));
}

function invalidateArtifactEvidence(
  kernel: StudioKernel,
  artifactId: string,
  now: string,
  qualityReviewReason?: string
): void {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) {
    return;
  }
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  const ledgerNeedsInvalidation =
    ledger?.status !== "pending" ||
    ledger.hash !== undefined ||
    ledger.sizeBytes !== undefined ||
    ledger.materializedAt !== undefined;
  kernel.upsertArtifact({
    ...artifact,
    status: "change_requested",
    version: artifact.version + (ledgerNeedsInvalidation ? 1 : 0),
    metadata: {
      ...artifact.metadata,
      // A later workspace sync may re-hash an existing native file. Keeping the
      // tool timestamp cleared ensures it remains non-consumable until Harness
      // performs a fresh authorized write.
      toolExecutedAt: undefined,
      filesystemEvidenceInvalidatedAt: now,
      filesystemEvidenceInvalidationReason: qualityReviewReason
        ? "quality_review_evidence_not_grounded"
        : "review_output_not_current_after_workspace_sync",
      ...(qualityReviewReason ? { qualityReviewEvidenceInvalidationReason: qualityReviewReason } : {})
    },
    updatedAt: now
  });
}

function reopenTaskForEvidenceRepair(
  kernel: StudioKernel,
  task: Task,
  now: string,
  blocker?: string
): void {
  kernel.updateTask(task.taskId, {
    status: "doing",
    progressPercent: Math.min(task.progressPercent ?? 80, 85),
    blockers: [
      ...task.blockers.filter((candidate) =>
        !candidate.startsWith("Agent Loop：") && !candidate.startsWith("质量审查证据失效：")
      ),
      ...(blocker ? [blocker] : [])
    ],
    updatedAt: now
  });
  if (kernel.project.executionStatus !== "running") {
    return;
  }
  kernel.updateAgentLoopAgent(task.ownerAgentId, {
    status: "queued",
    taskId: task.taskId,
    lastError: undefined,
    updatedAt: now
  });
}
