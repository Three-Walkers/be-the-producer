import { createHash } from "node:crypto";
import type {
  AgentId,
  ClaimRepair,
  ClaimRepairAction,
  ClaimRepairResolution,
  ClaimVerification,
  MemoryRecord,
  MessageType,
  RoomId,
  StudioMessage,
  Task
} from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";

const repairGroupId = "task_group_claim_repair";

export function reconcileClaimRepairs(kernel: StudioKernel): ClaimRepair[] {
  const changedRepairs: ClaimRepair[] = [];
  const claims = kernel.listClaimVerifications();

  for (const claim of claims) {
    if (claim.verdict === "verified") {
      continue;
    }

    const repair = openOrUpdateRepair(kernel, claim);
    if (repair) {
      changedRepairs.push(repair);
    }
  }

  for (const repair of kernel.listClaimRepairs().filter((candidate) => candidate.status === "open")) {
    const resolved = resolveRepairIfEvidenceAppeared(kernel, repair);
    if (resolved) {
      changedRepairs.push(resolved);
    }
  }

  refreshRepairGroupStatus(kernel);
  return changedRepairs;
}

function openOrUpdateRepair(kernel: StudioKernel, claim: ClaimVerification): ClaimRepair | undefined {
  const now = new Date().toISOString();
  const sourceMessage = kernel.listMessages().find((message) => message.messageId === claim.messageId);
  if (!sourceMessage) {
    return undefined;
  }

  const repairId = repairIdForClaim(claim.claimId);
  const taskId = taskIdForRepair(repairId);
  const nearestArtifactPath = stringMetadata(claim.metadata, "nearestArtifactPath");
  const action: ClaimRepairAction = nearestArtifactPath ? "correct_claim" : "supply_evidence";
  const existingRepair = kernel.listClaimRepairs().find((candidate) => candidate.repairId === repairId);
  if (existingRepair?.status === "resolved") {
    annotateClaimWithRepair(kernel, claim, existingRepair);
    return undefined;
  }

  const repair: ClaimRepair = {
    repairId,
    projectId: claim.projectId,
    claimId: claim.claimId,
    messageId: claim.messageId,
    agentId: claim.agentId,
    taskId,
    status: "open",
    action,
    ...(claim.claimedPath ? { claimedPath: claim.claimedPath } : {}),
    ...(nearestArtifactPath ? { nearestArtifactPath } : {}),
    reason: claim.reason,
    createdAt: existingRepair?.createdAt ?? now,
    updatedAt: now
  };
  const result = kernel.upsertClaimRepair(repair);
  ensureRepairGroup(kernel);
  ensureRepairTask(kernel, sourceMessage, result.repair, claim);
  annotateClaimWithRepair(kernel, claim, result.repair);
  writeRepairMemory(kernel, result.repair, claim);

  if (result.created) {
    writeRepairOpenedMessage(kernel, sourceMessage, result.repair, claim);
  }

  return result.changed ? result.repair : undefined;
}

function resolveRepairIfEvidenceAppeared(kernel: StudioKernel, repair: ClaimRepair): ClaimRepair | undefined {
  const sourceClaim = kernel.listClaimVerifications().find((claim) => claim.claimId === repair.claimId);
  if (!sourceClaim) {
    return undefined;
  }

  const directVerified = kernel
    .listClaimVerifications()
    .find((claim) => claim.claimId === repair.claimId && claim.verdict === "verified");
  const correctiveVerified = findCorrectiveVerifiedClaim(kernel, repair);
  const resolutionClaim = directVerified ?? correctiveVerified;
  if (!resolutionClaim) {
    return undefined;
  }

  const now = new Date().toISOString();
  const resolution: ClaimRepairResolution = directVerified ? "evidence_verified" : "claim_corrected";
  const resolvedRepair: ClaimRepair = {
    ...repair,
    status: "resolved",
    resolution,
    resolutionClaimId: resolutionClaim.claimId,
    resolvedAt: now,
    updatedAt: now
  };
  const result = kernel.upsertClaimRepair(resolvedRepair);
  if (kernel.findTask(repair.taskId)?.status !== "done") {
    kernel.updateTask(repair.taskId, {
      status: "done",
      blockers: [],
      progressPercent: 100,
      updatedAt: now
    });
  }
  annotateClaimWithRepair(kernel, sourceClaim, result.repair);
  writeRepairResolvedMessage(kernel, result.repair, resolutionClaim);
  writeRepairMemory(kernel, result.repair, sourceClaim);
  return result.changed ? result.repair : undefined;
}

function findCorrectiveVerifiedClaim(kernel: StudioKernel, repair: ClaimRepair): ClaimVerification | undefined {
  if (!repair.nearestArtifactPath) {
    return undefined;
  }

  const sourceMessage = kernel.listMessages().find((message) => message.messageId === repair.messageId);
  const sourceTime = sourceMessage ? new Date(sourceMessage.createdAt).getTime() : 0;
  return kernel
    .listClaimVerifications()
    .filter(
      (claim) =>
        claim.claimId !== repair.claimId &&
        claim.agentId === repair.agentId &&
        claim.verdict === "verified" &&
        claim.claimedPath === repair.nearestArtifactPath &&
        new Date(kernel.listMessages().find((message) => message.messageId === claim.messageId)?.createdAt ?? claim.checkedAt).getTime() >= sourceTime
    )
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0];
}

function ensureRepairGroup(kernel: StudioKernel): void {
  if (kernel.findTask(repairGroupId)) {
    return;
  }

  const now = new Date().toISOString();
  kernel.addTask({
    taskId: repairGroupId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    taskLevel: "task_group",
    ownerAgentId: "studio_orchestrator",
    title: "证据修复与声明纠错",
    description: "平台自动收集未验证声明，要求对应 Agent 补充工具证据或更正声明。",
    status: "todo",
    priority: 100,
    sortOrder: 900,
    progressPercent: 0,
    childrenSummary: {
      doing: 0,
      blocked: 0,
      todo: 0,
      done: 0,
      cancelled: 0
    },
    inputArtifacts: [],
    outputArtifacts: [],
    acceptanceCriteria: ["所有声明不成立或缺少证据的问题都有明确责任 Agent", "修复项只能由 verified 证据关闭"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
}

function ensureRepairTask(kernel: StudioKernel, sourceMessage: StudioMessage, repair: ClaimRepair, claim: ClaimVerification): void {
  const existing = kernel.findTask(repair.taskId);
  const now = new Date().toISOString();
  const taskFields: Omit<Task, "taskId" | "projectId" | "createdAt"> = {
    stageId: kernel.project.currentStage,
    parentTaskId: repairGroupId,
    roomId: sourceMessage.roomId,
    taskLevel: "task",
    ownerAgentId: repair.agentId,
    title: repairTitle(repair),
    description: repairDescription(repair, claim),
    status: "blocked",
    priority: 100,
    sortOrder: 910 + hashNumber(repair.repairId, 80),
    progressPercent: 0,
    childrenSummary: {
      doing: 0,
      blocked: 0,
      todo: 0,
      done: 0,
      cancelled: 0
    },
    inputArtifacts: claim.relatedArtifactIds,
    outputArtifacts: [],
    acceptanceCriteria: repairAcceptanceCriteria(repair),
    blockers: [claim.reason],
    updatedAt: now
  };

  if (!existing) {
    kernel.addTask({
      taskId: repair.taskId,
      projectId: kernel.project.projectId,
      createdAt: now,
      ...taskFields
    });
    return;
  }

  if (existing.status !== "done") {
    kernel.updateTask(repair.taskId, taskFields);
  }
}

function refreshRepairGroupStatus(kernel: StudioKernel): void {
  const repairs = kernel.listClaimRepairs();
  const group = kernel.findTask(repairGroupId);
  if (!group) {
    return;
  }

  const open = repairs.filter((repair) => repair.status === "open");
  const status: Task["status"] = open.length > 0 ? "blocked" : repairs.length > 0 ? "done" : "todo";
  const progressPercent = repairs.length > 0 ? Math.round(((repairs.length - open.length) / repairs.length) * 100) : 0;
  kernel.updateTask(repairGroupId, {
    status,
    progressPercent,
    blockers: open.map((repair) => `${repair.agentId}: ${repair.claimedPath ?? repair.claimId}`),
    updatedAt: new Date().toISOString()
  });
}

function annotateClaimWithRepair(kernel: StudioKernel, claim: ClaimVerification, repair: ClaimRepair): void {
  const nextClaim: ClaimVerification = {
    ...claim,
    metadata: {
      ...claim.metadata,
      repairId: repair.repairId,
      repairTaskId: repair.taskId,
      repairStatus: repair.status,
      repairAction: repair.action,
      repairResolution: repair.resolution,
      repairResolutionClaimId: repair.resolutionClaimId,
      repairNextStep: repairNextStep(repair)
    }
  };
  kernel.recordClaimVerification(nextClaim);
  const messageClaims = kernel.listClaimVerifications().filter((candidate) => candidate.messageId === claim.messageId);
  kernel.setMessageClaimVerifications(claim.messageId, messageClaims);
}

function writeRepairOpenedMessage(kernel: StudioKernel, sourceMessage: StudioMessage, repair: ClaimRepair, claim: ClaimVerification): void {
  writeRepairMessageOnce(kernel, {
    repair,
    sourceMessage,
    messageType: "blocker",
    marker: "opened",
    content: [
      `证据守卫已创建补证任务：${repair.taskId}。`,
      `责任角色：${repair.agentId}。`,
      `声明问题：${claim.reason}`,
      `处理方式：${repairNextStep(repair)}`,
      "在该修复任务关闭前，相关任务不能进入 review/done，阶段门禁不会采信这条声明。"
    ].join("\n")
  });
}

function writeRepairResolvedMessage(kernel: StudioKernel, repair: ClaimRepair, resolutionClaim: ClaimVerification): void {
  const sourceMessage = kernel.listMessages().find((message) => message.messageId === repair.messageId);
  if (!sourceMessage) {
    return;
  }

  writeRepairMessageOnce(kernel, {
    repair,
    sourceMessage,
    messageType: "progress_update",
    marker: "resolved",
    content: [
      `证据守卫已关闭补证任务：${repair.taskId}。`,
      `修复结果：${repair.resolution === "claim_corrected" ? "Agent 已更正为已验证真实产物路径。" : "原声明路径已补齐工具证据。"}`,
      `验证引用：${resolutionClaim.claimId}。`
    ].join("\n")
  });
}

function writeRepairMessageOnce(
  kernel: StudioKernel,
  input: {
    repair: ClaimRepair;
    sourceMessage: StudioMessage;
    messageType: MessageType;
    marker: "opened" | "resolved";
    content: string;
  }
): void {
  const exists = kernel
    .listMessages()
    .some((message) => message.metadata?.repairId === input.repair.repairId && message.metadata?.repairMessage === input.marker);
  if (exists) {
    return;
  }

  const now = new Date().toISOString();
  kernel.recordMessage({
    messageId: `msg_repair_${input.marker}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId: input.sourceMessage.roomId as RoomId,
    senderType: "agent",
    senderId: "studio_orchestrator",
    messageType: input.messageType,
    content: input.content,
    mentions: [input.repair.agentId],
    relatedTaskIds: [input.repair.taskId],
    relatedArtifactIds: [],
    metadata: {
      generatedBy: "claim_repair_guardian",
      repairId: input.repair.repairId,
      repairMessage: input.marker,
      sourceClaimId: input.repair.claimId
    },
    createdAt: now
  });
}

function writeRepairMemory(kernel: StudioKernel, repair: ClaimRepair, claim: ClaimVerification): void {
  const now = repair.updatedAt;
  const memoryId = `mem_claim_repair_${repair.repairId}_${repair.status}`;
  const exists = kernel
    .memory
    .query({ projectId: kernel.project.projectId, status: ["active", "draft", "superseded", "rejected", "archived"] })
    .some((record) => record.memoryId === memoryId);
  if (exists) {
    return;
  }

  const record: MemoryRecord = {
    memoryId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    scope: "artifact",
    ownerAgent: repair.agentId,
    type: repair.status === "resolved" ? "claim_repair_resolved" : "claim_repair_open",
    status: repair.status === "resolved" ? "active" : "draft",
    content:
      repair.status === "resolved"
        ? `声明修复已关闭：${repair.claimedPath ?? repair.claimId}，resolution=${repair.resolution}。`
        : `声明修复待处理：${claim.reason}；下一步：${repairNextStep(repair)}`,
    sourceMessageId: repair.messageId,
    createdAt: now,
    updatedAt: now
  };
  kernel.writeMemory(record);
}

function repairTitle(repair: ClaimRepair): string {
  const target = repair.claimedPath ?? repair.claimId;
  return `补证/纠错：${target}`;
}

function repairDescription(repair: ClaimRepair, claim: ClaimVerification): string {
  return [
    `Agent 声明未通过证据验证：${claim.reason}`,
    `原始 claimId：${claim.claimId}`,
    repair.claimedPath ? `声明路径：${repair.claimedPath}` : undefined,
    repair.nearestArtifactPath ? `最近实际产物：${repair.nearestArtifactPath}` : undefined,
    `处理要求：${repairNextStep(repair)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function repairAcceptanceCriteria(repair: ClaimRepair): string[] {
  const criteria = [
    "Claim Verifier 对后续声明返回 verified",
    "修复记录写入 shared/claims/claim-repairs.json",
    "修复任务由系统验证结果关闭，而不是 Agent 口头关闭"
  ];
  if (repair.action === "correct_claim" && repair.nearestArtifactPath) {
    criteria.unshift(`Agent 重新声明真实产物路径 ${repair.nearestArtifactPath}，并且该路径已在 artifact ledger 中 verified`);
  } else if (repair.claimedPath) {
    criteria.unshift(`通过 write_artifact / append_document 工具物化 ${repair.claimedPath} 并登记 hash/size`);
  }
  return criteria;
}

function repairNextStep(repair: ClaimRepair): string {
  if (repair.action === "correct_claim" && repair.nearestArtifactPath) {
    return `如果原路径写错，${repair.agentId} 必须重新发布更正声明，并引用已验证真实产物 ${repair.nearestArtifactPath}；如果原声明路径确实需要存在，则必须通过工具写入 ${repair.claimedPath ?? "对应路径"}。`;
  }

  return `${repair.agentId} 必须通过 write_artifact / append_document 工具写入声明产物并生成 artifact ledger 证据，或明确撤回该完成类声明。`;
}

function repairIdForClaim(claimId: string): string {
  return `repair_${claimId}`;
}

function taskIdForRepair(repairId: string): string {
  return `task_claim_repair_${createHash("sha1").update(repairId).digest("hex").slice(0, 10)}`;
}

function hashNumber(value: string, modulo: number): number {
  return Number.parseInt(createHash("sha1").update(value).digest("hex").slice(0, 6), 16) % modulo;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
