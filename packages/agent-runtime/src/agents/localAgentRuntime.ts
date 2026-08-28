import type {
  AgentId,
  Artifact,
  MemoryRecord,
  MessageType,
  RoomKind,
  StageId,
  StudioMessage,
  Task,
  TaskChildrenSummary
} from "@game-pipeline/shared-schemas";
import type { AgentRouteScore, RoutePlan } from "../chat/router.js";
import type { StudioKernel, StudioKernelSnapshot } from "../studio/studioKernel.js";
import { createSampleIdeaTemplateRegistry, type IdeaTemplateRegistry } from "../templates/index.js";

export interface LocalAgentRunResult {
  routePlan: RoutePlan;
  agentMessages: StudioMessage[];
}

export interface LocalAgentRuntimeOptions {
  scriptedReplies?: boolean;
  protocolFlows?: boolean;
  bootstrapProjectState?: boolean;
  gateEvidencePolicy?: GateEvidencePolicy;
}

export interface LocalAgentRuntimeDependencies {
  ideaTemplates?: IdeaTemplateRegistry;
  gateEvidencePolicy?: GateEvidencePolicy;
}

export interface LocalRuntimeReconciliationResult {
  changed: boolean;
  taskIds: string[];
  artifactIds: string[];
}

export interface LocalRuntimeSnapshotMigrationResult {
  snapshot: StudioKernelSnapshot;
  changed: boolean;
  artifactIdMigrations: Array<{ fromArtifactId: string; toArtifactId: string }>;
}

export interface LocalRuntimeSnapshotMigrationOptions {
  legacyArtifactIdFor(projectId: string, ownerAgentId: AgentId, path: string): string;
}

export interface StageOneArtifactContract {
  readonly artifactId: string;
  readonly type: Artifact["type"];
  readonly path: string;
  readonly ownerAgentId: AgentId;
  readonly sourceTaskId: string;
}

const stageOneArtifactContractDefinitions: readonly StageOneArtifactContract[] = Object.freeze([
  Object.freeze({
    artifactId: "artifact_gdd_baseline_draft",
    type: "gdd" as const,
    path: "agents/design/gdd/00_overview.md",
    ownerAgentId: "game_designer" as const,
    sourceTaskId: "task_stage_1_design_clarification"
  }),
  Object.freeze({
    artifactId: "artifact_game_contract_draft",
    type: "game_contract" as const,
    path: "agents/design/contracts/game-contract.json",
    ownerAgentId: "game_designer" as const,
    sourceTaskId: "task_stage_1_design_clarification"
  }),
  Object.freeze({
    artifactId: "artifact_art_bible_baseline_draft",
    type: "art_bible" as const,
    path: "agents/art/art-bible.md",
    ownerAgentId: "art_director" as const,
    sourceTaskId: "task_stage_1_art_direction"
  }),
  Object.freeze({
    artifactId: "artifact_art_direction_board",
    type: "asset" as const,
    path: "agents/art/art-direction-board.png",
    ownerAgentId: "art_director" as const,
    sourceTaskId: "task_stage_1_art_direction"
  })
]);

export function getStageOneArtifactContracts(): readonly StageOneArtifactContract[] {
  return stageOneArtifactContractDefinitions;
}

export interface QualityReviewArtifactContract {
  readonly artifactId: string;
  readonly type: "quality_review";
  readonly path: string;
  readonly ownerAgentId: AgentId;
  readonly sourceTaskId: string;
  readonly domain: "design" | "art_direction" | "visual_assets";
  readonly subjectArtifactIds: readonly string[];
  readonly rubric: {
    readonly rubricId: string;
    readonly version: string;
    readonly passThreshold: number;
    readonly criteria: readonly {
      readonly criterionId: string;
      readonly label: string;
      readonly weight: number;
    }[];
  };
}

const qualityReviewArtifactContractDefinitions: readonly QualityReviewArtifactContract[] = Object.freeze([
  Object.freeze({
    artifactId: "artifact_stage_1_design_quality_review",
    type: "quality_review" as const,
    path: "agents/review/design/stage-1.quality-review.json",
    ownerAgentId: "design_quality_reviewer" as const,
    sourceTaskId: "task_stage_1_design_quality_review",
    domain: "design" as const,
    subjectArtifactIds: Object.freeze(["artifact_gdd_baseline_draft", "artifact_game_contract_draft"]),
    rubric: Object.freeze({
      rubricId: "stage1.design-quality",
      version: "1.0.0",
      passThreshold: 85,
      criteria: Object.freeze([
        Object.freeze({ criterionId: "core_loop_player_value", label: "核心循环与玩家价值", weight: 25 }),
        Object.freeze({ criterionId: "cross_artifact_consistency", label: "GDD 与 GameContract 一致性", weight: 20 }),
        Object.freeze({ criterionId: "balance_and_pacing", label: "节奏与数值依据", weight: 15 }),
        Object.freeze({ criterionId: "mvp_feasibility", label: "MVP 范围与实现可行性", weight: 15 }),
        Object.freeze({ criterionId: "mobile_accessibility", label: "移动端可用性与可访问性", weight: 10 }),
        Object.freeze({ criterionId: "testability_observability", label: "可测试性与可观测性", weight: 15 })
      ])
    })
  }),
  Object.freeze({
    artifactId: "artifact_stage_1_visual_quality_review",
    type: "quality_review" as const,
    path: "agents/review/art/stage-1.quality-review.json",
    ownerAgentId: "visual_quality_reviewer" as const,
    sourceTaskId: "task_stage_1_visual_quality_review",
    domain: "art_direction" as const,
    subjectArtifactIds: Object.freeze(["artifact_art_bible_baseline_draft", "artifact_art_direction_board"]),
    rubric: Object.freeze({
      rubricId: "stage1.art-direction-quality",
      version: "1.0.0",
      passThreshold: 85,
      criteria: Object.freeze([
        Object.freeze({ criterionId: "visual_consistency", label: "视觉主张一致性", weight: 25 }),
        Object.freeze({ criterionId: "small_screen_readability", label: "轮廓、焦点与小屏可读性", weight: 20 }),
        Object.freeze({ criterionId: "palette_hierarchy", label: "色板与对比层级", weight: 15 }),
        Object.freeze({ criterionId: "mobile_ui_readability", label: "移动 UI 可读性", weight: 15 }),
        Object.freeze({ criterionId: "production_feasibility", label: "生产与技术可行性", weight: 15 }),
        Object.freeze({ criterionId: "originality_ip_safety", label: "原创性与 IP 安全", weight: 10 })
      ])
    })
  }),
  Object.freeze({
    artifactId: "artifact_stage_2_visual_quality_review",
    type: "quality_review" as const,
    path: "agents/review/art/first-playable.quality-review.json",
    ownerAgentId: "visual_quality_reviewer" as const,
    sourceTaskId: "task_stage_2_visual_quality_review",
    domain: "visual_assets" as const,
    subjectArtifactIds: Object.freeze([
      "artifact_art_bible_baseline_draft",
      "artifact_asset_manifest_draft",
      "artifact_asset_contact_sheet"
    ]),
    rubric: Object.freeze({
      rubricId: "stage2.visual-assets-quality",
      version: "1.0.0",
      passThreshold: 85,
      criteria: Object.freeze([
        Object.freeze({ criterionId: "art_bible_consistency", label: "Art Bible 一致性", weight: 20 }),
        Object.freeze({ criterionId: "runtime_readability", label: "运行资产小屏辨识", weight: 20 }),
        Object.freeze({ criterionId: "ui_hierarchy", label: "UI 层级", weight: 15 }),
        Object.freeze({ criterionId: "alpha_edge_integrity", label: "透明通道与边缘完整性", weight: 15 }),
        Object.freeze({ criterionId: "performance_budget", label: "性能与纹理预算", weight: 10 }),
        Object.freeze({ criterionId: "coverage_completeness", label: "资产覆盖完整性", weight: 10 }),
        Object.freeze({ criterionId: "originality_ip_safety", label: "原创性与 IP 安全", weight: 10 })
      ])
    })
  })
]);

export function getQualityReviewArtifactContracts(): readonly QualityReviewArtifactContract[] {
  return qualityReviewArtifactContractDefinitions;
}

export type GateEvidencePhase = "review" | "decision";

export interface GateEvidenceRequirement {
  gateActionId: "stage1" | "playable" | "release";
  phase: GateEvidencePhase;
  requiredArtifactIds: readonly string[];
  qaTaskId?: string;
  qaReportArtifactId?: string;
}

/**
 * Application boundary for evidence validation. The runtime package deliberately
 * knows nothing about workspace files, contract parsers, or protected QA receipts.
 * Deployments must inject a policy that validates those application-owned facts.
 */
export interface GateEvidencePolicy {
  assertGateEvidence(kernel: StudioKernel, requirement: GateEvidenceRequirement): void;
}

type Handler = (input: HandlerInput) => void;

interface HandlerInput {
  kernel: StudioKernel;
  producerMessage: StudioMessage;
  route: AgentRouteScore;
  now: string;
  ideaTemplates: IdeaTemplateRegistry;
}

type GateActionId = "stage1" | "playable" | "release";

interface GateAction {
  actionId: GateActionId;
  label: string;
  confirmToken: string;
  sourceStage: StageId;
  reviewStage: StageId;
  expectedStages: StageId[];
  requiredArtifacts: string[];
  checks: string[];
}

interface GateReviewLine {
  agentId: AgentId;
  roomKind: RoomKind;
  messageType: MessageType;
  content: string;
}

const gateActions: Record<GateActionId, GateAction> = {
  stage1: {
    actionId: "stage1",
    label: "确认立项",
    confirmToken: "执行确认：确认立项",
    sourceStage: "concept_discussion",
    reviewStage: "concept_review",
    expectedStages: ["concept_discussion", "concept_review"],
    requiredArtifacts: [
      "artifact_gdd_baseline_draft",
      "artifact_game_contract_draft",
      "artifact_art_bible_baseline_draft",
      "artifact_art_direction_board",
      "artifact_stage_1_design_quality_review",
      "artifact_stage_1_visual_quality_review"
    ],
    checks: ["gdd_verified", "game_contract_verified", "design_quality_passed", "art_direction_verified", "visual_quality_passed", "scope_reviewed"]
  },
  playable: {
    actionId: "playable",
    label: "首个可玩通过",
    confirmToken: "执行确认：首个可玩通过",
    sourceStage: "production",
    reviewStage: "first_playable_review",
    expectedStages: ["production", "first_playable_review"],
    requiredArtifacts: [
      "artifact_game_contract_draft",
      "artifact_asset_manifest_draft",
      "artifact_asset_contact_sheet",
      "artifact_stage_2_visual_quality_review",
      "artifact_scene_blueprint_draft",
      "artifact_playtest_contract_draft",
      "artifact_gameplay_source",
      "artifact_wechat_dev_build",
      "artifact_qa_playtest_report"
    ],
    checks: ["contracts_compatible", "visual_asset_quality_passed", "development_build_verified", "playtest_passed"]
  },
  release: {
    actionId: "release",
    label: "批准发布",
    confirmToken: "执行确认：批准发布",
    sourceStage: "release_preparation",
    reviewStage: "release_gate",
    expectedStages: ["release_preparation", "release_gate"],
    requiredArtifacts: [
      "artifact_wechat_release_build",
      "artifact_release_gate_report",
      "artifact_deployment_plan",
      "artifact_rollback_plan"
    ],
    checks: ["release_build_verified", "release_playtest_passed", "rollback_ready", "deployment_plan_ready"]
  }
};

const emptyChildrenSummary = (): TaskChildrenSummary => ({
  doing: 0,
  blocked: 0,
  todo: 0,
  done: 0,
  cancelled: 0
});

export class LocalAgentRuntime {
  private readonly ideaTemplates: IdeaTemplateRegistry;
  private readonly gateEvidencePolicy: GateEvidencePolicy;

  constructor(dependencies: LocalAgentRuntimeDependencies = {}) {
    this.ideaTemplates = dependencies.ideaTemplates ?? createSampleIdeaTemplateRegistry();
    this.gateEvidencePolicy = dependencies.gateEvidencePolicy ?? conservativeRuntimeGateEvidencePolicy;
  }

  private readonly handlers: Partial<Record<AgentId, Handler>> = {
    studio_orchestrator: handleOrchestrator,
    producer: handleProducer,
    game_designer: handleGameDesigner,
    design_quality_reviewer: handleDesignQualityReviewer,
    art_director: handleArtDirector,
    asset_production: handleAssetProduction,
    visual_quality_reviewer: handleVisualQualityReviewer,
    cocos_tech_lead: handleCocosTechLead,
    gameplay_programmer: handleGameplayProgrammer,
    cocos_automation: handleCocosAutomation,
    qa_evaluator: handleQaEvaluator,
    wechat_platform: handleWeChatPlatform,
    devops: handleDevOps,
    liveops_analytics: handleLiveOps
  };

  handleProducerMessage(kernel: StudioKernel, message: StudioMessage, options: LocalAgentRuntimeOptions = {}): LocalAgentRunResult {
    const scriptedReplies = options.scriptedReplies ?? true;
    const protocolFlows = options.protocolFlows ?? true;
    const routePlan = kernel.postMessage(message);
    const before = kernel.listMessages().length;
    const now = new Date().toISOString();

    if (options.bootstrapProjectState) {
      bootstrapConceptDiscussion(kernel, message, now);
    }

    const gate = resolveGateAction(kernel, message.content);
    const shouldRunLocalDecisionFlow = gate ? protocolFlows : false;
    const transitionApplied = gate && shouldRunLocalDecisionFlow
      ? applyProducerDecisionFlow(kernel, message, gate, now, options.gateEvidencePolicy ?? this.gateEvidencePolicy)
      : false;
    if (transitionApplied) {
      return {
        routePlan,
        agentMessages: kernel.listMessages().slice(before)
      };
    }

    if (!scriptedReplies) {
      return {
        routePlan,
        agentMessages: kernel.listMessages().slice(before)
      };
    }

    if (isPresencePing(message.content)) {
      writePresenceResponse(kernel);
      return {
        routePlan,
        agentMessages: kernel.listMessages().slice(before)
      };
    }

    for (const route of routePlan.targets) {
      const handler = this.handlers[route.agentId];
      if (handler) {
        handler({
          kernel,
          producerMessage: message,
          route,
          now,
          ideaTemplates: this.ideaTemplates
        });
      }
    }

    return {
      routePlan,
      agentMessages: kernel.listMessages().slice(before)
    };
  }
}

/**
 * Reconciles deterministic task/artifact declarations owned by the local runtime.
 *
 * Older snapshots may contain Stage 1 tasks created before their canonical output
 * artifacts were registered. Keeping this migration beside the task blueprint
 * prevents the API layer from guessing artifact identities or weakening Harness
 * authorization when those snapshots are restored.
 */
export function reconcileLocalRuntimeProjectState(
  kernel: StudioKernel,
  now = new Date().toISOString()
): LocalRuntimeReconciliationResult {
  const stageOneTaskIds = [
    "task_group_stage_1",
    "task_stage_1_design_clarification",
    "task_stage_1_art_direction",
    "task_stage_1_design_quality_review",
    "task_stage_1_visual_quality_review",
    "task_stage_1_scope_review"
  ];
  const stageOneArtifactIds = [
    "artifact_gdd_baseline_draft",
    "artifact_game_contract_draft",
    "artifact_art_bible_baseline_draft",
    "artifact_art_direction_board",
    "artifact_stage_1_design_quality_review",
    "artifact_stage_1_visual_quality_review"
  ];
  if (["concept_discussion", "concept_review"].includes(kernel.project.currentStage)) {
    const before = stageOneContractFingerprint(kernel, stageOneTaskIds, stageOneArtifactIds);
    ensureStageOneTasksAndArtifacts(kernel, now);
    reconcileReviewedTaskAgentState(kernel, stageOneTaskIds, now);
    const after = stageOneContractFingerprint(kernel, stageOneTaskIds, stageOneArtifactIds);
    return {
      changed: before !== after,
      taskIds: stageOneTaskIds,
      artifactIds: stageOneArtifactIds
    };
  }

  const stageTwoTaskIds = [
    "task_group_stage_2",
    "task_stage_2_asset_pipeline",
    "task_stage_2_visual_quality_review",
    "task_stage_2_cocos_build"
  ];
  const stageTwoArtifactIds = [
    "artifact_asset_manifest_draft",
    "artifact_asset_contact_sheet",
    "artifact_stage_2_visual_quality_review"
  ];
  if (
    ["production", "first_playable_review"].includes(kernel.project.currentStage) &&
    kernel.findTask("task_group_stage_2")
  ) {
    const before = stageOneContractFingerprint(kernel, stageTwoTaskIds, stageTwoArtifactIds);
    ensureStageTwoTasksAndArtifacts(kernel, { messageId: "runtime_quality_reconciliation" }, now);
    reconcileReviewedTaskAgentState(kernel, stageTwoTaskIds, now);
    const after = stageOneContractFingerprint(kernel, stageTwoTaskIds, stageTwoArtifactIds);
    return {
      changed: before !== after,
      taskIds: stageTwoTaskIds,
      artifactIds: stageTwoArtifactIds
    };
  }

  return { changed: false, taskIds: [], artifactIds: [] };
}

/**
 * Rekeys the one legacy artifact that already owns a canonical Stage 1 path.
 * This runs on the raw snapshot before StudioKernel restore so every persisted
 * reference changes atomically and path uniqueness never fails midway through
 * API startup. Only an unambiguous type/owner/task match is eligible.
 */
export function migrateLocalRuntimeSnapshot(
  snapshot: StudioKernelSnapshot,
  options: LocalRuntimeSnapshotMigrationOptions
): LocalRuntimeSnapshotMigrationResult {
  const migrations: Array<{ fromArtifactId: string; toArtifactId: string }> = [];
  let conflictSnapshot: StudioKernelSnapshot | undefined;
  let conflictChanged = false;
  for (const contract of getStageOneArtifactContracts()) {
    const canonicalArtifacts = snapshot.artifacts.filter(
      (artifact) => artifact.artifactId === contract.artifactId
    );
    const canonicalArtifact = canonicalArtifacts[0];
    if (canonicalArtifact) {
      const mismatches = snapshotStageOneArtifactIdentityMismatches(snapshot, contract, canonicalArtifact);
      if (canonicalArtifacts.length > 1) {
        mismatches.push(`artifactId=${contract.artifactId} is duplicated`);
      }
      if (mismatches.length > 0) {
        conflictSnapshot ??= structuredClone(snapshot);
        conflictChanged =
          blockSnapshotArtifactIdentityConflict(conflictSnapshot, contract, canonicalArtifact, mismatches) ||
          conflictChanged;
      }
      continue;
    }
    if (snapshot.artifactLedger.some((entry) => entry.artifactId === contract.artifactId)) {
      continue;
    }
    if (snapshot.artifactOperations.some((operation) => operation.artifactId === contract.artifactId)) {
      continue;
    }
    const sourceTask = snapshot.tasks.find((task) => task.taskId === contract.sourceTaskId);
    const pathOwners = snapshot.artifacts.filter((artifact) => artifact.path === contract.path);
    const candidate = pathOwners[0];
    const candidateLedger = candidate
      ? snapshot.artifactLedger.filter((entry) => entry.artifactId === candidate.artifactId)
      : [];
    if (
      sourceTask?.ownerAgentId !== contract.ownerAgentId ||
      pathOwners.length !== 1 ||
      !candidate ||
      candidate.projectId !== snapshot.project.projectId ||
      candidate.artifactId !== options.legacyArtifactIdFor(
        snapshot.project.projectId,
        contract.ownerAgentId,
        contract.path
      ) ||
      candidate.type !== contract.type ||
      candidate.ownerAgentId !== contract.ownerAgentId ||
      candidate.sourceTaskId !== contract.sourceTaskId ||
      candidateLedger.length > 1 ||
      (candidateLedger[0] !== undefined &&
        (candidateLedger[0].projectId !== snapshot.project.projectId ||
          candidateLedger[0].ownerAgentId !== contract.ownerAgentId ||
          candidateLedger[0].path !== contract.path ||
          candidateLedger[0].taskId !== contract.sourceTaskId)) ||
      hasUnsafeDerivedClaimReference(snapshot, candidate.artifactId)
    ) {
      continue;
    }
    const fromArtifactId = candidate.artifactId;
    migrations.push({ fromArtifactId, toArtifactId: contract.artifactId });
  }
  if (migrations.length === 0 && !conflictChanged) {
    return { snapshot, changed: false, artifactIdMigrations: [] };
  }
  const migratedSnapshot = conflictSnapshot ?? structuredClone(snapshot);
  for (const migration of migrations) {
    rekeySnapshotArtifact(migratedSnapshot, migration.fromArtifactId, migration.toArtifactId);
  }
  return { snapshot: migratedSnapshot, changed: true, artifactIdMigrations: migrations };
}

function snapshotStageOneArtifactIdentityMismatches(
  snapshot: StudioKernelSnapshot,
  contract: StageOneArtifactContract,
  actual: Artifact
): string[] {
  const mismatches = artifactIdentityMismatches(
    {
      artifactId: contract.artifactId,
      projectId: snapshot.project.projectId,
      type: contract.type,
      path: contract.path,
      ownerAgentId: contract.ownerAgentId,
      sourceTaskId: contract.sourceTaskId
    },
    actual
  );
  const sourceTask = snapshot.tasks.find((task) => task.taskId === contract.sourceTaskId);
  if (sourceTask?.ownerAgentId !== contract.ownerAgentId) {
    mismatches.push(
      `source task ${contract.sourceTaskId} owner=${sourceTask?.ownerAgentId ?? "missing"}, expected ${contract.ownerAgentId}`
    );
  }
  const ledgers = snapshot.artifactLedger.filter((entry) => entry.artifactId === actual.artifactId);
  if (ledgers.length > 1) {
    mismatches.push(`ledger for ${actual.artifactId} is duplicated`);
  }
  const ledger = ledgers[0];
  if (
    ledger &&
    (ledger.projectId !== snapshot.project.projectId ||
      ledger.ownerAgentId !== contract.ownerAgentId ||
      ledger.path !== contract.path ||
      ledger.taskId !== contract.sourceTaskId)
  ) {
    mismatches.push(
      `ledger identity is project=${ledger.projectId}, owner=${ledger.ownerAgentId}, path=${ledger.path}, task=${ledger.taskId ?? "missing"}`
    );
  }
  return mismatches;
}

function blockSnapshotArtifactIdentityConflict(
  snapshot: StudioKernelSnapshot,
  contract: StageOneArtifactContract,
  actual: Artifact,
  mismatches: string[]
): boolean {
  const task = snapshot.tasks.find((candidate) => candidate.taskId === contract.sourceTaskId);
  if (!task || task.status === "cancelled") {
    return false;
  }
  const blocker = stageOneArtifactIdentityBlocker(contract, actual, mismatches);
  const agentState = snapshot.agentLoop.agents[task.ownerAgentId];
  if (
    task.status === "blocked" &&
    task.blockers.includes(blocker) &&
    agentState?.status === "blocked" &&
    agentState.lastError === blocker
  ) {
    return false;
  }
  task.status = "blocked";
  task.blockers = [...new Set([...task.blockers, blocker])];
  task.updatedAt = snapshot.savedAt;
  snapshot.agentLoop.agents[task.ownerAgentId] = {
    ...(agentState ?? {
      agentId: task.ownerAgentId,
      status: "blocked",
      iteration: snapshot.agentLoop.iteration,
      updatedAt: snapshot.savedAt
    }),
    status: "blocked",
    taskId: task.taskId,
    lastError: blocker,
    updatedAt: snapshot.savedAt
  };
  return true;
}

function hasUnsafeDerivedClaimReference(snapshot: StudioKernelSnapshot, artifactId: string): boolean {
  if (
    snapshot.claimVerifications.some(
      (claim) => claim.relatedArtifactIds.includes(artifactId) && !claim.claimedPath
    )
  ) {
    return true;
  }
  return snapshot.messages.some((message) => {
    const claims = message.metadata.claimVerifications;
    return Array.isArray(claims) && claims.some((claim) => {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
        return false;
      }
      const record = claim as Record<string, unknown>;
      return (
        Array.isArray(record.relatedArtifactIds) &&
        record.relatedArtifactIds.includes(artifactId) &&
        typeof record.claimedPath !== "string"
      );
    });
  });
}

function bootstrapConceptDiscussion(kernel: StudioKernel, producerMessage: StudioMessage, now: string): void {
  ensureStageOneTasksAndArtifacts(kernel, now);
  writeProjectMemory(kernel, {
    memoryId: `mem_project_idea_${producerMessage.messageId}`,
    ownerAgent: "studio_orchestrator",
    type: "initial_idea",
    content: `制作人初始 idea：${producerMessage.content}`,
    now
  });
}

function handleOrchestrator({ kernel, producerMessage, now }: HandlerInput): void {
  if (isApprovalMessage(producerMessage.content) || isReleaseMessage(producerMessage.content)) {
    return;
  }

  if (isPresencePing(producerMessage.content)) {
    writePresenceResponse(kernel);
    return;
  }

  bootstrapConceptDiscussion(kernel, producerMessage, now);
  writeAgentMessage(kernel, {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "progress_update",
    relatedTaskIds: [
      "task_group_stage_1",
      "task_stage_1_design_clarification",
      "task_stage_1_art_direction",
      "task_stage_1_design_quality_review",
      "task_stage_1_visual_quality_review",
      "task_stage_1_scope_review"
    ],
    content:
      "已创建 Stage 1 立项任务树：策划负责玩法澄清和 GDD baseline，美术负责视觉方向和 Art Bible baseline，Producer 负责范围与评审记录。"
  });
}

function isPresencePing(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return /^(有人吗|有人在吗|在吗|在不在|hello|hi|hey|ping|有人么)[？?!.。！\s]*$/.test(normalized);
}

function writePresenceResponse(kernel: StudioKernel): void {
  writeAgentMessage(kernel, {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "progress_update",
    content:
      "我在。当前 Studio Orchestrator 在线，策划、美术、程序、QA 和发布运维角色会根据消息内容自动判断是否需要回复。你可以直接询问进度、提出修改意见，或点右侧项目启动按钮开始正式流程。"
  });
}

function applyProducerDecisionFlow(
  kernel: StudioKernel,
  message: StudioMessage,
  gate: GateAction,
  now: string,
  evidencePolicy: GateEvidencePolicy
): boolean {
  const hasReview = hasRecentGateReview(kernel, gate, message.messageId);
  if (isGateExecutionConfirmation(message.content, gate) || (hasReview && isNaturalLanguageGateConfirmation(message.content))) {
    executeGateAction(kernel, message, gate, now, evidencePolicy);
    return true;
  }

  writeGateReview(kernel, message, gate, now, evidencePolicy);
  return true;
}

function executeGateAction(
  kernel: StudioKernel,
  message: StudioMessage,
  gate: GateAction,
  now: string,
  evidencePolicy: GateEvidencePolicy
): void {
  const decisionIdempotencyKey = gateDecisionIdempotencyKey(kernel, gate, message);
  const isDecisionReplay = kernel.getWorkflowSnapshot().processedCommands.some(
    (command) => command.idempotencyKey === decisionIdempotencyKey
  );
  if (!isDecisionReplay && !isGateStageApplicable(kernel, gate)) {
    writeAgentMessage(kernel, {
      agentId: "studio_orchestrator",
      roomKind: "studio-main",
      messageType: "blocker",
      content: `无法执行「${gate.label}」：当前阶段是「${stageText(kernel.project.currentStage)}」，该门禁只适用于「${gate.expectedStages.map(stageText).join("、")}」。请先完成前置阶段。`
    });
    return;
  }

  if (!isDecisionReplay && !hasRecentGateReview(kernel, gate, message.messageId)) {
    writeAgentMessage(kernel, {
      agentId: "studio_orchestrator",
      roomKind: "studio-main",
      messageType: "decision_request",
      content: `无法直接执行「${gate.label}」。制作人决策必须先经过相关 Agent 门禁评审。请先发起「${gate.label}」评审，查看准备度、阻塞和风险后，再使用二次确认口令。`
    });
    return;
  }

  if (!isDecisionReplay && kernel.project.currentStage !== gate.reviewStage) {
    writeAgentMessage(kernel, {
      agentId: "studio_orchestrator",
      roomKind: "studio-main",
      messageType: "blocker",
      content: `无法执行「${gate.label}」：Workflow Aggregate 尚未处于「${stageText(gate.reviewStage)}」。请先发起门禁评审。`
    });
    return;
  }

  switch (gate.actionId) {
    case "stage1":
      try {
        approveStageOne(kernel, message, now, evidencePolicy);
      } catch (error) {
        writeEvidenceBlocker(kernel, gate, error);
      }
      return;
    case "playable":
      try {
        approveFirstPlayable(kernel, message, now, evidencePolicy);
      } catch (error) {
        writeEvidenceBlocker(kernel, gate, error);
      }
      return;
    case "release":
      try {
        approveRelease(kernel, message, now, evidencePolicy);
      } catch (error) {
        writeEvidenceBlocker(kernel, gate, error);
      }
      return;
  }
}

function writeGateReview(
  kernel: StudioKernel,
  message: StudioMessage,
  gate: GateAction,
  now: string,
  evidencePolicy: GateEvidencePolicy
): void {
  if (!isGateStageApplicable(kernel, gate)) {
    const reviewLines = buildGateReviewLines(kernel, gate, false, now);
    for (const line of reviewLines) {
      writeAgentMessage(kernel, line);
    }
    return;
  }

  try {
    assertGateEvidence(evidencePolicy, kernel, gate, "review");
    submitWorkflowReview(kernel, message, gate, now);
  } catch (error) {
    writeEvidenceBlocker(kernel, gate, error);
    return;
  }

  const stageApplicable = isGateStageApplicable(kernel, gate);
  const reviewLines = buildGateReviewLines(kernel, gate, stageApplicable, now);
  for (const line of reviewLines) {
    writeAgentMessage(kernel, line);
  }

  writeProjectMemory(kernel, {
    memoryId: `mem_gate_review_${gate.actionId}_${message.messageId}`,
    ownerAgent: "studio_orchestrator",
    type: "gate_review",
    content: `制作人请求「${gate.label}」门禁评审。系统已记录相关 Agent 准备度、阻塞和风险；未执行阶段推进。`,
    now
  });
}

function submitWorkflowReview(kernel: StudioKernel, message: StudioMessage, gate: GateAction, now: string): void {
  const snapshot = kernel.getWorkflowSnapshot();
  const idempotencyKey = `gate:${kernel.project.projectId}:${gate.actionId}:review:${message.messageId}`;
  const wasProcessed = snapshot.processedCommands.some((command) => command.idempotencyKey === idempotencyKey);
  if (wasProcessed) {
    kernel.executeWorkflow({
      type: "submit_review",
      expectedRevision: snapshot.revision,
      idempotencyKey,
      actor: { actorId: "studio_orchestrator", role: "orchestrator" },
      occurredAt: now,
      label: gate.label,
      requiredArtifacts: gate.requiredArtifacts,
      checks: gate.checks
    });
    return;
  }

  if (snapshot.activeGateId) {
    const activeGate = snapshot.gates.find((candidate) => candidate.gateId === snapshot.activeGateId);
    if (activeGate?.reviewStage === gate.reviewStage) {
      return;
    }
    throw new Error(`另一个门禁「${activeGate?.label ?? snapshot.activeGateId}」正在等待制作人决策。`);
  }

  if (kernel.project.currentStage !== gate.sourceStage) {
    throw new Error(`「${gate.label}」只能从「${stageText(gate.sourceStage)}」提交评审。`);
  }

  kernel.executeWorkflow({
    type: "submit_review",
    expectedRevision: snapshot.revision,
    idempotencyKey,
    actor: { actorId: "studio_orchestrator", role: "orchestrator" },
    occurredAt: now,
    label: gate.label,
    requiredArtifacts: gate.requiredArtifacts,
    checks: gate.checks
  });
}

function buildGateReviewLines(kernel: StudioKernel, gate: GateAction, stageApplicable: boolean, now: string): GateReviewLine[] {
  switch (gate.actionId) {
    case "stage1":
      ensureStageOneTasksAndArtifacts(kernel, now);
      return buildStageOneReview(kernel, gate, stageApplicable);
    case "playable":
      return buildPlayableReview(kernel, gate, stageApplicable);
    case "release":
      return buildReleaseReview(kernel, gate, stageApplicable);
  }
}

function buildStageOneReview(kernel: StudioKernel, gate: GateAction, stageApplicable: boolean): GateReviewLine[] {
  const designTask = kernel.findTask("task_stage_1_design_clarification");
  const artTask = kernel.findTask("task_stage_1_art_direction");
  const designReviewTask = kernel.findTask("task_stage_1_design_quality_review");
  const visualReviewTask = kernel.findTask("task_stage_1_visual_quality_review");
  const scopeTask = kernel.findTask("task_stage_1_scope_review");
  const gdd = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gdd_baseline_draft");
  const gameContract = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_game_contract_draft");
  const artBible = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_art_bible_baseline_draft");
  const artBoard = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_art_direction_board");
  const designReview = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_stage_1_design_quality_review");
  const visualReview = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_stage_1_visual_quality_review");
  const blockers = [
    ...(designTask?.blockers ?? []),
    ...(artTask?.blockers ?? []),
    ...(designReviewTask?.blockers ?? []),
    ...(visualReviewTask?.blockers ?? []),
    ...(scopeTask?.blockers ?? [])
  ];
  const missing = [
    ...(gdd ? [] : ["GDD baseline 尚未生成"]),
    ...(gameContract ? [] : ["GameContract 尚未生成"]),
    ...(artBible ? [] : ["Art Bible baseline 尚未生成"]),
    ...(artBoard ? [] : ["真实视觉方向板尚未生成"]),
    ...(designReview ? [] : ["独立策划质量审查尚未生成"]),
    ...(visualReview ? [] : ["独立视觉质量审查尚未生成"])
  ];
  const risks = [
    ...blockers,
    ...missing,
    "强行推进会把未澄清的玩法边界和视觉风格带入开发，后续返工成本会上升。"
  ];

  return [
    {
      agentId: "design_quality_reviewer",
      roomKind: "design-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。独立策划质量结论：${readinessText(stageApplicable && Boolean(designReview) && !designReviewTask?.blockers.length)}。${taskStatusText(designReviewTask)} 收据：${designReview ? artifactStatusText(designReview) : "缺失"}。审查员未参与 GDD/GameContract 创作，制作人仍需确认产品取舍。`
    },
    {
      agentId: "visual_quality_reviewer",
      roomKind: "art-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。独立视觉质量结论：${readinessText(stageApplicable && Boolean(visualReview) && Boolean(artBoard) && !visualReviewTask?.blockers.length)}。${taskStatusText(visualReviewTask)} 收据：${visualReview ? artifactStatusText(visualReview) : "缺失"}；方向板：${artBoard ? artifactStatusText(artBoard) : "缺失"}。审查结论来自真实像素输入，不以 Art Bible 自述代替。`
    },
    {
      agentId: "producer",
      roomKind: "studio-main",
      messageType: "review",
      content: `门禁评审：${gate.label}。制作协调结论：${stageApplicable ? "允许制作人做风险确认，但当前不自动推进。" : "当前阶段不匹配，不能执行该门禁。"} 范围风险：${formatList(risks)}`
    },
    gateSummaryLine(kernel, gate, stageApplicable, risks)
  ];
}

function buildPlayableReview(kernel: StudioKernel, gate: GateAction, stageApplicable: boolean): GateReviewLine[] {
  const assetTask = kernel.findTask("task_stage_2_asset_pipeline");
  const visualReviewTask = kernel.findTask("task_stage_2_visual_quality_review");
  const codeTask = kernel.findTask("task_stage_2_cocos_implementation");
  const qaTask = kernel.findTask("task_stage_2_qa_playtest");
  const build = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_wechat_dev_build");
  const visualReview = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_stage_2_visual_quality_review");
  const qaReport = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_qa_playtest_report");
  const qaPassed = qaReport?.metadata.playtestVerdict === "pass" &&
    (qaReport.metadata.toolName === "run_playtest" || qaReport.metadata.harnessToolName === "run_playtest");
  const blockers = [
    ...(assetTask?.blockers ?? []),
    ...(visualReviewTask?.blockers ?? []),
    ...(codeTask?.blockers ?? []),
    ...(qaTask?.blockers ?? [])
  ];
  const missing = [
    ...(build ? [] : ["微信小游戏开发构建尚未生成"]),
    ...(visualReview ? [] : ["独立视觉资产质量审查尚未生成"]),
    ...(qaPassed ? [] : [qaReport ? "QA 报告存在，但真实试玩结论尚未通过" : "首个可玩 QA 试玩报告尚未生成"])
  ];
  const risks = [
    ...blockers,
    ...missing,
    "强行通过首个可玩会跳过可玩性、稳定性和核心循环验证。"
  ];

  return [
    {
      agentId: "visual_quality_reviewer",
      roomKind: "art-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。独立视觉资产质量结论：${readinessText(stageApplicable && Boolean(visualReview) && !visualReviewTask?.blockers.length)}。${taskStatusText(visualReviewTask)} 收据：${visualReview ? artifactStatusText(visualReview) : "缺失"}。该结论以实际 PNG 像素为输入，不能由 manifest 文件名替代。`
    },
    {
      agentId: "gameplay_programmer",
      roomKind: "engineering-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。程序准备度：${readinessText(stageApplicable && Boolean(build) && !codeTask?.blockers.length)}。${taskStatusText(codeTask)} 风险：${formatList([...(codeTask?.blockers ?? []), build ? "已有开发构建，但仍需确认核心循环手感。" : "缺少可运行开发构建。"])}`
    },
    {
      agentId: "cocos_automation",
      roomKind: "engineering-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。Cocos 自动化准备度：${readinessText(stageApplicable && Boolean(build))}。构建状态：${build ? artifactStatusText(build) : "未发现开发构建产物"}。`
    },
    {
      agentId: "qa_evaluator",
      roomKind: "qa-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。QA 准备度：${readinessText(stageApplicable && qaPassed && !qaTask?.blockers.length)}。${taskStatusText(qaTask)} 风险：${formatList([...(qaTask?.blockers ?? []), qaPassed ? "真实试玩已通过，仍需制作人审阅证据。" : "缺少通过结论、完整状态路径、截图或问题闭环。"])}`
    },
    gateSummaryLine(kernel, gate, stageApplicable, risks)
  ];
}

function buildReleaseReview(kernel: StudioKernel, gate: GateAction, stageApplicable: boolean): GateReviewLine[] {
  const releaseTask = kernel.findTask("task_stage_3_wechat_release");
  const qaTask = kernel.findTask("task_stage_3_qa_release_gate");
  const devopsTask = kernel.findTask("task_stage_3_devops_plan");
  const releaseBuild = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_wechat_release_build");
  const releaseGate = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_release_gate_report");
  const releaseQaPassed = releaseGate?.metadata.playtestVerdict === "pass" &&
    (releaseGate.metadata.toolName === "run_playtest" || releaseGate.metadata.harnessToolName === "run_playtest");
  const deploymentPlan = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_deployment_plan");
  const rollback = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_rollback_plan");
  const blockers = [...(releaseTask?.blockers ?? []), ...(qaTask?.blockers ?? []), ...(devopsTask?.blockers ?? [])];
  const missing = [
    ...(releaseBuild ? [] : ["微信 release 构建尚未生成"]),
    ...(releaseQaPassed ? [] : [releaseGate ? "发布门禁报告存在，但真实试玩结论尚未通过" : "发布门禁报告尚未生成"]),
    ...(deploymentPlan ? [] : ["部署计划尚未生成"]),
    ...(rollback ? [] : ["回滚方案尚未生成"])
  ];
  const risks = [
    ...blockers,
    ...missing,
    "强行发布会带来线上不可回滚、包体问题、平台审核失败或 QA 未覆盖风险。"
  ];

  return [
    {
      agentId: "wechat_platform",
      roomKind: "release-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。微信平台准备度：${readinessText(stageApplicable && Boolean(releaseBuild) && !releaseTask?.blockers.length)}。${taskStatusText(releaseTask)} 构建状态：${releaseBuild ? artifactStatusText(releaseBuild) : "未发现 release 构建"}。`
    },
    {
      agentId: "qa_evaluator",
      roomKind: "qa-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。发布 QA 准备度：${readinessText(stageApplicable && releaseQaPassed && !qaTask?.blockers.length)}。${taskStatusText(qaTask)} 门禁报告：${releaseGate ? artifactStatusText(releaseGate) : "未生成"}；真实试玩：${releaseQaPassed ? "pass" : "未通过"}。`
    },
    {
      agentId: "devops",
      roomKind: "release-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。运维准备度：${readinessText(stageApplicable && Boolean(deploymentPlan) && Boolean(rollback) && !devopsTask?.blockers.length)}。${taskStatusText(devopsTask)} 风险：${formatList([...(devopsTask?.blockers ?? []), deploymentPlan && rollback ? "部署计划和回滚方案已准备，仍需确认凭据只使用 Secret Vault 引用。" : "缺少部署计划或回滚方案。"])}`
    },
    {
      agentId: "liveops_analytics",
      roomKind: "studio-main",
      messageType: "review",
      content: `门禁评审：${gate.label}。LiveOps 尚未启动；只有审批后的真实部署报告通过验证并完成生产健康检查，Workflow 才能进入持续运营。上线后需观察留存、失败率、局内流失点和后续迭代优先级。`
    },
    gateSummaryLine(kernel, gate, stageApplicable, risks)
  ];
}

function gateSummaryLine(kernel: StudioKernel, gate: GateAction, stageApplicable: boolean, risks: string[]): GateReviewLine {
  const stageMessage = stageApplicable
    ? `如制作人已阅读以上风险并仍要求推进，请发送二次确认口令：${gate.confirmToken}`
    : `当前阶段是「${stageText(kernel.project.currentStage)}」，该门禁只适用于「${gate.expectedStages.map(stageText).join("、")}」，因此不会提供执行口令。`;
  return {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "decision_request",
    content: `门禁评审汇总：${gate.label}。系统未执行阶段推进。主要风险：${formatList(risks)} ${stageMessage}`
  };
}

function detectGateAction(content: string): GateAction | undefined {
  const normalized = content.toLowerCase();
  if (isReleaseMessage(normalized) || normalized.includes(gateActions.release.confirmToken.toLowerCase())) {
    return gateActions.release;
  }
  if (isPlayableApprovalMessage(normalized) || normalized.includes(gateActions.playable.confirmToken.toLowerCase())) {
    return gateActions.playable;
  }
  if (isApprovalMessage(normalized) || normalized.includes(gateActions.stage1.confirmToken.toLowerCase())) {
    return gateActions.stage1;
  }
  return undefined;
}

function resolveGateAction(kernel: StudioKernel, content: string): GateAction | undefined {
  const explicit = detectGateAction(content);
  if (explicit) {
    return explicit;
  }

  const pending = Object.values(gateActions).filter(
    (gate) => isGateStageApplicable(kernel, gate) && hasRecentGateReview(kernel, gate)
  );
  if (pending.length === 1 && isNaturalLanguageGateConfirmation(content)) {
    return pending[0];
  }

  if (!isGenericGateIntent(content)) {
    return undefined;
  }
  return Object.values(gateActions).find((gate) => isGateStageApplicable(kernel, gate));
}

function isGateExecutionConfirmation(content: string, gate: GateAction): boolean {
  const normalized = content.toLowerCase();
  return normalized.includes(gate.confirmToken.toLowerCase()) || (normalized.includes("执行确认") && normalized.includes(gate.label.toLowerCase()));
}

function isNaturalLanguageGateConfirmation(content: string): boolean {
  const normalized = content.toLowerCase().replace(/[，。！？!?\s]/g, "");
  if (["确认", "同意", "继续", "通过", "审批通过", "确认通过"].includes(normalized)) {
    return true;
  }
  return (
    (normalized.includes("确认") || normalized.includes("同意") || normalized.includes("继续") || normalized.includes("通过")) &&
    (normalized.includes("结束") || normalized.includes("下一阶段") || normalized.includes("推进") || normalized.includes("进入开发") || normalized.includes("进入发布"))
  );
}

function isGenericGateIntent(content: string): boolean {
  const normalized = content.toLowerCase();
  return (
    isNaturalLanguageGateConfirmation(content) ||
    ((normalized.includes("门禁") || normalized.includes("评审")) &&
      (normalized.includes("发起") || normalized.includes("开始") || normalized.includes("请求") || normalized.includes("进入")))
  );
}

function isGateStageApplicable(kernel: StudioKernel, gate: GateAction): boolean {
  return gate.expectedStages.includes(kernel.project.currentStage);
}

function hasRecentGateReview(kernel: StudioKernel, gate: GateAction, currentMessageId?: string): boolean {
  const messages = kernel.listMessages();
  const reviewNeedle = `二次确认口令：${gate.confirmToken}`;
  let latestReview = -1;
  let latestReviewRequest = -1;
  let latestExecution = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }

    const requestedGate = detectGateAction(message.content);
    if (
      message.messageId !== currentMessageId &&
      message.senderType === "producer" &&
      requestedGate?.actionId === gate.actionId &&
      !isGateExecutionConfirmation(message.content, gate)
    ) {
      latestReviewRequest = index;
    }

    if (
      message.senderType === "agent" &&
      (message.content.includes(reviewNeedle) || (message.messageType === "review" && latestReviewRequest !== -1 && index > latestReviewRequest))
    ) {
      latestReview = index;
    }
    if (message.messageId !== currentMessageId && message.senderType === "producer" && isGateExecutionConfirmation(message.content, gate)) {
      latestExecution = index;
    }
  }

  return latestReview !== -1 && latestReview > latestExecution;
}

function approveStageOne(
  kernel: StudioKernel,
  message: StudioMessage,
  now: string,
  evidencePolicy: GateEvidencePolicy
): void {
  ensureStageOneTasksAndArtifacts(kernel, now);
  assertGateEvidence(evidencePolicy, kernel, gateActions.stage1, "decision");
  approveActiveWorkflowGate(kernel, gateActions.stage1, message, now);
  for (const taskId of [
    "task_stage_1_design_clarification",
    "task_stage_1_art_direction",
    "task_stage_1_design_quality_review",
    "task_stage_1_visual_quality_review",
    "task_stage_1_scope_review"
  ]) {
    kernel.updateTaskStatus(taskId, "done", now);
  }
  kernel.updateTaskStatus("task_group_stage_1", "done", now);

  ensureArtifactStatus(kernel, "artifact_gdd_baseline_draft", "approved", now);
  ensureArtifactStatus(kernel, "artifact_game_contract_draft", "approved", now);
  ensureArtifactStatus(kernel, "artifact_art_bible_baseline_draft", "approved", now);
  ensureArtifactStatus(kernel, "artifact_art_direction_board", "approved", now);
  ensureArtifactStatus(kernel, "artifact_stage_1_design_quality_review", "approved", now);
  ensureArtifactStatus(kernel, "artifact_stage_1_visual_quality_review", "approved", now);
  ensureStageTwoTasksAndArtifacts(kernel, message, now);
  writeProjectMemory(kernel, {
    memoryId: `mem_stage_1_approved_${message.messageId}`,
    ownerAgent: "producer",
    type: "stage_1_approval",
    content: "制作人已确认 Stage 1：核心玩法、美术方向和第一可玩范围进入开发落地。",
    now
  });
  writeAgentMessage(kernel, {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "progress_update",
    content: "Stage 1 已审批，项目进入 Stage 2 开发落地。已创建美术资产、Cocos 技术、玩法代码和 QA 首轮任务。"
  });
}

function isApprovalMessage(content: string): boolean {
  return (
    ((content.includes("确认") || content.includes("同意") || content.includes("审批") || content.includes("通过")) &&
      (content.includes("玩法") || content.includes("美术") || content.includes("范围") || content.includes("stage 1") || content.includes("立项"))) ||
    ((content.includes("门禁") || content.includes("评审")) &&
      (content.includes("立项") || content.includes("本阶段") || content.includes("当前阶段") || content.includes("讨论"))) ||
    ((content.includes("结束") || content.includes("下一阶段") || content.includes("开发落地")) &&
      (content.includes("确认") || content.includes("同意") || content.includes("开始") || content.includes("进入") || content.includes("推进")))
  );
}

function isPlayableApprovalMessage(content: string): boolean {
  return (
    (content.includes("首个可玩") || content.includes("可玩版本") || content.includes("first playable")) &&
    (content.includes("确认") || content.includes("同意") || content.includes("通过") || content.includes("接受"))
  );
}

function isReleaseMessage(content: string): boolean {
  return (
    (content.includes("发布") || content.includes("上线") || content.includes("release")) &&
    (content.includes("确认") || content.includes("同意") || content.includes("批准") || content.includes("通过"))
  );
}

function readinessText(isReady: boolean): string {
  return isReady ? "基本就绪" : "未准备好";
}

function taskStatusText(task: Task | undefined): string {
  if (!task) {
    return "任务状态：未创建。";
  }

  return `任务状态：${task.status}，进度 ${task.progressPercent ?? 0}%。`;
}

function artifactStatusText(artifact: Artifact): string {
  return `${artifact.type} / ${artifact.status}`;
}

function stageText(stageId: StageId): string {
  switch (stageId) {
    case "concept_discussion":
      return "立项讨论";
    case "concept_review":
      return "立项评审";
    case "production":
      return "开发落地";
    case "first_playable_review":
      return "首个可玩评审";
    case "release_preparation":
      return "发布准备";
    case "release_gate":
      return "发布门禁";
    case "production_deploy":
      return "生产部署";
    case "liveops":
      return "持续运营";
    default:
      return stageId;
  }
}

function formatList(items: string[]): string {
  const filtered = [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  if (filtered.length === 0) {
    return "暂无明确阻塞。";
  }

  return filtered.join("；");
}

function approveFirstPlayable(
  kernel: StudioKernel,
  message: StudioMessage,
  now: string,
  evidencePolicy: GateEvidencePolicy
): void {
  assertGateEvidence(evidencePolicy, kernel, gateActions.playable, "decision");
  approveActiveWorkflowGate(kernel, gateActions.playable, message, now);
  for (const taskId of [
    "task_stage_2_asset_pipeline",
    "task_stage_2_visual_quality_review",
    "task_stage_2_cocos_architecture",
    "task_stage_2_cocos_implementation",
    "task_stage_2_playtest_contract",
    "task_stage_2_cocos_build",
    "task_stage_2_qa_playtest",
    "task_group_stage_2"
  ]) {
    if (kernel.findTask(taskId)) {
      kernel.updateTaskStatus(taskId, "done", now);
    }
  }
  ensureArtifactStatus(kernel, "artifact_asset_contact_sheet", "approved", now);
  ensureArtifactStatus(kernel, "artifact_stage_2_visual_quality_review", "approved", now);

  ensureReleaseTasksAndArtifacts(kernel, message, now);
  writeProjectMemory(kernel, {
    memoryId: `mem_first_playable_approved_${message.messageId}`,
    ownerAgent: "producer",
    type: "first_playable_approval",
    content: "制作人已接受首个可玩版本，项目进入微信小游戏发布准备。",
    now
  });
  writeAgentMessage(kernel, {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "progress_update",
    content: "首个可玩版本已通过，项目进入发布准备。已创建微信包体检查、发布门禁、部署计划和 LiveOps backlog 任务。"
  });
}

function approveRelease(
  kernel: StudioKernel,
  message: StudioMessage,
  now: string,
  evidencePolicy: GateEvidencePolicy
): void {
  assertGateEvidence(evidencePolicy, kernel, gateActions.release, "decision");
  approveActiveWorkflowGate(kernel, gateActions.release, message, now);
  for (const taskId of ["task_stage_3_wechat_release", "task_stage_3_qa_release_gate", "task_stage_3_devops_plan"]) {
    if (kernel.findTask(taskId)) {
      kernel.updateTaskStatus(taskId, "done", now);
    }
  }
  if (kernel.findTask("task_stage_3_devops_deploy")) {
    kernel.updateTaskStatus("task_stage_3_devops_deploy", "doing", now);
  }
  if (kernel.findTask("task_stage_3_liveops_backlog")) {
    kernel.updateTaskStatus("task_stage_3_liveops_backlog", "todo", now);
  }
  if (kernel.findTask("task_group_stage_3")) {
    kernel.updateTaskStatus("task_group_stage_3", "doing", now);
  }

  writeProjectMemory(kernel, {
    memoryId: `mem_release_approved_${message.messageId}`,
    ownerAgent: "producer",
    type: "release_approval",
    content: "制作人已批准发布，项目进入生产部署；部署健康检查完成后才可进入 LiveOps。",
    now
  });
  writeAgentMessage(kernel, {
    agentId: "devops",
    roomKind: "release-room",
    messageType: "deployment_record",
    relatedArtifactIds: ["artifact_deployment_plan", "artifact_rollback_plan", "artifact_deployment_report"],
    content: "发布审批已记录，Workflow 已进入生产部署。deployment_report 尚未生成；只有 DevOps 执行真实部署并通过健康检查后，才能写入已验证部署记录并请求进入 LiveOps。"
  });
}

function gateDecisionIdempotencyKey(kernel: StudioKernel, gate: GateAction, message: StudioMessage): string {
  return `gate:${kernel.project.projectId}:${gate.actionId}:decision:${message.messageId}`;
}

function approveActiveWorkflowGate(
  kernel: StudioKernel,
  gate: GateAction,
  message: StudioMessage,
  now: string
): void {
  const snapshot = kernel.getWorkflowSnapshot();
  const activeGate = snapshot.activeGateId
    ? snapshot.gates.find((candidate) => candidate.gateId === snapshot.activeGateId)
    : [...snapshot.gates].reverse().find((candidate) => candidate.reviewStage === gate.reviewStage);
  if (!activeGate) {
    throw new Error(`Workflow Aggregate 中不存在「${gate.label}」的评审门禁。`);
  }

  kernel.executeWorkflow({
    type: "record_gate_decision",
    expectedRevision: snapshot.revision,
    idempotencyKey: gateDecisionIdempotencyKey(kernel, gate, message),
    actor: { actorId: message.senderId, role: "producer" },
    occurredAt: now,
    gateId: activeGate.gateId,
    verdict: "approved",
    notes: `制作人通过二次确认批准「${gate.label}」。`
  });
}

function handleProducer({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "producer",
    roomKind: "studio-main",
    messageType: "decision_request",
    content: "Producer 记录到初始范围待确认：请在玩法方向、目标玩家、单局时长和美术参考上做第一次制作人确认。"
  });
}

function handleGameDesigner({ kernel, producerMessage, now, ideaTemplates }: HandlerInput): void {
  const artifactId = "artifact_gdd_baseline_draft";
  const gameContractArtifactId = "artifact_game_contract_draft";
  ensureArtifact(kernel, {
    artifactId,
    projectId: kernel.project.projectId,
    type: "gdd",
    path: "agents/design/gdd/00_overview.md",
    ownerAgentId: "game_designer",
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_1_design_clarification",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      sourceIdea: producerMessage.content
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: gameContractArtifactId,
    projectId: kernel.project.projectId,
    type: "game_contract",
    path: "agents/design/contracts/game-contract.json",
    ownerAgentId: "game_designer",
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_1_design_clarification",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      sourceIdea: producerMessage.content,
      schemaVersion: 1
    },
    createdAt: now,
    updatedAt: now
  });
  writeProjectMemory(kernel, {
    memoryId: `mem_design_draft_${producerMessage.messageId}`,
    ownerAgent: "game_designer",
    type: "gdd_draft",
    content: "策划已进入开局澄清，当前阶段保持开放，只有制作人发起门禁评审并二次确认后才会结束。",
    now
  });
  writeAgentMessage(kernel, {
    agentId: "game_designer",
    roomKind: "design-room",
    messageType: "decision_request",
    relatedArtifactIds: [artifactId, gameContractArtifactId],
    content: buildDesignOpeningQuestion(producerMessage.content, ideaTemplates)
  });
}

function handleArtDirector({ kernel, producerMessage, now, ideaTemplates }: HandlerInput): void {
  const artifactId = "artifact_art_bible_baseline_draft";
  ensureArtifact(kernel, {
    artifactId,
    projectId: kernel.project.projectId,
    type: "art_bible",
    path: "agents/art/art-bible.md",
    ownerAgentId: "art_director",
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_1_art_direction",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      sourceIdea: producerMessage.content
    },
    createdAt: now,
    updatedAt: now
  });
  writeProjectMemory(kernel, {
    memoryId: `mem_art_draft_${producerMessage.messageId}`,
    ownerAgent: "art_director",
    type: "art_bible_draft",
    content: "美术已进入视觉澄清，当前阶段保持开放，只有制作人发起门禁评审并二次确认后才会结束。",
    now
  });
  writeAgentMessage(kernel, {
    agentId: "art_director",
    roomKind: "art-room",
    messageType: "decision_request",
    relatedArtifactIds: [artifactId],
    content: buildArtOpeningQuestion(producerMessage.content, ideaTemplates)
  });
}

function buildDesignOpeningQuestion(idea: string, ideaTemplates: IdeaTemplateRegistry): string {
  const questions = ideaTemplates.select(idea).designPrompts;

  return [
    "策划已接收 idea，我不会把立项讨论自动结束。",
    "我先围绕这个 idea 提出当前最需要制作人判断的设计问题：",
    ...questions.slice(0, 4).map((question, index) => `${index + 1}. ${question}`),
    "你可以继续补充任何细节；只有你明确发起门禁评审并二次确认后，本阶段才会进入开发落地。"
  ].join("\n");
}

function buildArtOpeningQuestion(idea: string, ideaTemplates: IdeaTemplateRegistry): string {
  const prompts = ideaTemplates.select(idea).artPrompts;

  return [
    "美术已接收 idea，我不会把视觉讨论自动结束。",
    "我先按当前 idea 提出视觉方向澄清：",
    ...prompts.slice(0, 4).map((prompt, index) => `${index + 1}. ${prompt}`),
    "你可以继续补充参考和禁用项；只有你明确发起门禁评审并二次确认后，本阶段才会进入开发落地。"
  ].join("\n");
}

function handleAssetProduction({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "asset_production",
    roomKind: "art-room",
    messageType: "progress_update",
    content: "资产生产等待 Art Bible baseline 和 asset specs，当前不生成最终运行时资产。"
  });
}

function handleDesignQualityReviewer({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "design_quality_reviewer",
    roomKind: "design-room",
    messageType: "progress_update",
    content: "独立策划审查等待当前 GDD 与 GameContract 的真实文件证据；审查员不会修改作者产物，也不会替制作人批准门禁。"
  });
}

function handleVisualQualityReviewer({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "visual_quality_reviewer",
    roomKind: "art-room",
    messageType: "progress_update",
    content: "独立视觉审查等待 Art Bible 与真实像素证据；没有读取实际 PNG 的多模态工具结果时，不会给出通过结论。"
  });
}

function handleCocosTechLead({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "cocos_tech_lead",
    roomKind: "engineering-room",
    messageType: "progress_update",
    content: "Cocos 技术方案等待 GDD baseline 和 Art Bible baseline，当前准备 SceneBlueprint 和微信小游戏工程约束。"
  });
}

function handleGameplayProgrammer({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "gameplay_programmer",
    roomKind: "engineering-room",
    messageType: "progress_update",
    content: "玩法代码实现等待核心循环审批，当前不写入 Cocos 工程代码。"
  });
}

function handleCocosAutomation({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "cocos_automation",
    roomKind: "engineering-room",
    messageType: "progress_update",
    content: "Cocos 自动化等待 asset manifest 和 SceneBlueprint，当前不修改 .scene 或 .prefab。"
  });
}

function handleQaEvaluator({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "qa_evaluator",
    roomKind: "qa-room",
    messageType: "progress_update",
    content: "QA 已准备 Cocos MiniGame Bench，等待首个可玩构建后执行试玩、截图、录屏和发布门禁。"
  });
}

function handleWeChatPlatform({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "wechat_platform",
    roomKind: "release-room",
    messageType: "progress_update",
    content: "微信平台检查等待 Cocos wechatgame 构建产物，当前记录包体、资源加载和预览准备约束。"
  });
}

function handleDevOps({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "devops",
    roomKind: "release-room",
    messageType: "progress_update",
    content: "DevOps 等待发布审批和 Secret Vault 凭据引用，当前不会读取或展示明文服务器密码。"
  });
}

function handleLiveOps({ kernel }: HandlerInput): void {
  writeAgentMessage(kernel, {
    agentId: "liveops_analytics",
    roomKind: "studio-main",
    messageType: "progress_update",
    content: "LiveOps 已准备上线后事件结构，等待发布构建后生成埋点方案和迭代 backlog。"
  });
}

function ensureStageOneTasksAndArtifacts(kernel: StudioKernel, now: string): void {
  const projectId = kernel.project.projectId;
  const stageId: StageId = "concept_discussion";
  const groupId = "task_group_stage_1";
  const designTaskId = "task_stage_1_design_clarification";
  const artTaskId = "task_stage_1_art_direction";
  const designReviewTaskId = "task_stage_1_design_quality_review";
  const visualReviewTaskId = "task_stage_1_visual_quality_review";
  const producerTaskId = "task_stage_1_scope_review";

  ensureTask(kernel, {
    taskId: groupId,
    projectId,
    stageId,
    taskLevel: "task_group",
    ownerAgentId: "studio_orchestrator",
    title: "阶段 1：立项、机制和世界观讨论",
    description: "把制作人 idea 澄清成可执行 GDD baseline、版本化 GameContract、Art Bible、真实视觉方向板，并通过独立专业审查后确定第一可玩范围。",
    status: "doing",
    priority: 100,
    sortOrder: 10,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [],
    outputArtifacts: [
      "artifact_gdd_baseline_draft",
      "artifact_game_contract_draft",
      "artifact_art_bible_baseline_draft",
      "artifact_art_direction_board",
      "artifact_stage_1_design_quality_review",
      "artifact_stage_1_visual_quality_review"
    ],
    acceptanceCriteria: [
      "核心玩法与 GameContract 一致",
      "独立策划质量审查通过",
      "Art Bible 与真实视觉方向板一致",
      "独立视觉质量审查通过",
      "第一可玩范围已确认"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: designTaskId,
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("design-room").roomId,
    taskLevel: "task",
    ownerAgentId: "game_designer",
    title: "澄清玩法并生成 GDD 与 GameContract baseline",
    description: "确认核心循环、状态模型、输入动作、运行时信号、胜负条件、机制边界和第一可玩范围。",
    status: "doing",
    priority: 90,
    sortOrder: 20,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [],
    outputArtifacts: ["artifact_gdd_baseline_draft", "artifact_game_contract_draft"],
    acceptanceCriteria: ["GDD baseline 已提交", "GameContract 通过严格结构校验", "GDD 与 GameContract 语义一致", "已提交独立策划质量审查"],
    blockers: ["等待制作人回答开局澄清问题"],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: artTaskId,
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    ownerAgentId: "art_director",
    title: "澄清视觉方向并生成 Art Bible baseline",
    description: "确认视觉风格、色板、UI 可读性、资产规格方向和禁用风格，并通过真实图片模型生成一张可审查的视觉方向板。",
    status: "doing",
    priority: 80,
    sortOrder: 30,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [],
    outputArtifacts: ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"],
    acceptanceCriteria: ["Art Bible baseline 已提交", "真实 PNG 视觉方向板已生成", "方向板与 Art Bible 色板和风格约束一致", "已提交独立视觉质量审查"],
    blockers: ["等待制作人提供视觉参考或风格选择"],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: designReviewTaskId,
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("design-room").roomId,
    taskLevel: "task",
    ownerAgentId: "design_quality_reviewer",
    title: "独立审查 GDD 与 GameContract 质量",
    description: "以资深移动游戏设计总监视角审查核心循环、反馈张力、边界条件、数值依据、MVP 范围、平台可行性、跨文档一致性和可测试性；不得修改被审产物。",
    status: "todo",
    priority: 88,
    sortOrder: 35,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_game_contract_draft"],
    outputArtifacts: ["artifact_stage_1_design_quality_review"],
    acceptanceCriteria: [
      "严格质量审查收据绑定当前 GDD/GameContract 版本与哈希",
      "每项评分均引用 Markdown 行号或 JSON Pointer",
      "通过结论达到 rubric 阈值且不存在 critical/major 问题",
      "审查员未修改作者产物"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: visualReviewTaskId,
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    ownerAgentId: "visual_quality_reviewer",
    title: "独立审查 Art Bible 与视觉方向板",
    description: "以 Principal 2D Art Director 与移动技术美术视角读取实际 PNG 像素，审查风格、轮廓、小屏可读性、对比层级、技术约束和 IP 风险；不得修改或生成被审资产。",
    status: "todo",
    priority: 87,
    sortOrder: 36,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"],
    outputArtifacts: ["artifact_stage_1_visual_quality_review"],
    acceptanceCriteria: [
      "inspect_visual_assets 已读取真实 PNG 字节",
      "严格质量审查收据绑定当前 Art Bible/方向板版本与哈希",
      "通过结论达到 rubric 阈值且不存在 critical/major 问题",
      "审查员未修改或生成被审资产"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: producerTaskId,
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("studio-main").roomId,
    taskLevel: "task",
    ownerAgentId: "producer",
    title: "确认第一可玩范围和阶段门禁",
    description: "在两份独立专业审查均为当前且通过后，组织制作人确认核心玩法、美术方向和第一可玩范围。",
    status: "todo",
    priority: 85,
    sortOrder: 40,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [
      "artifact_gdd_baseline_draft",
      "artifact_game_contract_draft",
      "artifact_art_bible_baseline_draft",
      "artifact_art_direction_board",
      "artifact_stage_1_design_quality_review",
      "artifact_stage_1_visual_quality_review"
    ],
    outputArtifacts: [],
    acceptanceCriteria: ["制作人完成 Stage 1 审批或提交变更请求"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });

  ensureTaskArtifactReferences(
    kernel,
    designTaskId,
    "outputArtifacts",
    ["artifact_gdd_baseline_draft", "artifact_game_contract_draft"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    groupId,
    "outputArtifacts",
    [
      "artifact_gdd_baseline_draft",
      "artifact_game_contract_draft",
      "artifact_art_bible_baseline_draft",
      "artifact_art_direction_board",
      "artifact_stage_1_design_quality_review",
      "artifact_stage_1_visual_quality_review"
    ],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    artTaskId,
    "outputArtifacts",
    ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    designReviewTaskId,
    "inputArtifacts",
    ["artifact_gdd_baseline_draft", "artifact_game_contract_draft"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    designReviewTaskId,
    "outputArtifacts",
    ["artifact_stage_1_design_quality_review"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    visualReviewTaskId,
    "inputArtifacts",
    ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    visualReviewTaskId,
    "outputArtifacts",
    ["artifact_stage_1_visual_quality_review"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    producerTaskId,
    "inputArtifacts",
    [
      "artifact_gdd_baseline_draft",
      "artifact_game_contract_draft",
      "artifact_art_bible_baseline_draft",
      "artifact_art_direction_board",
      "artifact_stage_1_design_quality_review",
      "artifact_stage_1_visual_quality_review"
    ],
    now
  );

  const sourceIdea = kernel.project.initialIdea ?? "";
  for (const artifact of getStageOneArtifactContracts()) {
    ensureDeclaredArtifact(kernel, {
      ...artifact,
      projectId,
      stageId,
      status: "draft",
      version: 1,
      sourceDecisionIds: [],
      metadata: {
        generatedBy: "local_agent_runtime",
        artifactContract: "stage1.v1",
        ...(artifact.type === "game_contract" ? { schemaVersion: 1 } : {}),
        ...(sourceIdea ? { sourceIdea } : {})
      },
      createdAt: now,
      updatedAt: now
    });
  }

  for (const artifact of getQualityReviewArtifactContracts().filter((candidate) => candidate.sourceTaskId.startsWith("task_stage_1_"))) {
    ensureDeclaredArtifact(kernel, {
      artifactId: artifact.artifactId,
      projectId,
      type: artifact.type,
      path: artifact.path,
      ownerAgentId: artifact.ownerAgentId,
      stageId,
      status: "draft",
      version: 1,
      sourceTaskId: artifact.sourceTaskId,
      sourceDecisionIds: [],
      metadata: {
        generatedBy: "local_agent_runtime",
        artifactContract: "quality-review.v1",
        qualityReviewDomain: artifact.domain,
        subjectArtifactIds: [...artifact.subjectArtifactIds]
      },
      createdAt: now,
      updatedAt: now
    });
  }

  reopenStageOneTaskForMissingEvidence(
    kernel,
    designTaskId,
    ["artifact_gdd_baseline_draft", "artifact_game_contract_draft"],
    now
  );
  reopenStageOneTaskForMissingEvidence(
    kernel,
    artTaskId,
    ["artifact_art_bible_baseline_draft", "artifact_art_direction_board"],
    now
  );
  reopenStageOneTaskForMissingEvidence(
    kernel,
    designReviewTaskId,
    ["artifact_stage_1_design_quality_review"],
    now
  );
  reopenStageOneTaskForMissingEvidence(
    kernel,
    visualReviewTaskId,
    ["artifact_stage_1_visual_quality_review"],
    now
  );
}

function ensureStageTwoTasksAndArtifacts(
  kernel: StudioKernel,
  message: Pick<StudioMessage, "messageId">,
  now: string
): void {
  const projectId = kernel.project.projectId;
  const stageId: StageId = "production";
  const groupId = "task_group_stage_2";

  ensureTask(kernel, {
    taskId: groupId,
    projectId,
    stageId,
    taskLevel: "task_group",
    ownerAgentId: "studio_orchestrator",
    title: "阶段 2：开发落地和可玩版本实现",
    description: "完成美术资产、Cocos 工程、核心玩法代码和首轮 QA。",
    status: "doing",
    priority: 100,
    sortOrder: 100,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_game_contract_draft", "artifact_art_bible_baseline_draft"],
    outputArtifacts: [
      "artifact_asset_manifest_draft",
      "artifact_asset_contact_sheet",
      "artifact_stage_2_visual_quality_review",
      "artifact_scene_blueprint_draft",
      "artifact_playtest_contract_draft",
      "artifact_gameplay_source",
      "artifact_wechat_dev_build",
      "artifact_qa_playtest_report"
    ],
    acceptanceCriteria: ["核心循环可玩", "真实美术资产及联系表已生成", "独立视觉质量审查通过", "资产已导入", "QA 试玩报告已生成"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_asset_pipeline",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    ownerAgentId: "asset_production",
    title: "生产并打包第一可玩美术资产",
    description: "根据 Art Bible 通过真实图片生成模型生产第一可玩 PNG，保留模型与提示词证据，生成资产联系表并维护 asset manifest v2；逐项声明 alphaPolicy 并通过像素级透明通道硬校验。",
    status: "doing",
    priority: 90,
    sortOrder: 110,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_art_bible_baseline_draft"],
    outputArtifacts: ["artifact_asset_manifest_draft", "artifact_asset_contact_sheet"],
    acceptanceCriteria: [
      "至少一个真实 PNG 资产由 generate_raster_asset 物化并登记",
      "asset manifest 使用 schemaVersion=2.0.0，且每个 runtimePath 指向逐一验证的 PNG 并显式声明 alphaPolicy",
      "资产联系表覆盖第一可玩关键资产",
      "生成 provider/model/request/prompt hash/seed/尺寸证据完整",
      "每个 runtime PNG 都通过与 alphaPolicy 一致的确定性透明通道硬校验"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_visual_quality_review",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("art-room").roomId,
    taskLevel: "task",
    ownerAgentId: "visual_quality_reviewer",
    title: "独立审查第一可玩美术资产",
    description: "读取 Art Bible、asset manifest 和真实资产联系表像素，审查风格一致性、轮廓、小屏可读性、透明边缘、UI 层级、性能预算和 IP/安全风险。",
    status: "todo",
    priority: 89,
    sortOrder: 112,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_art_bible_baseline_draft", "artifact_asset_manifest_draft", "artifact_asset_contact_sheet"],
    outputArtifacts: ["artifact_stage_2_visual_quality_review"],
    acceptanceCriteria: [
      "inspect_visual_assets 已读取真实联系表 PNG",
      "严格质量收据绑定当前 Art Bible、manifest 与联系表哈希",
      "通过结论达到 rubric 阈值且不存在 critical/major 问题",
      "审查员未修改或生成被审资产"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_cocos_architecture",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("engineering-room").roomId,
    taskLevel: "task",
    ownerAgentId: "cocos_tech_lead",
    title: "设计 Cocos 场景与模块蓝图",
    description: "根据 GDD 与 GameContract 定义通用 SceneBlueprint、稳定 testId、组件属性/引用、Prefab 边界、资源加载契约和性能预算。",
    status: "doing",
    priority: 95,
    sortOrder: 115,
    progressPercent: 10,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_game_contract_draft"],
    outputArtifacts: ["artifact_scene_blueprint_draft"],
    acceptanceCriteria: ["SceneBlueprint 已通过证据验证", "模块边界和性能预算明确"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_cocos_implementation",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("engineering-room").roomId,
    taskLevel: "task",
    ownerAgentId: "gameplay_programmer",
    title: "实现 Cocos 首个可玩核心循环",
    description: "根据已审批 GameContract 和 SceneBlueprint 实现该项目的核心循环、状态模型、标准运行时信号和基础 UI TypeScript 代码。",
    status: "todo",
    priority: 90,
    sortOrder: 120,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_game_contract_draft", "artifact_scene_blueprint_draft"],
    outputArtifacts: ["artifact_gameplay_source"],
    acceptanceCriteria: ["玩法 TypeScript 源码已写入 Cocos assets/scripts", "核心循环状态机和 UI 逻辑明确"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_playtest_contract",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("qa-room").roomId,
    taskLevel: "task",
    ownerAgentId: "qa_evaluator",
    title: "定义首个可玩测试契约",
    description: "根据已审批 GameContract 和 SceneBlueprint 定义受限声明式 PlaytestContract；测试语义不得依赖固定游戏状态名、私有字段或节点文案。",
    status: "todo",
    priority: 92,
    sortOrder: 118,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_game_contract_draft", "artifact_scene_blueprint_draft"],
    outputArtifacts: ["artifact_playtest_contract_draft"],
    acceptanceCriteria: ["PlaytestContract 通过严格结构校验", "所有循环和超时均有上限", "required 场景覆盖核心循环"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_cocos_build",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("engineering-room").roomId,
    taskLevel: "task",
    ownerAgentId: "cocos_automation",
    title: "导入资产并构建微信首个可玩版本",
    description: "通过 Cocos 引擎桥导入当前已审查 runtime 资产，生成逐文件字节回执，应用场景蓝图、生成 Prefab，并仅在导入回执仍匹配当前 manifest/source/Cocos destination 时执行微信小游戏开发构建。",
    status: "todo",
    priority: 85,
    sortOrder: 125,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [
      "artifact_asset_manifest_draft",
      "artifact_stage_2_visual_quality_review",
      "artifact_scene_blueprint_draft",
      "artifact_playtest_contract_draft",
      "artifact_gameplay_source"
    ],
    outputArtifacts: ["artifact_wechat_dev_build"],
    acceptanceCriteria: [
      "当前 manifest 的每个 runtime 资产都有 source → Cocos destination 的 hash/size 导入回执",
      "构建报告绑定当前导入回执且 Cocos MCP 构建命令成功",
      "微信小游戏开发构建可启动"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  ensureTask(kernel, {
    taskId: "task_stage_2_qa_playtest",
    projectId,
    stageId,
    parentTaskId: groupId,
    roomId: kernel.getRoom("qa-room").roomId,
    taskLevel: "task",
    ownerAgentId: "qa_evaluator",
    title: "执行首个可玩 QA 试玩",
    description: "按已审批 PlaytestContract 运行 Cocos MiniGame Bench，生成场景结果、试玩报告、截图和 Bug 列表。",
    status: "todo",
    priority: 85,
    sortOrder: 130,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_wechat_dev_build", "artifact_playtest_contract_draft"],
    outputArtifacts: ["artifact_qa_playtest_report"],
    acceptanceCriteria: [
      "真实 Cocos Web 构建已在 Chrome 中启动",
      "PlaytestContract 中全部 required 场景和断言通过",
      "运行时适配器与契约 id、版本和 hash 完成握手",
      "文字不溢出且活动 UI 组件不存在显著重叠",
      "控制台无运行时错误",
      "截图、控制台日志和机器可读 QA 报告均已登记证据"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });

  ensureTaskArtifactReferences(
    kernel,
    groupId,
    "outputArtifacts",
    ["artifact_asset_manifest_draft", "artifact_asset_contact_sheet", "artifact_stage_2_visual_quality_review"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    "task_stage_2_asset_pipeline",
    "outputArtifacts",
    ["artifact_asset_manifest_draft", "artifact_asset_contact_sheet"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    "task_stage_2_visual_quality_review",
    "inputArtifacts",
    [
      "artifact_art_bible_baseline_draft",
      "artifact_asset_manifest_draft",
      "artifact_asset_contact_sheet",
      ...kernel.listArtifacts()
        .filter((artifact) =>
          artifact.type === "asset" &&
          artifact.ownerAgentId === "asset_production" &&
          artifact.sourceTaskId === "task_stage_2_asset_pipeline" &&
          artifact.path.startsWith("assets/art/first-playable/") &&
          artifact.path.toLowerCase().endsWith(".png")
        )
        .map((artifact) => artifact.artifactId)
    ],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    "task_stage_2_visual_quality_review",
    "outputArtifacts",
    ["artifact_stage_2_visual_quality_review"],
    now
  );
  ensureTaskArtifactReferences(
    kernel,
    "task_stage_2_cocos_build",
    "inputArtifacts",
    ["artifact_asset_manifest_draft", "artifact_stage_2_visual_quality_review"],
    now
  );

  ensureArtifact(kernel, {
    artifactId: "artifact_asset_manifest_draft",
    projectId,
    type: "asset_manifest",
    path: "agents/art/asset-manifest.json",
    ownerAgentId: "asset_production",
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_2_asset_pipeline",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime"
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: "artifact_asset_contact_sheet",
    projectId,
    type: "asset",
    path: "agents/art/processed-assets/first-playable-contact-sheet.png",
    ownerAgentId: "asset_production",
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_2_asset_pipeline",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      mediaRole: "asset_contact_sheet"
    },
    createdAt: now,
    updatedAt: now
  });
  const stageTwoVisualReviewContract = getQualityReviewArtifactContracts().find(
    (candidate) => candidate.artifactId === "artifact_stage_2_visual_quality_review"
  );
  if (!stageTwoVisualReviewContract) {
    throw new Error("Missing Stage 2 visual quality review artifact contract.");
  }
  ensureDeclaredArtifact(kernel, {
    artifactId: stageTwoVisualReviewContract.artifactId,
    projectId,
    type: stageTwoVisualReviewContract.type,
    path: stageTwoVisualReviewContract.path,
    ownerAgentId: stageTwoVisualReviewContract.ownerAgentId,
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: stageTwoVisualReviewContract.sourceTaskId,
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      artifactContract: "quality-review.v1",
      qualityReviewDomain: stageTwoVisualReviewContract.domain,
      subjectArtifactIds: [...stageTwoVisualReviewContract.subjectArtifactIds]
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: "artifact_scene_blueprint_draft",
    projectId,
    type: "scene_blueprint",
    path: "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json",
    ownerAgentId: "cocos_tech_lead",
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_2_cocos_architecture",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime"
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: "artifact_playtest_contract_draft",
    projectId,
    type: "playtest_contract",
    path: "agents/qa/contracts/core-loop.playtest-contract.json",
    ownerAgentId: "qa_evaluator",
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_2_playtest_contract",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      schemaVersion: 1
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: "artifact_gameplay_source",
    projectId,
    type: "source_code",
    path: "assets/scripts/gameplay/GameController.ts",
    ownerAgentId: "gameplay_programmer",
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_2_cocos_implementation",
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      placeholder: true
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: "artifact_wechat_dev_build",
    projectId,
    type: "build",
    path: "shared/build-artifacts/wechat/dev",
    ownerAgentId: "cocos_automation",
    stageId,
    status: "draft",
    version: 1,
    sourceTaskId: "task_stage_2_cocos_build",
    sourceDecisionIds: [],
    metadata: {
      buildMode: "local_mvp_placeholder",
      sourceMessageId: message.messageId
    },
    createdAt: now,
    updatedAt: now
  });
  ensureArtifact(kernel, {
    artifactId: "artifact_qa_playtest_report",
    projectId,
    type: "qa_report",
    path: "agents/qa/playtest-reports/report-001.md",
    ownerAgentId: "qa_evaluator",
    stageId,
    status: "submitted",
    version: 1,
    sourceTaskId: "task_stage_2_qa_playtest",
    sourceDecisionIds: [],
    metadata: {
      bench: "Cocos MiniGame Bench",
      playtestVerdict: "not_run"
    },
    createdAt: now,
    updatedAt: now
  });

  writeAgentMessage(kernel, {
    agentId: "asset_production",
    roomKind: "art-room",
    messageType: "progress_update",
    relatedArtifactIds: ["artifact_asset_manifest_draft", "artifact_asset_contact_sheet"],
    content: "Stage 2 美术资产任务已排队；资产生产 Agent 必须通过真实图片模型生成 PNG 与联系表，并登记 provider/model/request/prompt hash 和文件证据。"
  });
  writeAgentMessage(kernel, {
    agentId: "visual_quality_reviewer",
    roomKind: "art-room",
    messageType: "progress_update",
    relatedArtifactIds: ["artifact_stage_2_visual_quality_review"],
    content: "独立视觉质量审查等待当前 Art Bible、资产清单和真实联系表；未读取实际像素或存在 critical/major 问题时不得通过。"
  });
  writeAgentMessage(kernel, {
    agentId: "cocos_tech_lead",
    roomKind: "engineering-room",
    messageType: "progress_update",
    relatedArtifactIds: ["artifact_scene_blueprint_draft", "artifact_playtest_contract_draft"],
    content: "Stage 2 Cocos 架构任务已排队；通用场景蓝图完成后会交接给玩法程序、QA 契约设计和 Cocos 自动化。"
  });
  writeAgentMessage(kernel, {
    agentId: "cocos_automation",
    roomKind: "engineering-room",
    messageType: "progress_update",
    relatedArtifactIds: ["artifact_wechat_dev_build"],
    content: "Cocos 自动化构建任务等待资产清单、场景蓝图和玩法源码；没有真实引擎工具结果时不会声明构建完成。"
  });
  writeAgentMessage(kernel, {
    agentId: "qa_evaluator",
    roomKind: "qa-room",
    messageType: "playtest_summary",
    relatedArtifactIds: ["artifact_qa_playtest_report"],
    content: "QA 试玩任务等待真实微信开发构建；没有运行、截图和报告证据时不会提交首个可玩结论。"
  });
}

function ensureReleaseTasksAndArtifacts(kernel: StudioKernel, message: StudioMessage, now: string): void {
  const projectId = kernel.project.projectId;
  const stageId: StageId = "release_preparation";
  const groupId = "task_group_stage_3";

  ensureTask(kernel, {
    taskId: groupId,
    projectId,
    stageId,
    taskLevel: "task_group",
    ownerAgentId: "studio_orchestrator",
    title: "阶段 3：上线、运维和持续迭代",
    description: "先完成微信发布准备、QA 发布门禁、部署计划和回滚方案；制作人批准后再执行真实部署，最后进入 LiveOps。",
    status: "doing",
    priority: 100,
    sortOrder: 200,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_wechat_dev_build", "artifact_qa_playtest_report"],
    outputArtifacts: ["artifact_wechat_release_build", "artifact_release_gate_report", "artifact_deployment_plan", "artifact_rollback_plan", "artifact_deployment_report", "artifact_release_notes"],
    acceptanceCriteria: ["发布门禁通过", "审批前部署与回滚计划完备", "审批后真实部署记录存在", "LiveOps backlog 存在"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
  const releaseTasks: Task[] = [
    {
      taskId: "task_stage_3_wechat_release",
      projectId,
      stageId,
      parentTaskId: groupId,
      roomId: kernel.getRoom("release-room").roomId,
      taskLevel: "task",
      ownerAgentId: "wechat_platform",
      title: "准备微信小游戏发布包",
      description: "检查包体、资源策略、预览和上传准备。",
      status: "doing",
      priority: 95,
      sortOrder: 210,
      progressPercent: 50,
      childrenSummary: emptyChildrenSummary(),
      inputArtifacts: ["artifact_wechat_dev_build"],
      outputArtifacts: ["artifact_wechat_release_build"],
      acceptanceCriteria: ["包体检查通过", "上传准备报告存在"],
      blockers: [],
      createdAt: now,
      updatedAt: now
    },
    {
      taskId: "task_stage_3_qa_release_gate",
      projectId,
      stageId,
      parentTaskId: groupId,
      roomId: kernel.getRoom("qa-room").roomId,
      taskLevel: "task",
      ownerAgentId: "qa_evaluator",
      title: "执行发布门禁",
      description: "执行 Cocos MiniGame Bench 发布维度并生成 release gate report。",
      status: "doing",
      priority: 90,
      sortOrder: 220,
      progressPercent: 50,
      childrenSummary: emptyChildrenSummary(),
      inputArtifacts: ["artifact_wechat_release_build", "artifact_playtest_contract_draft"],
      outputArtifacts: ["artifact_release_gate_report"],
      acceptanceCriteria: ["真实 Cocos 试玩全状态路径通过", "不存在 blocker/critical/major 缺陷", "发布门禁证据完整"],
      blockers: [],
      createdAt: now,
      updatedAt: now
    },
    {
      taskId: "task_stage_3_devops_plan",
      projectId,
      stageId,
      parentTaskId: groupId,
      roomId: kernel.getRoom("release-room").roomId,
      taskLevel: "task",
      ownerAgentId: "devops",
      title: "准备部署计划和回滚方案",
      description: "在发布审批前使用 Secret Vault 引用生成可审阅的部署计划和回滚方案，不执行真实部署。",
      status: "doing",
      priority: 85,
      sortOrder: 230,
      childrenSummary: emptyChildrenSummary(),
      inputArtifacts: ["artifact_release_gate_report"],
      outputArtifacts: ["artifact_deployment_plan", "artifact_rollback_plan"],
      acceptanceCriteria: ["部署步骤、健康检查和凭据引用明确", "回滚触发条件与恢复步骤明确"],
      blockers: [],
      createdAt: now,
      updatedAt: now
    },
    {
      taskId: "task_stage_3_devops_deploy",
      projectId,
      stageId: "production_deploy",
      parentTaskId: groupId,
      roomId: kernel.getRoom("release-room").roomId,
      taskLevel: "task",
      ownerAgentId: "devops",
      title: "执行生产部署和健康检查",
      description: "制作人批准发布后，按已验证计划执行真实部署和健康检查，并据实生成部署记录。",
      status: "todo",
      priority: 80,
      sortOrder: 235,
      childrenSummary: emptyChildrenSummary(),
      inputArtifacts: ["artifact_wechat_release_build", "artifact_deployment_plan", "artifact_rollback_plan"],
      outputArtifacts: ["artifact_deployment_report"],
      acceptanceCriteria: ["真实部署成功", "健康检查通过", "部署记录包含可审计执行证据"],
      blockers: [],
      createdAt: now,
      updatedAt: now
    },
    {
      taskId: "task_stage_3_liveops_backlog",
      projectId,
      stageId: "liveops",
      parentTaskId: groupId,
      roomId: kernel.getRoom("studio-main").roomId,
      taskLevel: "task",
      ownerAgentId: "liveops_analytics",
      title: "生成 LiveOps 迭代 backlog",
      description: "创建基础埋点事件、上线后观察项和迭代 backlog。",
      status: "todo",
      priority: 70,
      sortOrder: 240,
      childrenSummary: emptyChildrenSummary(),
      inputArtifacts: ["artifact_deployment_report"],
      outputArtifacts: ["artifact_release_notes"],
      acceptanceCriteria: ["埋点方案存在", "迭代 backlog 存在"],
      blockers: [],
      createdAt: now,
      updatedAt: now
    }
  ];
  for (const task of releaseTasks) {
    ensureTask(kernel, task);
  }

  const releaseArtifacts: Artifact[] = [
    {
      artifactId: "artifact_wechat_release_build",
      projectId,
      type: "build",
      path: "shared/build-artifacts/wechat/release",
      ownerAgentId: "wechat_platform",
      stageId,
      status: "draft",
      version: 1,
      sourceTaskId: "task_stage_3_wechat_release",
      sourceDecisionIds: [],
      metadata: { buildMode: "local_mvp_placeholder", sourceMessageId: message.messageId },
      createdAt: now,
      updatedAt: now
    },
    {
      artifactId: "artifact_release_gate_report",
      projectId,
      type: "qa_report",
      path: "agents/qa/release-gate-reports/release-gate-001.md",
      ownerAgentId: "qa_evaluator",
      stageId,
      status: "submitted",
      version: 1,
      sourceTaskId: "task_stage_3_qa_release_gate",
      sourceDecisionIds: [],
      metadata: { playtestVerdict: "not_run" },
      createdAt: now,
      updatedAt: now
    },
    {
      artifactId: "artifact_deployment_plan",
      projectId,
      type: "deployment_plan",
      path: "agents/devops/deployment-plans/deploy-plan-001.md",
      ownerAgentId: "devops",
      stageId,
      status: "draft",
      version: 1,
      sourceTaskId: "task_stage_3_devops_plan",
      sourceDecisionIds: [],
      metadata: { secretMode: "vault_reference_only", executionStatus: "not_started" },
      createdAt: now,
      updatedAt: now
    },
    {
      artifactId: "artifact_deployment_report",
      projectId,
      type: "deployment_report",
      path: "agents/devops/deployment-reports/deploy-001.md",
      ownerAgentId: "devops",
      stageId: "production_deploy",
      status: "draft",
      version: 1,
      sourceTaskId: "task_stage_3_devops_deploy",
      sourceDecisionIds: [],
      metadata: { secretMode: "vault_reference_only", deploymentStatus: "not_run" },
      createdAt: now,
      updatedAt: now
    },
    {
      artifactId: "artifact_rollback_plan",
      projectId,
      type: "rollback_plan",
      path: "agents/devops/rollback-plans/rollback-001.md",
      ownerAgentId: "devops",
      stageId,
      status: "draft",
      version: 1,
      sourceTaskId: "task_stage_3_devops_plan",
      sourceDecisionIds: [],
      metadata: {},
      createdAt: now,
      updatedAt: now
    },
    {
      artifactId: "artifact_release_notes",
      projectId,
      type: "release_notes",
      path: "shared/release-notes/release-001.md",
      ownerAgentId: "liveops_analytics",
      stageId: "liveops",
      status: "draft",
      version: 1,
      sourceTaskId: "task_stage_3_liveops_backlog",
      sourceDecisionIds: [],
      metadata: {},
      createdAt: now,
      updatedAt: now
    }
  ];
  for (const artifact of releaseArtifacts) {
    ensureArtifact(kernel, artifact);
  }

  writeAgentMessage(kernel, {
    agentId: "wechat_platform",
    roomKind: "release-room",
    messageType: "progress_update",
    relatedArtifactIds: ["artifact_wechat_release_build"],
    content: "微信小游戏 release build 占位产物已生成，等待制作人发布确认。"
  });
  writeAgentMessage(kernel, {
    agentId: "qa_evaluator",
    roomKind: "qa-room",
    messageType: "release_gate",
    relatedArtifactIds: ["artifact_release_gate_report"],
    content: "发布门禁报告占位已生成，当前结论等待制作人确认或豁免。"
  });
}

function ensureTask(kernel: StudioKernel, task: Task): void {
  if (!kernel.findTask(task.taskId)) {
    kernel.addTask(task);
  }
}

function ensureTaskArtifactReferences(
  kernel: StudioKernel,
  taskId: string,
  field: "inputArtifacts" | "outputArtifacts",
  requiredArtifactIds: string[],
  now: string
): void {
  const task = kernel.findTask(taskId);
  if (!task) {
    throw new Error(`Local runtime artifact contract references unknown task ${taskId}.`);
  }
  const current = task[field];
  const merged = [...requiredArtifactIds, ...current.filter((artifactId) => !requiredArtifactIds.includes(artifactId))];
  if (current.length === merged.length && current.every((artifactId, index) => artifactId === merged[index])) {
    return;
  }
  kernel.updateTask(
    taskId,
    field === "inputArtifacts"
      ? { inputArtifacts: merged, updatedAt: now }
      : { outputArtifacts: merged, updatedAt: now }
  );
}

function ensureDeclaredArtifact(kernel: StudioKernel, artifact: Artifact): void {
  const existing = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifact.artifactId);
  if (!existing) {
    const pathOwner = kernel.listArtifacts().find((candidate) => candidate.path === artifact.path);
    if (pathOwner) {
      blockArtifactIdentityConflict(kernel, artifact, pathOwner, artifactIdentityMismatches(artifact, pathOwner));
      return;
    }
    kernel.addArtifact(artifact);
    return;
  }
  const mismatches = artifactIdentityMismatches(artifact, existing);
  if (mismatches.length > 0) {
    blockArtifactIdentityConflict(kernel, artifact, existing, mismatches);
  }
}

function artifactIdentityMismatches(
  expected: Pick<Artifact, "artifactId" | "projectId" | "type" | "path" | "ownerAgentId" | "sourceTaskId">,
  actual: Artifact
): string[] {
  const mismatches: string[] = [];
  for (const field of ["artifactId", "projectId", "type", "path", "ownerAgentId", "sourceTaskId"] as const) {
    if (expected[field] !== actual[field]) {
      mismatches.push(
        `${field}=${String(actual[field] ?? "missing")}, expected ${String(expected[field] ?? "missing")}`
      );
    }
  }
  return mismatches;
}

function rekeySnapshotArtifact(snapshot: StudioKernelSnapshot, fromArtifactId: string, toArtifactId: string): void {
  const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === fromArtifactId);
  if (!artifact || snapshot.artifacts.some((candidate) => candidate.artifactId === toArtifactId)) {
    throw new Error(`Cannot migrate artifact identity ${fromArtifactId} -> ${toArtifactId}.`);
  }
  artifact.artifactId = toArtifactId;
  artifact.metadata = {
    ...artifact.metadata,
    legacyArtifactIds: [
      ...new Set([
        ...(Array.isArray(artifact.metadata.legacyArtifactIds)
          ? artifact.metadata.legacyArtifactIds.filter((value): value is string => typeof value === "string")
          : []),
        fromArtifactId
      ])
    ],
    artifactIdentityMigration: "stage1_canonical_v1",
    artifactIdentityMigratedAt: snapshot.savedAt
  };

  for (const task of snapshot.tasks) {
    task.inputArtifacts = replaceArtifactIdList(task.inputArtifacts, fromArtifactId, toArtifactId);
    task.outputArtifacts = replaceArtifactIdList(task.outputArtifacts, fromArtifactId, toArtifactId);
  }
  for (const message of snapshot.messages) {
    message.relatedArtifactIds = replaceArtifactIdList(message.relatedArtifactIds, fromArtifactId, toArtifactId);
    const toolExecutions = message.metadata.toolExecutions;
    if (Array.isArray(toolExecutions)) {
      for (const execution of toolExecutions) {
        if (
          execution &&
          typeof execution === "object" &&
          !Array.isArray(execution) &&
          (execution as Record<string, unknown>).artifactId === fromArtifactId
        ) {
          (execution as Record<string, unknown>).artifactId = toArtifactId;
        }
      }
    }
    rewriteEmbeddedClaimReferences(message.metadata.claimVerifications, fromArtifactId, toArtifactId);
  }
  for (const operation of snapshot.artifactOperations) {
    if (operation.artifactId === fromArtifactId) {
      operation.artifactId = toArtifactId;
    }
  }
  for (const ledger of snapshot.artifactLedger) {
    if (ledger.artifactId === fromArtifactId) {
      ledger.artifactId = toArtifactId;
    }
    for (const input of ledger.inputArtifacts ?? []) {
      if (input.artifactId === fromArtifactId) {
        input.artifactId = toArtifactId;
      }
    }
  }
  for (const claim of snapshot.claimVerifications) {
    claim.relatedArtifactIds = replaceArtifactIdList(claim.relatedArtifactIds, fromArtifactId, toArtifactId);
    claim.evidenceRefs = replaceArtifactIdList(claim.evidenceRefs, fromArtifactId, toArtifactId);
  }
  for (const capsule of snapshot.handoffCapsules ?? []) {
    capsule.artifactIds = replaceArtifactIdList(capsule.artifactIds, fromArtifactId, toArtifactId);
  }
  for (const packet of snapshot.contextPackets ?? []) {
    for (const layer of packet.layers) {
      layer.sourceRefs = replaceArtifactIdList(layer.sourceRefs, fromArtifactId, toArtifactId);
    }
  }
  for (const memory of snapshot.memoryRecords) {
    if (memory.sourceArtifactId === fromArtifactId) {
      memory.sourceArtifactId = toArtifactId;
    }
  }
  for (const event of snapshot.auditEvents) {
    event.inputArtifacts = replaceArtifactIdList(event.inputArtifacts, fromArtifactId, toArtifactId);
    event.outputArtifacts = replaceArtifactIdList(event.outputArtifacts, fromArtifactId, toArtifactId);
    if (Array.isArray(event.metadata.evidenceRefs)) {
      event.metadata.evidenceRefs = replaceArtifactIdList(
        event.metadata.evidenceRefs.filter((value): value is string => typeof value === "string"),
        fromArtifactId,
        toArtifactId
      );
    }
  }
  for (const gate of snapshot.workflow?.gates ?? []) {
    gate.requiredArtifacts = replaceArtifactIdList(gate.requiredArtifacts, fromArtifactId, toArtifactId);
  }
  for (const event of snapshot.workflow?.events ?? []) {
    if (event.type === "gate_opened") {
      event.gate.requiredArtifacts = replaceArtifactIdList(
        event.gate.requiredArtifacts,
        fromArtifactId,
        toArtifactId
      );
    }
  }
  assertNoUnknownMetadataArtifactReference(snapshot, fromArtifactId);
}

function replaceArtifactIdList(values: string[], fromArtifactId: string, toArtifactId: string): string[] {
  return [...new Set(values.map((value) => (value === fromArtifactId ? toArtifactId : value)))];
}

function rewriteEmbeddedClaimReferences(value: unknown, fromArtifactId: string, toArtifactId: string): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const claim of value) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      continue;
    }
    const record = claim as Record<string, unknown>;
    if (Array.isArray(record.relatedArtifactIds)) {
      record.relatedArtifactIds = replaceArtifactIdList(
        record.relatedArtifactIds.filter((item): item is string => typeof item === "string"),
        fromArtifactId,
        toArtifactId
      );
    }
    if (Array.isArray(record.evidenceRefs)) {
      record.evidenceRefs = replaceArtifactIdList(
        record.evidenceRefs.filter((item): item is string => typeof item === "string"),
        fromArtifactId,
        toArtifactId
      );
    }
  }
}

function assertNoUnknownMetadataArtifactReference(snapshot: StudioKernelSnapshot, artifactId: string): void {
  const metadataValues: unknown[] = [
    ...snapshot.artifacts.map((artifact) => artifact.metadata),
    ...snapshot.artifactOperations.map((operation) => operation.metadata),
    ...snapshot.messages.map((message) => message.metadata),
    ...snapshot.auditEvents.map((event) => event.metadata)
  ];
  if (metadataValues.some((value) => containsExactMetadataValue(value, artifactId))) {
    throw new Error(`Legacy artifact ${artifactId} has an unknown metadata reference; automatic rekey was refused.`);
  }
}

function containsExactMetadataValue(value: unknown, expected: string, key?: string): boolean {
  if (key === "legacyArtifactIds") {
    return false;
  }
  if (value === expected) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsExactMetadataValue(item, expected));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([entryKey, entryValue]) => containsExactMetadataValue(entryValue, expected, entryKey)
  );
}

function stageOneArtifactIdentityBlocker(
  expected: Pick<Artifact, "artifactId" | "type" | "path" | "ownerAgentId" | "sourceTaskId">,
  actual: Artifact,
  mismatches: string[]
): string {
  return (
    `Stage 1 产物身份契约冲突：${expected.artifactId} 必须是 ` +
    `type=${expected.type}, path=${expected.path}, owner=${expected.ownerAgentId}, task=${expected.sourceTaskId ?? "missing"}；` +
    `实际 ${actual.artifactId} 不匹配（${mismatches.join("；")}）。已拒绝自动登记/迁移。`
  );
}

function blockArtifactIdentityConflict(
  kernel: StudioKernel,
  expected: Artifact,
  pathOwner: Artifact,
  mismatches: string[]
): void {
  if (!expected.sourceTaskId) {
    return;
  }
  const task = kernel.findTask(expected.sourceTaskId);
  if (!task || task.status === "cancelled") {
    return;
  }
  const now = new Date().toISOString();
  const blocker = stageOneArtifactIdentityBlocker(expected, pathOwner, mismatches);
  const agentState = kernel.getAgentLoopState().agents[task.ownerAgentId];
  if (
    task.status === "blocked" &&
    task.blockers.includes(blocker) &&
    agentState?.status === "blocked" &&
    agentState.lastError === blocker
  ) {
    return;
  }
  kernel.updateTask(task.taskId, {
    status: "blocked",
    blockers: [...new Set([...task.blockers, blocker])],
    updatedAt: now
  });
  kernel.updateAgentLoopAgent(task.ownerAgentId, {
    status: "blocked",
    taskId: task.taskId,
    lastError: blocker,
    updatedAt: now
  });
}

function ensureArtifact(kernel: StudioKernel, artifact: Artifact): void {
  if (!kernel.listArtifacts().some((candidate) => candidate.artifactId === artifact.artifactId)) {
    kernel.addArtifact(artifact);
  }
}

function stageOneContractFingerprint(kernel: StudioKernel, taskIds: string[], artifactIds: string[]): string {
  const artifacts = kernel.listArtifacts();
  const loopAgents = kernel.getAgentLoopState().agents;
  return JSON.stringify({
    tasks: taskIds.map((taskId) => {
      const task = kernel.findTask(taskId);
      return task
        ? {
            taskId,
            status: task.status,
            progressPercent: task.progressPercent,
            blockers: task.blockers,
            ownerAgentId: task.ownerAgentId,
            stageId: task.stageId,
            inputArtifacts: task.inputArtifacts,
            outputArtifacts: task.outputArtifacts
          }
        : { taskId, missing: true };
    }),
    artifacts: artifactIds.map((artifactId) => {
      const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
      return artifact
        ? {
            artifactId,
            type: artifact.type,
            path: artifact.path,
            ownerAgentId: artifact.ownerAgentId,
            sourceTaskId: artifact.sourceTaskId
          }
        : { artifactId, missing: true };
    }),
    agents: taskIds.map((taskId) => {
      const task = kernel.findTask(taskId);
      const agent = task ? loopAgents[task.ownerAgentId] : undefined;
      return agent?.taskId === taskId
        ? { taskId, agentId: agent.agentId, status: agent.status, lastError: agent.lastError }
        : { taskId };
    })
  });
}

function reopenStageOneTaskForMissingEvidence(
  kernel: StudioKernel,
  taskId: string,
  requiredArtifactIds: string[],
  now: string
): void {
  const task = kernel.findTask(taskId);
  if (!task || task.status === "cancelled") {
    return;
  }
  const ledger = kernel.listArtifactLedger();
  const missingEvidence = requiredArtifactIds.some((artifactId) => {
    const entry = ledger.find((candidate) => candidate.artifactId === artifactId);
    return !entry || entry.status !== "verified" || !entry.hash || !entry.sizeBytes;
  });
  if (!missingEvidence || ["todo", "doing", "blocked"].includes(task.status)) {
    return;
  }
  kernel.updateTask(task.taskId, {
    status: "doing",
    progressPercent: Math.min(task.progressPercent ?? 80, 85),
    blockers: task.blockers.filter((blocker) => !blocker.startsWith("Agent Loop：")),
    updatedAt: now
  });
  kernel.updateAgentLoopAgent(task.ownerAgentId, {
    status: "queued",
    taskId: task.taskId,
    lastError: undefined,
    updatedAt: now
  });
}

function reconcileReviewedTaskAgentState(kernel: StudioKernel, taskIds: string[], now: string): void {
  const loopAgents = kernel.getAgentLoopState().agents;
  for (const taskId of taskIds) {
    const task = kernel.findTask(taskId);
    const agent = task ? loopAgents[task.ownerAgentId] : undefined;
    if (
      !task ||
      !["review", "done"].includes(task.status) ||
      agent?.taskId !== task.taskId ||
      agent.status === "working" ||
      (agent.status === "waiting" && !agent.lastError)
    ) {
      continue;
    }
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "waiting",
      taskId: task.taskId,
      lastError: undefined,
      updatedAt: now
    });
  }
}

function ensureArtifactStatus(kernel: StudioKernel, artifactId: string, status: Artifact["status"], now: string): void {
  if (kernel.listArtifacts().some((candidate) => candidate.artifactId === artifactId)) {
    kernel.updateArtifactStatus(artifactId, status, now);
  }
}

function writeProjectMemory(
  kernel: StudioKernel,
  input: {
    memoryId: string;
    ownerAgent: AgentId;
    type: string;
    content: string;
    now: string;
  }
): void {
  if (kernel.memory.query({ projectId: kernel.project.projectId, status: ["active", "draft"] }).some((record) => record.memoryId === input.memoryId)) {
    return;
  }

  const record: MemoryRecord = {
    memoryId: input.memoryId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    scope: input.type.includes("draft") ? "artifact" : "project",
    ownerAgent: input.ownerAgent,
    type: input.type,
    status: input.type.includes("draft") ? "draft" : "active",
    content: input.content,
    createdAt: input.now,
    updatedAt: input.now
  };
  kernel.writeMemory(record);
}

function writeAgentMessage(
  kernel: StudioKernel,
  input: {
    agentId: AgentId;
    roomKind: RoomKind;
    messageType: MessageType;
    content: string;
    relatedTaskIds?: string[];
    relatedArtifactIds?: string[];
  }
): void {
  const now = new Date().toISOString();
  const room = kernel.getRoom(input.roomKind);
  kernel.recordMessage({
    messageId: `msg_${input.agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId: room.roomId,
    senderType: "agent",
    senderId: input.agentId,
    messageType: input.messageType,
    content: input.content,
    mentions: [],
    relatedTaskIds: input.relatedTaskIds ?? [],
    relatedArtifactIds: input.relatedArtifactIds ?? [],
    metadata: {
      generatedBy: "local_agent_runtime"
    },
    createdAt: now
  });
}

function requireVerifiedArtifacts(kernel: StudioKernel, artifactIds: readonly string[]): void {
  const missing = artifactIds.filter((artifactId) => {
    const artifact = kernel.listArtifacts().find((entry) => entry.artifactId === artifactId);
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId);
    return !artifact?.metadata.toolExecutedAt || !ledger || ledger.status !== "verified" || !ledger.hash || !ledger.sizeBytes;
  });
  if (missing.length > 0) {
    throw new Error(`缺少已验证产物证据：${missing.join("、")}`);
  }
}

function requirePassingPlaytest(kernel: StudioKernel, artifactId: string): void {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const provenByPlaytestTool = artifact?.metadata.toolName === "run_playtest" || artifact?.metadata.harnessToolName === "run_playtest";
  if (!artifact || !provenByPlaytestTool || artifact.metadata.playtestVerdict !== "pass") {
    throw new Error(`QA 真实试玩尚未通过：${artifactId} 当前结论为 ${String(artifact?.metadata.playtestVerdict ?? "not_run")}`);
  }
  const defects = Array.isArray(artifact.metadata.playtestDefects) ? artifact.metadata.playtestDefects : [];
  if (defects.some((defect) => typeof defect === "object" && defect !== null && ["blocker", "critical", "major"].includes(String((defect as { severity?: unknown }).severity)))) {
    throw new Error(`QA 真实试玩仍有 blocker/critical/major 缺陷：${artifactId}`);
  }
}

const conservativeRuntimeGateEvidencePolicy: GateEvidencePolicy = {
  assertGateEvidence(kernel, requirement): void {
    requireVerifiedArtifacts(kernel, requirement.requiredArtifactIds);
    if (requirement.qaReportArtifactId) {
      requirePassingPlaytest(kernel, requirement.qaReportArtifactId);
    }
  }
};

function assertGateEvidence(
  policy: GateEvidencePolicy,
  kernel: StudioKernel,
  gate: GateAction,
  phase: GateEvidencePhase
): void {
  policy.assertGateEvidence(kernel, {
    gateActionId: gate.actionId,
    phase,
    requiredArtifactIds: gate.requiredArtifacts,
    ...(gate.actionId === "playable"
      ? {
          qaTaskId: "task_stage_2_qa_playtest",
          qaReportArtifactId: "artifact_qa_playtest_report"
        }
      : {}),
    ...(gate.actionId === "release"
      ? {
          qaTaskId: "task_stage_3_qa_release_gate",
          qaReportArtifactId: "artifact_release_gate_report"
        }
      : {})
  });
}

function writeEvidenceBlocker(kernel: StudioKernel, gate: GateAction, error: unknown): void {
  writeAgentMessage(kernel, {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "blocker",
    content: `无法执行「${gate.label}」：${error instanceof Error ? error.message : String(error)}。请等待对应 Agent 通过工具写入产物并完成 claim 验证后再确认。`
  });
}
