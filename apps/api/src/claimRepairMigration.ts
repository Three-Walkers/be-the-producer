import { createStudioKernelFromSnapshot, type StudioKernel } from "@game-pipeline/agent-runtime";

const repairGroupId = "task_group_claim_repair";
const currentProtocolVersion = 2;

export interface ClaimRepairMigrationResult {
  kernel: StudioKernel;
  changed: boolean;
  removedMessages: number;
  removedTasks: number;
  removedClaims: number;
  removedRepairs: number;
}

export function migrateLegacyClaimRepairStorm(kernel: StudioKernel): ClaimRepairMigrationResult {
  const snapshot = kernel.toSnapshot();
  const hasLegacyGuardianMessages = snapshot.messages.some(
    (message) =>
      message.metadata?.generatedBy === "claim_repair_guardian" &&
      message.metadata?.claimRepairProtocolVersion !== currentProtocolVersion
  );
  const messagesById = new Map(snapshot.messages.map((message) => [message.messageId, message]));
  const hasObsoleteWorkflowRepair = snapshot.claimRepairs.some((repair) => {
    const source = messagesById.get(repair.messageId);
    return source?.senderId === "studio_orchestrator" && source.metadata?.generatedBy === "local_agent_runtime";
  });
  if (!hasLegacyGuardianMessages && !hasObsoleteWorkflowRepair) {
    return unchanged(kernel);
  }

  const messages = snapshot.messages
    .filter((message) => message.metadata?.generatedBy !== "claim_repair_guardian")
    .map((message) => ({
      ...message,
      metadata: withoutDerivedClaimMetadata(message.metadata)
    }));
  const tasks = snapshot.tasks.filter(
    (task) => task.taskId !== repairGroupId && task.parentTaskId !== repairGroupId
  );
  const memoryRecords = snapshot.memoryRecords.filter(
    (record) => record.type !== "claim_repair_open" && record.type !== "claim_repair_resolved"
  );
  const auditEvents = snapshot.auditEvents.filter(
    (event) => !event.eventType.startsWith("CLAIM_") && !event.eventId.startsWith("evt_msg_repair_")
  );

  return {
    kernel: createStudioKernelFromSnapshot({
      ...snapshot,
      messages,
      tasks,
      claimVerifications: [],
      claimRepairs: [],
      memoryRecords,
      auditEvents
    }),
    changed: true,
    removedMessages: snapshot.messages.length - messages.length,
    removedTasks: snapshot.tasks.length - tasks.length,
    removedClaims: snapshot.claimVerifications.length,
    removedRepairs: snapshot.claimRepairs.length
  };
}

function withoutDerivedClaimMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...metadata };
  delete clean.claimVerificationIds;
  delete clean.claimVerifications;
  delete clean.claimVerdict;
  return clean;
}

function unchanged(kernel: StudioKernel): ClaimRepairMigrationResult {
  return {
    kernel,
    changed: false,
    removedMessages: 0,
    removedTasks: 0,
    removedClaims: 0,
    removedRepairs: 0
  };
}
