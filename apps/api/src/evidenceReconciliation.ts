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
import { artifactReadyForConsumption, artifactInputProvenanceIsCurrent } from "./taskOutputEvidence.js";
import { currentImplementationReport, implementationReportNeedsRefresh, implementationReviewPath } from "./implementationReview.js";
import { applyQualityReviewChangeRequest, qualityReviewReadyForGate } from "./qualityReviewArtifacts.js";

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
  const restoredReferenceIds = restoreHistoricalReviewReferences(kernel, now);

  for (const contract of getQualityReviewArtifactContracts()) {
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === contract.artifactId);
    if (!artifact) continue;
    const task = kernel.findTask(contract.sourceTaskId);
    if (!artifact.metadata.toolExecutedAt) {
      // Old checkpoints made the reason for re-review a scheduler blocker.
      // Once the author has resubmitted valid inputs, remove only that owned
      // blocker; keep real/manual dependency failures and the invalid receipt.
      if (artifact.metadata.qualityReviewEvidenceInvalidationReason && task &&
          executableStages.has(task.stageId) && task.status !== "cancelled" &&
          task.blockers.some((blocker) => blocker.startsWith("质量审查证据失效：")) &&
          task.inputArtifacts.every((id) => artifactReadyForConsumption(kernel, id))) {
        reopenTaskForEvidenceRepair(kernel, task, now);
        reopenedTaskIds.push(task.taskId);
      }
      continue;
    }
    const result = qualityReviewReadyForGate(kernel, contract.artifactId, false);
    if (result.ok) {
      if (result.review) applyQualityReviewChangeRequest(kernel, artifact, result.review, now);
      continue;
    }

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
    changed: reopenedTaskIds.length > 0 || restoredReferenceIds.length > 0,
    taskIds: [...new Set(reopenedTaskIds)],
    artifactIds: [...new Set(invalidatedArtifactIds)]
  };
}

/** Repair only the old cross-stage feedback projection, never files or reviews. */
export function restoreHistoricalReviewReferences(kernel: StudioKernel, now = new Date().toISOString()): string[] {
  const active = new Set(workflowTaskStages(kernel.project.currentStage));
  const workflow = kernel.getWorkflowSnapshot();
  const restored: string[] = [];
  for (const artifact of kernel.listArtifacts()) {
    const source = artifact.sourceTaskId ? kernel.findTask(artifact.sourceTaskId) : undefined;
    const reviewId = artifact.metadata.qualityChangeReviewArtifactId;
    const contract = typeof reviewId === "string"
      ? getQualityReviewArtifactContracts().find((entry) => entry.artifactId === reviewId) : undefined;
    const reviewerTask = contract ? kernel.findTask(contract.sourceTaskId) : undefined;
    if (artifact.status !== "change_requested" || !source || source.status !== "done" || active.has(source.stageId) ||
        !reviewerTask || !active.has(reviewerTask.stageId) || !contract?.subjectArtifactIds.includes(artifact.artifactId) ||
        !artifact.metadata.qualityChangeReviewInvocationId || artifact.metadata.producerChangeRequestId) continue;
    const gate = workflow.gates.find((entry) => entry.status === "approved" && entry.requiredArtifacts.includes(artifact.artifactId) &&
      workflow.decisions.some((decision) => decision.decisionId === entry.decisionId && decision.status === "active"));
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId);
    if (!gate || ledger?.status !== "verified" || !ledger.hash || !gate.resolvedAt || artifact.updatedAt > gate.resolvedAt) continue;
    // Project the candidate without minting fresh byte/provenance evidence.
    artifact.status = "approved";
    if (!artifactReadyForConsumption(kernel, artifact.artifactId)) { artifact.status = "change_requested"; continue; }
    artifact.metadata = Object.fromEntries(Object.entries(artifact.metadata).filter(([key]) => !key.startsWith("qualityChange")));
    artifact.metadata.historicalReviewReferenceRestoredAt = now;
    restored.push(artifact.artifactId);
  }
  return restored;
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
        const artifact = kernel.listArtifacts().find((entry) => entry.artifactId === artifactId);
        // Preserve an authentic old verifier receipt as history. Consumption
        // still fails until a fresh run; destroying its ledger loses the very
        // evidence needed to schedule re-verification after upstream repairs.
        if (artifact && implementationReportNeedsRefresh(kernel, artifact)) continue;
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
    const artifact = kernel.listArtifacts().find((entry) => entry.artifactId === artifactId);
    if (artifact?.path === implementationReviewPath) {
      // A valid rejection completes the review, not the reviewed game. The
      // build gate still uses artifactReadyForConsumption and demands pass.
      return artifactInputProvenanceIsCurrent(kernel, artifactId) && !!currentImplementationReport(kernel, artifact);
    }
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
    // Invalid output is the work this task must repair, not a dependency that
    // prevents it from running. Upstream readiness is enforced by the scheduler.
    blockers: task.blockers.filter((candidate) =>
      !candidate.startsWith("Agent Loop：") && !candidate.startsWith("质量审查证据失效：")
    ),
    updatedAt: now
  });
  if (kernel.project.executionStatus !== "running") {
    return;
  }
  kernel.updateAgentLoopAgent(task.ownerAgentId, {
    status: "queued",
    taskId: task.taskId,
    lastError: blocker,
    updatedAt: now
  });
}
