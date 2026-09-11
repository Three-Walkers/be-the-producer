import { createHash } from "node:crypto";
import type { GateEvidencePhase, StudioKernel } from "@game-pipeline/agent-runtime";
import type {
  AgentId,
  AuditEvidenceFact,
  AuditEvidenceLane,
  InterventionLedgerEntry,
  ProductionAuditDimension,
  ProductionAuditFinding,
  ProductionAuditRun,
  ProductionAuditSeverity,
  ProductionAuditTrigger,
  ProductionEvidenceBundle,
  StageId,
  Task,
  TaskEpisode
} from "@game-pipeline/shared-schemas";
import { qualityReviewContractForArtifact, qualityReviewReadyForGate } from "./qualityReviewArtifacts.js";
import { artifactReadyForConsumption, taskOutputsVerified } from "./taskOutputEvidence.js";

export interface ProductionAuditRequest {
  trigger?: ProductionAuditTrigger;
  triggerRef?: string;
  gateActionId?: "stage1" | "playable" | "release";
  phase?: GateEvidencePhase;
  requiredArtifactIds?: readonly string[];
  qaTaskId?: string;
  qaReportArtifactId?: string;
}

export interface ProductionAuditResult {
  episode: TaskEpisode;
  bundle: ProductionEvidenceBundle;
  run: ProductionAuditRun;
  created: boolean;
}

interface FindingDraft {
  signature: string;
  taskId?: string;
  artifactId?: string;
  ownerAgentId: AgentId;
  severity: ProductionAuditSeverity;
  dimension: ProductionAuditDimension;
  title: string;
  reason: string;
  evidenceRefs: string[];
  expectedOutcome: string;
  repairBoundary: string;
  acceptanceChecks: string[];
}

/**
 * Builds an immutable evidence bundle from runtime state. The auditor only reads
 * state owned by other subsystems; it never materializes production artifacts or
 * edits an Agent's work to make a finding pass.
 */
export function reconcileProductionAudit(
  kernel: StudioKernel,
  request: ProductionAuditRequest = {}
): ProductionAuditResult {
  const now = new Date().toISOString();
  const episode = reconcileTaskEpisode(kernel, now);
  const trigger = request.trigger ?? inferTrigger(kernel);
  const triggerRef = request.triggerRef ?? inferTriggerRef(kernel, trigger);
  const lanes = collectEvidenceLanes(kernel, episode, request);
  const bundleDigest = digest({
    episodeId: episode.episodeId,
    trigger,
    triggerRef,
    stageId: kernel.project.currentStage,
    lanes
  });
  const bundleId = `bundle_${bundleDigest.slice(0, 16)}`;
  const bundle: ProductionEvidenceBundle = {
    bundleId,
    projectId: kernel.project.projectId,
    episodeId: episode.episodeId,
    trigger,
    triggerRef,
    stageId: kernel.project.currentStage,
    status: lanes.some((lane) => lane.status === "unavailable")
      ? "failed"
      : lanes.some((lane) => lane.status === "partial")
        ? "partial"
        : "complete",
    lanes,
    digest: bundleDigest,
    frozenAt: now
  };
  kernel.recordEvidenceBundle(bundle);

  const auditRunId = `audit_${digest({ bundleDigest, trigger, triggerRef }).slice(0, 16)}`;
  const existingRun = kernel.listProductionAuditRuns().find((candidate) => candidate.auditRunId === auditRunId);
  if (existingRun) {
    return {
      episode,
      bundle: kernel.listEvidenceBundles().find((candidate) => candidate.bundleId === existingRun.bundleId) ?? bundle,
      run: existingRun,
      created: false
    };
  }

  const findings = reconcileFindings(kernel, episode, auditRunId, request, lanes, now);
  const blocking = findings.some((finding) => finding.status === "open" && isBlockingSeverity(finding.severity));
  const root = `shared/audit/runs/${auditRunId}`;
  const run: ProductionAuditRun = {
    auditRunId,
    projectId: kernel.project.projectId,
    episodeId: episode.episodeId,
    bundleId,
    trigger,
    triggerRef,
    stageId: kernel.project.currentStage,
    status: blocking ? "blocked" : bundle.status === "complete" ? "complete" : "partial",
    blocking,
    findingIds: findings.map((finding) => finding.findingId),
    findings: findings.map(cloneFinding),
    episodeSnapshot: cloneEpisode(episode),
    evidenceBundleSnapshot: cloneBundle(bundle),
    reportPaths: {
      episode: `${root}/episode.json`,
      evidenceBundle: `${root}/evidence-bundle.json`,
      findings: `${root}/findings.json`,
      markdown: `${root}/report.md`,
      html: `${root}/report.html`,
      manifest: `${root}/manifest.json`
    },
    evidenceDigest: bundleDigest,
    createdAt: now
  };
  kernel.recordProductionAuditRun(run);
  return { episode, bundle, run, created: true };
}

export function assertProductionAuditReadyForGate(run: ProductionAuditRun): void {
  const blocking = run.findings.filter(
    (finding) => finding.status === "open" && isBlockingSeverity(finding.severity)
  );
  if (blocking.length === 0) return;
  throw new Error(
    `生产审计未通过：${blocking.map((finding) => `${finding.title}（${finding.reason}）`).join("；")}`
  );
}

function reconcileTaskEpisode(kernel: StudioKernel, now: string): TaskEpisode {
  const scope = episodeScope(kernel.project.currentStage);
  const episodes = kernel.listTaskEpisodes();
  for (const previous of episodes.filter((candidate) => candidate.status !== "closed" && candidate.scope !== scope)) {
    kernel.upsertTaskEpisode({
      ...previous,
      status: previous.status === "reviewing" ? "accepted" : "closed",
      outcome: `工作流已进入 ${kernel.project.currentStage}，该 Episode 已封存。`,
      closedAt: now,
      updatedAt: now
    });
  }

  const active = episodes
    .filter((candidate) => candidate.scope === scope && candidate.status !== "closed" && candidate.status !== "accepted")
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  const producerMessages = kernel.listMessages().filter((message) => message.senderType === "producer");
  const scopeTasks = kernel.listTasks().filter((task) => taskMatchesEpisode(task, scope));
  const taskIds = scopeTasks.map((task) => task.taskId).sort();
  const taskIdSet = new Set(taskIds);
  const artifactIds = kernel
    .listArtifacts()
    .filter((artifact) => artifact.sourceTaskId ? taskIdSet.has(artifact.sourceTaskId) : artifact.stageId === kernel.project.currentStage)
    .map((artifact) => artifact.artifactId)
    .sort();
  const roomIds = [...new Set(producerMessages.map((message) => message.roomId))].sort();
  const sessionKeys = kernel
    .listAgentSessions()
    .filter((session) => session.taskId ? taskIdSet.has(session.taskId) : roomIds.includes(session.roomId))
    .map((session) => session.sessionKey)
    .sort();
  const workflow = kernel.getWorkflowSnapshot();
  const activeGate = workflow.gates.find((gate) => gate.gateId === workflow.activeGateId);
  const acceptanceBoundary = uniqueStrings([
    ...(activeGate?.checks ?? []),
    ...scopeTasks.flatMap((task) => task.acceptanceCriteria),
    ...scopeTasks.flatMap((task) => task.outputArtifacts.map((artifactId) => `产物 ${artifactId} 具有当前且可验证的证据`))
  ]);
  const latestGoalMessage = [...producerMessages]
    .reverse()
    .find((message) => message.messageType !== "progress_update" && !/^(有人吗|在吗|进度)/.test(message.content.trim()));
  const goal = [kernel.project.initialIdea, latestGoalMessage?.content]
    .filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index)
    .join("\n\n制作人最新要求：");
  const status: TaskEpisode["status"] = isReviewStage(kernel.project.currentStage) ? "reviewing" : "open";
  const episodeId = active?.episodeId ?? `episode_${scope}_${episodes.filter((episode) => episode.scope === scope).length + 1}_${digest({ projectId: kernel.project.projectId, scope, startedAt: now }).slice(0, 8)}`;
  const episode: TaskEpisode = {
    episodeId,
    projectId: kernel.project.projectId,
    scope,
    stageIds: uniqueStages([...(active?.stageIds ?? []), kernel.project.currentStage]),
    currentStageId: kernel.project.currentStage,
    goal: goal || "制作人尚未给出可审计的目标描述。",
    acceptanceBoundary: acceptanceBoundary.length > 0 ? acceptanceBoundary : ["制作人明确验收边界并完成对应阶段门禁"],
    status,
    producerMessageIds: producerMessages.map((message) => message.messageId),
    roomIds,
    taskIds,
    artifactIds,
    sessionKeys,
    startedAt: active?.startedAt ?? now,
    updatedAt: now
  };
  return kernel.upsertTaskEpisode(episode);
}

function collectEvidenceLanes(
  kernel: StudioKernel,
  episode: TaskEpisode,
  request: ProductionAuditRequest
): AuditEvidenceLane[] {
  const producerMessages = kernel.listMessages().filter((message) => episode.producerMessageIds.includes(message.messageId));
  const sessions = kernel.listAgentSessions().filter((session) => episode.sessionKeys.includes(session.sessionKey));
  const sessionFacts: AuditEvidenceFact[] = [
    ...producerMessages.slice(-20).map((message): AuditEvidenceFact => ({
      ref: `message:${message.messageId}`,
      refType: "message",
      summary: `制作人 ${message.messageType}，${message.createdAt}`,
      status: "observed"
    })),
    ...sessions.map((session): AuditEvidenceFact => ({
      ref: `session:${session.sessionKey}`,
      refType: "session",
      summary: `${session.agentId} ${session.scope} session，状态 ${session.status}，context ${session.contextHealth?.status ?? "unknown"}`,
      status: session.status === "failed" ? "failed" : "observed"
    }))
  ];
  const sessionMissing = [
    ...(producerMessages.length === 0 ? ["缺少制作人目标消息"] : []),
    ...(kernel.project.executionStatus === "running" && sessions.length === 0 ? ["尚无可观察的 Agent session"] : [])
  ];

  const episodeTasks = kernel.listTasks().filter((task) => episode.taskIds.includes(task.taskId));
  const artifacts = kernel.listArtifacts().filter((artifact) => episode.artifactIds.includes(artifact.artifactId));
  const ledger = kernel.listArtifactLedger();
  const artifactFacts: AuditEvidenceFact[] = [
    ...episodeTasks.map((task): AuditEvidenceFact => ({
      ref: `task:${task.taskId}`,
      refType: "task",
      summary: `${task.title} [${task.status}, ${task.progressPercent ?? 0}%]`,
      status: task.status === "blocked" ? "failed" : "observed"
    })),
    ...artifacts.map((artifact): AuditEvidenceFact => {
      const evidence = ledger.find((entry) => entry.artifactId === artifact.artifactId);
      const current = artifactEvidenceIsCurrent(kernel, artifact.artifactId);
      return {
        ref: `artifact:${artifact.artifactId}`,
        refType: "artifact",
        summary: `${artifact.path} v${artifact.version}，ledger ${evidence?.status ?? "missing"}，current ${current ? "yes" : "no"}`,
        status: current ? "verified" : evidence?.status === "pending" || !evidence ? "unobserved" : "failed",
        ...(evidence?.hash ? { digest: evidence.hash } : {})
      };
    }),
    ...kernel.listClaimVerifications().map((claim): AuditEvidenceFact => ({
      ref: `claim:${claim.claimId}`,
      refType: "claim",
      summary: `${claim.claimType} ${claim.claimedPath ?? ""}：${claim.verdict}`,
      status: claim.verdict === "verified" ? "verified" : claim.verdict === "mismatch" ? "failed" : "unobserved"
    }))
  ];
  const artifactMissing = [
    ...episodeTasks
      .filter((task) => ["review", "done"].includes(task.status) && !taskCompletionEvidenceVerified(kernel, task))
      .map((task) => `任务 ${task.taskId} 的登记输出尚未全部验证`),
    ...kernel.listClaimRepairs().filter((repair) => repair.status === "open").map((repair) => `声明补证 ${repair.repairId} 尚未关闭`)
  ];

  const requiredArtifactIds = uniqueStrings([
    ...(request.requiredArtifactIds ?? []),
    ...(kernel.getWorkflowSnapshot().gates.find((gate) => gate.gateId === kernel.getWorkflowSnapshot().activeGateId)?.requiredArtifacts ?? [])
  ]);
  const validationFacts: AuditEvidenceFact[] = [];
  const validationMissing: string[] = [];
  for (const artifactId of requiredArtifactIds) {
    const contract = qualityReviewContractForArtifact(artifactId);
    if (!contract) continue;
    const result = qualityReviewReadyForGate(kernel, artifactId, true);
    validationFacts.push({
      ref: `validation:quality:${artifactId}`,
      refType: "validation",
      summary: `${artifactId} 独立质量审查：${result.ok ? "pass" : result.reason ?? "missing"}`,
      status: result.ok ? "verified" : "failed"
    });
    if (!result.ok) validationMissing.push(`${artifactId} 的独立质量审查未通过`);
  }
  if (request.qaTaskId) {
    const qaTask = kernel.findTask(request.qaTaskId);
    const ok = Boolean(qaTask && taskOutputsVerified(kernel, qaTask));
    validationFacts.push({
      ref: `validation:qa:${request.qaTaskId}`,
      refType: "validation",
      summary: `${request.qaTaskId}：${qaTask?.status ?? "missing"}`,
      status: ok ? "verified" : "failed"
    });
    if (!ok) validationMissing.push(`QA 任务 ${request.qaTaskId} 缺少已验证输出`);
  }
  for (const event of kernel.listAuditEvents().filter((event) => ["COCOS_BUILD_COMPLETED", "QA_REPORT_CREATED", "RELEASE_GATE_COMPLETED"].includes(event.eventType))) {
    validationFacts.push({
      ref: `validation:event:${event.eventId}`,
      refType: "validation",
      summary: `${event.eventType}：${event.status}`,
      status: event.status === "completed" ? "verified" : "failed"
    });
  }

  const workflow = kernel.getWorkflowSnapshot();
  const activeGate = workflow.gates.find((gate) => gate.gateId === workflow.activeGateId);
  const decisionFacts: AuditEvidenceFact[] = [
    ...workflow.decisions.map((decision): AuditEvidenceFact => ({
      ref: `decision:${decision.decisionId}`,
      refType: "decision",
      summary: `${decision.stage}：${decision.verdict} (${decision.status})`,
      status: "verified"
    })),
    ...kernel.listHandoffCapsules().map((capsule): AuditEvidenceFact => ({
      ref: `handoff:${capsule.capsuleId}`,
      refType: "handoff",
      summary: `${capsule.kind}：${capsule.sourceAgentId} → ${capsule.targetAgentIds.join("、") || "未指定"}`,
      status: capsule.consumedBySessionKeys.length > 0 ? "verified" : "observed"
    }))
  ];
  if (activeGate) {
    decisionFacts.push({
      ref: `workflow:gate:${activeGate.gateId}`,
      refType: "workflow",
      summary: `${activeGate.label}：${activeGate.status}`,
      status: activeGate.status === "pending_producer" ? "observed" : "verified"
    });
  }
  const decisionMissing = isReviewStage(kernel.project.currentStage) && !activeGate
    ? ["工作流处于评审阶段，但没有活动门禁"]
    : [];

  return [
    lane("session", sessionFacts, sessionMissing),
    lane("artifact", artifactFacts, artifactMissing),
    lane("validation", validationFacts, validationMissing),
    lane("decision_delivery", decisionFacts, decisionMissing)
  ];
}

function reconcileFindings(
  kernel: StudioKernel,
  episode: TaskEpisode,
  auditRunId: string,
  request: ProductionAuditRequest,
  lanes: AuditEvidenceLane[],
  now: string
): ProductionAuditFinding[] {
  const drafts: FindingDraft[] = [];
  const required = uniqueStrings(request.requiredArtifactIds ?? []);
  for (const artifactId of required) {
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId);
    if (
      ledger?.status === "verified" &&
      ledger.hash &&
      ledger.sizeBytes !== undefined &&
      artifactEvidenceIsCurrent(kernel, artifactId)
    ) {
      continue;
    }
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    drafts.push({
      signature: `required-artifact:${artifactId}`,
      ...(artifact?.sourceTaskId ? { taskId: artifact.sourceTaskId } : {}),
      artifactId,
      ownerAgentId: artifact?.ownerAgentId ?? "studio_orchestrator",
      severity: "high",
      dimension: "artifact_integrity",
      title: "门禁产物缺少当前证据",
      reason: `${artifactId} 没有可消费的当前文件与 verified hash/size 证据。`,
      evidenceRefs: [`artifact:${artifactId}`, ...(ledger ? [`ledger:${ledger.sourceOperationId}`] : [])],
      expectedOutcome: "当前版本产物由授权工具物化，并在 Artifact Ledger 中登记 verified hash/size。",
      repairBoundary: "责任 Agent 只能修复自己的登记产物；审计器不得代写产物。",
      acceptanceChecks: ["路径存在且为预期文件类型", "hash/size 与当前文件一致", "sourceOperationId 可追溯"]
    });
  }
  for (const task of kernel.listTasks().filter((candidate) => episode.taskIds.includes(candidate.taskId))) {
    if (!["review", "done"].includes(task.status) || taskCompletionEvidenceVerified(kernel, task)) continue;
    drafts.push(taskEvidenceFinding(task));
  }
  for (const repair of kernel.listClaimRepairs().filter((candidate) => candidate.status === "open")) {
    drafts.push({
      signature: `claim-repair:${repair.repairId}`,
      taskId: repair.taskId,
      ownerAgentId: repair.agentId,
      severity: "high",
      dimension: "artifact_integrity",
      title: "完成声明仍待补证或纠错",
      reason: repair.reason,
      evidenceRefs: [`claim:${repair.claimId}`, `repair:${repair.repairId}`],
      expectedOutcome: "通过授权工具补齐真实文件证据，或明确撤回错误完成声明。",
      repairBoundary: "只能由声明责任角色补证或纠错，Orchestrator 不能代替责任角色制造证据。",
      acceptanceChecks: ["Claim Verifier verdict=verified", "补证任务关闭", "相关任务状态重新由证据驱动"]
    });
  }
  for (const claim of kernel.listClaimVerifications().filter((candidate) => candidate.verdict === "mismatch")) {
    if (kernel.listClaimRepairs().some((repair) =>
      (repair.claimId === claim.claimId || repair.repairId === claim.metadata.repairId) &&
      repair.status === "resolved" && repair.resolution === "claim_retracted")) continue;
    if (kernel.listClaimRepairs().some((repair) => repair.claimId === claim.claimId && repair.status === "open")) continue;
    drafts.push({
      signature: `claim-mismatch:${claim.claimId}`,
      ownerAgentId: claim.agentId,
      // A proposed path is not a claim of completed work. Keep broken references
      // visible without turning a future-work list into a production blocker.
      severity: claim.claimType === "path_reference" ? "low" : "high",
      dimension: "artifact_integrity",
      title: claim.claimType === "path_reference" ? "引用路径尚未物化或需要核对" : "Agent 声明与实际文件不一致",
      reason: claim.reason,
      evidenceRefs: [`claim:${claim.claimId}`, ...claim.evidenceRefs],
      expectedOutcome: "声明引用的文件、版本与工具操作证据完全一致。",
      repairBoundary: "不得通过创建空目录、父目录回退或聊天解释掩盖不存在的文件。",
      acceptanceChecks: ["精确路径存在", "文件非空", "产物 owner/sourceOperationId 一致"]
    });
  }
  const validationLane = lanes.find((candidate) => candidate.kind === "validation");
  for (const missing of validationLane?.missing ?? []) {
    drafts.push({
      signature: `validation:${missing}`,
      ownerAgentId: request.qaTaskId ? kernel.findTask(request.qaTaskId)?.ownerAgentId ?? "qa_evaluator" : "studio_orchestrator",
      severity: "high",
      dimension: "quality_validation",
      title: "独立验证证据未达到门禁要求",
      reason: missing,
      evidenceRefs: validationLane?.facts.map((fact) => fact.ref) ?? [],
      expectedOutcome: "由独立评审/QA 对当前 hash 绑定版本给出可复验通过收据。",
      repairBoundary: "作者不能自审；失败应回流给产物责任角色，审查角色保持只读。",
      acceptanceChecks: ["审查目标绑定当前 artifact hash/version", "verdict=pass", "不存在 blocker/critical/major 缺陷"]
    });
  }
  const sessionLane = lanes.find((candidate) => candidate.kind === "session");
  if (
    (request.trigger === "stage_gate" || request.trigger === "release_gate") &&
    sessionLane?.missing.includes("缺少制作人目标消息") &&
    !kernel.project.initialIdea?.trim()
  ) {
    drafts.push({
      signature: "producer-goal-missing",
      ownerAgentId: "producer",
      severity: "high",
      dimension: "intent_alignment",
      title: "门禁缺少制作人目标边界",
      reason: "当前 Task Episode 没有可引用的制作人目标消息。",
      evidenceRefs: [],
      expectedOutcome: "制作人目标和验收边界被记录为可追溯消息与 Episode。",
      repairBoundary: "Agent 可以提出澄清问题，但不能替制作人编造目标。",
      acceptanceChecks: ["存在制作人目标消息", "Episode goal 非空", "验收边界可观察"]
    });
  }

  const activeSignatures = new Set(drafts.map((draft) => draft.signature));
  for (const previous of kernel.listProductionAuditFindings().filter((finding) => finding.episodeId === episode.episodeId && finding.status === "open")) {
    if (activeSignatures.has(previous.signature)) continue;
    kernel.upsertProductionAuditFinding({ ...previous, status: "resolved", resolvedAt: now, updatedAt: now });
    const intervention = kernel.listInterventionLedger().find((entry) => entry.findingId === previous.findingId);
    if (intervention) {
      kernel.upsertIntervention({
        ...intervention,
        status: "outcome_supported",
        comparison: {
          label: "复核窗口",
          value: "原审计条件已不再出现",
          evidenceRefs: [`audit:${auditRunId}`],
          observedAt: now
        },
        updatedAt: now
      });
    }
  }

  return drafts.map((draft) => {
    const existing = kernel.listProductionAuditFindings().find(
      (finding) => finding.episodeId === episode.episodeId && finding.signature === draft.signature
    );
    const finding: ProductionAuditFinding = {
      findingId: existing?.findingId ?? `finding_${digest({ episodeId: episode.episodeId, signature: draft.signature }).slice(0, 16)}`,
      signature: draft.signature,
      projectId: kernel.project.projectId,
      auditRunId,
      episodeId: episode.episodeId,
      ...(draft.taskId ? { taskId: draft.taskId } : {}),
      ...(draft.artifactId ? { artifactId: draft.artifactId } : {}),
      ownerAgentId: draft.ownerAgentId,
      severity: draft.severity,
      dimension: draft.dimension,
      title: draft.title,
      reason: draft.reason,
      evidenceRefs: uniqueStrings(draft.evidenceRefs),
      expectedOutcome: draft.expectedOutcome,
      repairBoundary: draft.repairBoundary,
      acceptanceChecks: draft.acceptanceChecks,
      status: "open",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    kernel.upsertProductionAuditFinding(finding);
    if (isBlockingSeverity(finding.severity)) upsertIntervention(kernel, finding, now);
    return finding;
  });
}

function upsertIntervention(kernel: StudioKernel, finding: ProductionAuditFinding, now: string): void {
  const interventionId = `intervention_${digest(finding.findingId).slice(0, 16)}`;
  const existing = kernel.listInterventionLedger().find((entry) => entry.interventionId === interventionId);
  const entry: InterventionLedgerEntry = {
    interventionId,
    projectId: finding.projectId,
    episodeId: finding.episodeId,
    findingId: finding.findingId,
    ownerAgentId: finding.ownerAgentId,
    action: finding.repairBoundary,
    expectedOutcome: finding.expectedOutcome,
    stopOrRevertCondition: "复核窗口未改善、产生新 mismatch，或修复越过责任角色授权边界时停止并回滚。",
    status: existing?.status === "outcome_supported" ? "regressing" : existing ? "unchanged" : "pending",
    baseline: existing?.baseline ?? {
      label: "发现窗口",
      value: `${finding.severity}:${finding.dimension}`,
      evidenceRefs: finding.evidenceRefs,
      observedAt: finding.createdAt
    },
    ...(existing?.comparison ? { comparison: existing.comparison } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  kernel.upsertIntervention(entry);
}

function taskCompletionEvidenceVerified(kernel: StudioKernel, task: Task): boolean {
  // Groups aggregate their children; each actual task is audited independently.
  if (task.taskLevel === "task_group") return true;
  const repair = kernel.listClaimRepairs().find((entry) => entry.taskId === task.taskId);
  if (!repair) return taskOutputsVerified(kernel, task);
  if (repair.status !== "resolved") return false;
  if (repair.resolution === "claim_retracted") {
    const message = kernel.listMessages().find((entry) => entry.messageId === repair.resolutionMessageId);
    const source = kernel.listMessages().find((entry) => entry.messageId === repair.messageId);
    return Boolean(message && source && message.senderType === "agent" && message.senderId === repair.agentId &&
      Date.parse(message.createdAt) >= Date.parse(source.createdAt) &&
      message.content.split(/\r?\n/, 1)[0]?.trim() === `撤回声明：${repair.claimId}`);
  }
  return kernel.listClaimVerifications().some((claim) => claim.claimId === repair.resolutionClaimId &&
    claim.agentId === repair.agentId && claim.verdict === "verified");
}

function taskEvidenceFinding(task: Task): FindingDraft {
  return {
    signature: `task-output:${task.taskId}`,
    taskId: task.taskId,
    ownerAgentId: task.ownerAgentId,
    severity: "high",
    dimension: "controlled_production",
    title: "任务评审状态缺少完整输出证据",
    reason: `${task.title} 已处于 ${task.status}，但登记输出尚未全部通过 Artifact Ledger 校验。`,
    evidenceRefs: [`task:${task.taskId}`, ...task.outputArtifacts.map((artifactId) => `artifact:${artifactId}`)],
    expectedOutcome: "任务只有在全部登记输出具备当前 verified 证据后进入 review/done。",
    repairBoundary: "任务责任 Agent 补齐登记输出，评审者只能验证，不能代写。",
    acceptanceChecks: ["所有 outputArtifacts 均有 verified ledger", "任务输出版本与输入 provenance 当前", "不存在开放 claim repair"]
  };
}

function lane(kind: AuditEvidenceLane["kind"], facts: AuditEvidenceFact[], missing: string[]): AuditEvidenceLane {
  return {
    kind,
    status: missing.length === 0 ? "available" : facts.length === 0 ? "unavailable" : "partial",
    facts,
    missing: uniqueStrings(missing)
  };
}

function artifactEvidenceIsCurrent(kernel: StudioKernel, artifactId: string): boolean {
  try {
    return artifactReadyForConsumption(kernel, artifactId);
  } catch {
    return false;
  }
}

function inferTrigger(kernel: StudioKernel): ProductionAuditTrigger {
  if (kernel.project.currentStage === "release_gate") return "release_gate";
  if (kernel.getWorkflowSnapshot().activeGateId) return "stage_gate";
  if (kernel.listTasks().some((task) => task.status === "review")) return "task_review";
  return "checkpoint";
}

function inferTriggerRef(kernel: StudioKernel, trigger: ProductionAuditTrigger): string {
  const workflow = kernel.getWorkflowSnapshot();
  if (workflow.activeGateId) return `gate:${workflow.activeGateId}:r${workflow.revision}`;
  if (trigger === "task_review") {
    return `tasks:${kernel.listTasks().filter((task) => task.status === "review").map((task) => `${task.taskId}@${task.updatedAt}`).sort().join(",")}`;
  }
  return `workflow:r${workflow.revision}`;
}

function episodeScope(stageId: StageId): TaskEpisode["scope"] {
  if (["concept_discussion", "concept_review"].includes(stageId)) return "concept";
  if (["production", "first_playable_review"].includes(stageId)) return "first_playable";
  if (["release_preparation", "release_gate"].includes(stageId)) return "release";
  if (stageId === "production_deploy") return "deployment";
  return "liveops";
}

function taskMatchesEpisode(task: Task, scope: TaskEpisode["scope"]): boolean {
  return episodeScope(task.stageId) === scope;
}

function isReviewStage(stageId: StageId): boolean {
  return ["concept_review", "first_playable_review", "release_gate"].includes(stageId);
}

function isBlockingSeverity(severity: ProductionAuditSeverity): boolean {
  return severity === "critical" || severity === "high";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function uniqueStages(values: StageId[]): StageId[] {
  return [...new Set(values)];
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneFinding(finding: ProductionAuditFinding): ProductionAuditFinding {
  return { ...finding, evidenceRefs: [...finding.evidenceRefs], acceptanceChecks: [...finding.acceptanceChecks] };
}

function cloneEpisode(episode: TaskEpisode): TaskEpisode {
  return {
    ...episode,
    stageIds: [...episode.stageIds],
    acceptanceBoundary: [...episode.acceptanceBoundary],
    producerMessageIds: [...episode.producerMessageIds],
    roomIds: [...episode.roomIds],
    taskIds: [...episode.taskIds],
    artifactIds: [...episode.artifactIds],
    sessionKeys: [...episode.sessionKeys]
  };
}

function cloneBundle(bundle: ProductionEvidenceBundle): ProductionEvidenceBundle {
  return {
    ...bundle,
    lanes: bundle.lanes.map((lane) => ({
      ...lane,
      facts: lane.facts.map((fact) => ({ ...fact })),
      missing: [...lane.missing]
    }))
  };
}
