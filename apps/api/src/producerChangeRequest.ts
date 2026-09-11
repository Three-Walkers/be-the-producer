import { workflowTaskStages, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { StudioMessage, Task } from "@game-pipeline/shared-schemas";

/** Explicit producer changes reopen the addressed current-stage work and its
 * dependants. Ordinary discussion is not a rollback command; historical stages
 * and unrelated roles are never reopened by a room keyword match. */
export function producerChangeTargets(kernel: StudioKernel, message: StudioMessage): Task[] {
  if (message.senderType !== "producer" || message.messageType !== "change_request") return [];
  const stages = new Set(workflowTaskStages(kernel.project.currentStage));
  // An explicit task selector narrows a role mention. A typo must select no
  // work, never silently widen a QA retry into contract/implementation edits.
  const selected = new Set([
    ...message.relatedTaskIds,
    ...[...message.content.matchAll(/\[task:([A-Za-z0-9_-]+)\]/g)].map((match) => match[1])
  ]);
  return kernel.listTasks().filter((task) => stages.has(task.stageId) &&
    task.taskLevel !== "task_group" && task.status !== "cancelled" && task.outputArtifacts.length > 0 &&
    (selected.size > 0 ? selected.has(task.taskId) : message.mentions.includes(task.ownerAgentId)));
}

export function applyProducerChangeRequest(kernel: StudioKernel, message: StudioMessage): string[] {
  const targets = producerChangeTargets(kernel, message);
  if (targets.length === 0) return [];
  const stages = new Set(workflowTaskStages(kernel.project.currentStage));
  const affected = new Map(targets.map((task) => [task.taskId, task]));
  const staleIds = new Set(targets.flatMap((task) => task.outputArtifacts));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of kernel.listTasks()) {
      if (affected.has(task.taskId) || !stages.has(task.stageId) || task.taskLevel === "task_group" || task.status === "cancelled") continue;
      if (!task.inputArtifacts.some((id) => staleIds.has(id))) continue;
      affected.set(task.taskId, task);
      task.outputArtifacts.forEach((id) => staleIds.add(id));
      expanded = true;
    }
  }
  const now = message.createdAt;
  for (const task of affected.values()) {
    kernel.updateTask(task.taskId, {
      status: "doing", progressPercent: Math.min(task.progressPercent ?? 0, 80),
      blockers: task.blockers.filter((reason) => !/^(Agent Loop|质量审查证据失效：|等待制作人)/.test(reason)),
      updatedAt: now
    });
  }
  for (const artifactId of staleIds) {
    const artifact = kernel.listArtifacts().find((item) => item.artifactId === artifactId);
    if (!artifact) continue;
    kernel.upsertArtifact({ ...artifact, status: "change_requested", updatedAt: now,
      metadata: { ...artifact.metadata, producerChangeMessageId: message.messageId,
        producerChangeRequestedAt: now, qualityChangeReviewId: undefined,
        qualityChangeReviewInvocationId: undefined, qualityChangeReviewArtifactId: undefined }
    });
  }
  // Keep the request itself as the durable requirement and audit link. No file
  // is rewritten and no previous ledger evidence is fabricated or deleted.
  message.relatedTaskIds = [...affected.keys()];
  message.relatedArtifactIds = [...staleIds];
  message.metadata = { ...message.metadata, producerChangeApplied: true };
  return [...affected.keys()];
}
