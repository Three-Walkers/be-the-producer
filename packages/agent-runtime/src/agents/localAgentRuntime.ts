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
import type { StudioKernel } from "../studio/studioKernel.js";

export interface LocalAgentRunResult {
  routePlan: RoutePlan;
  agentMessages: StudioMessage[];
}

export interface LocalAgentRuntimeOptions {
  scriptedReplies?: boolean;
  protocolFlows?: boolean;
  bootstrapProjectState?: boolean;
}

type Handler = (input: HandlerInput) => void;

interface HandlerInput {
  kernel: StudioKernel;
  producerMessage: StudioMessage;
  route: AgentRouteScore;
  now: string;
}

type GateActionId = "stage1" | "playable" | "release";

interface GateAction {
  actionId: GateActionId;
  label: string;
  confirmToken: string;
  expectedStages: StageId[];
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
    expectedStages: ["concept_discussion"]
  },
  playable: {
    actionId: "playable",
    label: "首个可玩通过",
    confirmToken: "执行确认：首个可玩通过",
    expectedStages: ["production"]
  },
  release: {
    actionId: "release",
    label: "批准发布",
    confirmToken: "执行确认：批准发布",
    expectedStages: ["release_preparation", "release_gate"]
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
  private readonly handlers: Partial<Record<AgentId, Handler>> = {
    studio_orchestrator: handleOrchestrator,
    producer: handleProducer,
    game_designer: handleGameDesigner,
    art_director: handleArtDirector,
    asset_production: handleAssetProduction,
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
    const transitionApplied = gate && shouldRunLocalDecisionFlow ? applyProducerDecisionFlow(kernel, message, gate, now) : false;
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
          now
        });
      }
    }

    return {
      routePlan,
      agentMessages: kernel.listMessages().slice(before)
    };
  }
}

function bootstrapConceptDiscussion(kernel: StudioKernel, producerMessage: StudioMessage, now: string): void {
  ensureStageOneTasks(kernel, now);
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
    relatedTaskIds: ["task_group_stage_1", "task_stage_1_design_clarification", "task_stage_1_art_direction", "task_stage_1_scope_review"],
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

function applyProducerDecisionFlow(kernel: StudioKernel, message: StudioMessage, gate: GateAction, now: string): boolean {
  const hasReview = hasRecentGateReview(kernel, gate, message.messageId);
  if (isGateExecutionConfirmation(message.content, gate) || (hasReview && isNaturalLanguageGateConfirmation(message.content))) {
    executeGateAction(kernel, message, gate, now);
    return true;
  }

  writeGateReview(kernel, message, gate, now);
  return true;
}

function executeGateAction(kernel: StudioKernel, message: StudioMessage, gate: GateAction, now: string): void {
  if (!isGateStageApplicable(kernel, gate)) {
    writeAgentMessage(kernel, {
      agentId: "studio_orchestrator",
      roomKind: "studio-main",
      messageType: "blocker",
      content: `无法执行「${gate.label}」：当前阶段是「${stageText(kernel.project.currentStage)}」，该门禁只适用于「${gate.expectedStages.map(stageText).join("、")}」。请先完成前置阶段。`
    });
    return;
  }

  if (!hasRecentGateReview(kernel, gate, message.messageId)) {
    writeAgentMessage(kernel, {
      agentId: "studio_orchestrator",
      roomKind: "studio-main",
      messageType: "decision_request",
      content: `无法直接执行「${gate.label}」。制作人决策必须先经过相关 Agent 门禁评审。请先发起「${gate.label}」评审，查看准备度、阻塞和风险后，再使用二次确认口令。`
    });
    return;
  }

  switch (gate.actionId) {
    case "stage1":
      try {
        approveStageOne(kernel, message, now);
      } catch (error) {
        writeEvidenceBlocker(kernel, gate, error);
      }
      return;
    case "playable":
      try {
        approveFirstPlayable(kernel, message, now);
      } catch (error) {
        writeEvidenceBlocker(kernel, gate, error);
      }
      return;
    case "release":
      try {
        approveRelease(kernel, message, now);
      } catch (error) {
        writeEvidenceBlocker(kernel, gate, error);
      }
      return;
  }
}

function writeGateReview(kernel: StudioKernel, message: StudioMessage, gate: GateAction, now: string): void {
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

function buildGateReviewLines(kernel: StudioKernel, gate: GateAction, stageApplicable: boolean, now: string): GateReviewLine[] {
  switch (gate.actionId) {
    case "stage1":
      ensureStageOneTasks(kernel, now);
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
  const scopeTask = kernel.findTask("task_stage_1_scope_review");
  const gdd = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_gdd_baseline_draft");
  const artBible = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_art_bible_baseline_draft");
  const blockers = [...(designTask?.blockers ?? []), ...(artTask?.blockers ?? []), ...(scopeTask?.blockers ?? [])];
  const missing = [
    ...(gdd ? [] : ["GDD baseline 尚未生成"]),
    ...(artBible ? [] : ["Art Bible baseline 尚未生成"])
  ];
  const risks = [
    ...blockers,
    ...missing,
    "强行推进会把未澄清的玩法边界和视觉风格带入开发，后续返工成本会上升。"
  ];

  return [
    {
      agentId: "game_designer",
      roomKind: "design-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。策划准备度：${readinessText(stageApplicable && Boolean(gdd) && !designTask?.blockers.length)}。${taskStatusText(designTask)} 风险：${formatList([...(designTask?.blockers ?? []), "核心操作、胜负条件和第一可玩范围需要制作人明确确认。"])}`
    },
    {
      agentId: "art_director",
      roomKind: "art-room",
      messageType: "review",
      content: `门禁评审：${gate.label}。美术准备度：${readinessText(stageApplicable && Boolean(artBible) && !artTask?.blockers.length)}。${taskStatusText(artTask)} 风险：${formatList([...(artTask?.blockers ?? []), "视觉参考、主色和禁用风格未确认时，资产生产会出现方向返工。"])}`
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
  const codeTask = kernel.findTask("task_stage_2_cocos_implementation");
  const qaTask = kernel.findTask("task_stage_2_qa_playtest");
  const build = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_wechat_dev_build");
  const qaReport = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_qa_playtest_report");
  const qaPassed = qaReport?.metadata.playtestVerdict === "pass" &&
    (qaReport.metadata.toolName === "run_playtest" || qaReport.metadata.harnessToolName === "run_playtest");
  const blockers = [...(assetTask?.blockers ?? []), ...(codeTask?.blockers ?? []), ...(qaTask?.blockers ?? [])];
  const missing = [
    ...(build ? [] : ["微信小游戏开发构建尚未生成"]),
    ...(qaPassed ? [] : [qaReport ? "QA 报告存在，但真实试玩结论尚未通过" : "首个可玩 QA 试玩报告尚未生成"])
  ];
  const risks = [
    ...blockers,
    ...missing,
    "强行通过首个可玩会跳过可玩性、稳定性和核心循环验证。"
  ];

  return [
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
  const devopsTask = kernel.findTask("task_stage_3_devops_deploy");
  const releaseBuild = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_wechat_release_build");
  const releaseGate = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_release_gate_report");
  const releaseQaPassed = releaseGate?.metadata.playtestVerdict === "pass" &&
    (releaseGate.metadata.toolName === "run_playtest" || releaseGate.metadata.harnessToolName === "run_playtest");
  const deployment = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_deployment_report");
  const rollback = kernel.listArtifacts().find((artifact) => artifact.artifactId === "artifact_rollback_plan");
  const blockers = [...(releaseTask?.blockers ?? []), ...(qaTask?.blockers ?? []), ...(devopsTask?.blockers ?? [])];
  const missing = [
    ...(releaseBuild ? [] : ["微信 release 构建尚未生成"]),
    ...(releaseQaPassed ? [] : [releaseGate ? "发布门禁报告存在，但真实试玩结论尚未通过" : "发布门禁报告尚未生成"]),
    ...(deployment ? [] : ["部署记录尚未生成"]),
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
      content: `门禁评审：${gate.label}。运维准备度：${readinessText(stageApplicable && Boolean(deployment) && Boolean(rollback) && !devopsTask?.blockers.length)}。${taskStatusText(devopsTask)} 风险：${formatList([...(devopsTask?.blockers ?? []), deployment && rollback ? "部署和回滚记录存在，但仍需确认真实凭据引用。" : "缺少部署记录或回滚方案。"])}`
    },
    {
      agentId: "liveops_analytics",
      roomKind: "studio-main",
      messageType: "review",
      content: `门禁评审：${gate.label}。LiveOps 准备度：${readinessText(stageApplicable && Boolean(deployment))}。上线后仍需观察留存、失败率、局内流失点和后续迭代优先级。`
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

function approveStageOne(kernel: StudioKernel, message: StudioMessage, now: string): void {
  ensureStageOneTasks(kernel, now);
  requireVerifiedArtifacts(kernel, ["artifact_gdd_baseline_draft", "artifact_art_bible_baseline_draft"]);
  for (const taskId of ["task_stage_1_design_clarification", "task_stage_1_art_direction", "task_stage_1_scope_review"]) {
    kernel.updateTaskStatus(taskId, "done", now);
  }
  kernel.updateTaskStatus("task_group_stage_1", "done", now);

  kernel.setStage("production", now);
  ensureArtifactStatus(kernel, "artifact_gdd_baseline_draft", "approved", now);
  ensureArtifactStatus(kernel, "artifact_art_bible_baseline_draft", "approved", now);
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

function approveFirstPlayable(kernel: StudioKernel, message: StudioMessage, now: string): void {
  requireVerifiedArtifacts(kernel, ["artifact_asset_manifest_draft", "artifact_scene_blueprint_draft", "artifact_wechat_dev_build", "artifact_qa_playtest_report"]);
  requirePassingPlaytest(kernel, "artifact_qa_playtest_report");
  for (const taskId of [
    "task_stage_2_asset_pipeline",
    "task_stage_2_cocos_implementation",
    "task_stage_2_qa_playtest",
    "task_group_stage_2"
  ]) {
    if (kernel.findTask(taskId)) {
      kernel.updateTaskStatus(taskId, "done", now);
    }
  }

  kernel.setStage("release_preparation", now);
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

function approveRelease(kernel: StudioKernel, message: StudioMessage, now: string): void {
  requireVerifiedArtifacts(kernel, [
    "artifact_wechat_release_build",
    "artifact_release_gate_report",
    "artifact_deployment_report",
    "artifact_rollback_plan",
    "artifact_release_notes"
  ]);
  requirePassingPlaytest(kernel, "artifact_release_gate_report");
  for (const taskId of [
    "task_stage_3_wechat_release",
    "task_stage_3_qa_release_gate",
    "task_stage_3_devops_deploy",
    "task_stage_3_liveops_backlog",
    "task_group_stage_3"
  ]) {
    if (kernel.findTask(taskId)) {
      kernel.updateTaskStatus(taskId, "done", now);
    }
  }

  kernel.setStage("liveops", now);
  writeProjectMemory(kernel, {
    memoryId: `mem_release_approved_${message.messageId}`,
    ownerAgent: "producer",
    type: "release_approval",
    content: "制作人已批准发布，项目进入 LiveOps 持续迭代。",
    now
  });
  writeAgentMessage(kernel, {
    agentId: "devops",
    roomKind: "release-room",
    messageType: "deployment_record",
    relatedArtifactIds: ["artifact_deployment_report", "artifact_rollback_plan"],
    content: "发布审批已记录。当前本地 MVP 已生成部署记录和回滚计划占位，真实部署将由 Secret Vault 和 DevOps 工具执行。"
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

function handleGameDesigner({ kernel, producerMessage, now }: HandlerInput): void {
  const artifactId = "artifact_gdd_baseline_draft";
  ensureArtifact(kernel, {
    artifactId,
    projectId: kernel.project.projectId,
    type: "gdd",
    path: "agents/design/gdd/00_overview.md",
    ownerAgentId: "game_designer",
    stageId: kernel.project.currentStage,
    status: "draft",
    version: 1,
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "local_agent_runtime",
      sourceIdea: producerMessage.content
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
    relatedArtifactIds: [artifactId],
    content: buildDesignOpeningQuestion(producerMessage.content)
  });
}

function handleArtDirector({ kernel, producerMessage, now }: HandlerInput): void {
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
    content: buildArtOpeningQuestion(producerMessage.content)
  });
}

function buildDesignOpeningQuestion(idea: string): string {
  const text = idea.toLowerCase();
  const questions: string[] = [];
  if (text.includes("毛线") || text.includes("线团") || text.includes("球")) {
    questions.push("毛线球的核心物理行为是什么：弹开、滚动、缠住、还是被点击后短暂停滞？");
  }
  if (text.includes("防守") || text.includes("守") || text.includes("篮")) {
    questions.push("防守失败的判定要精确到什么程度：碰到篮筐边缘、越过某条线，还是落入篮内才失败？");
  }
  if (text.includes("微信") || text.includes("小游戏")) {
    questions.push("微信小游戏首个可玩要优先验证哪件事：上手速度、单局留存、分享复玩，还是手感反馈？");
  }
  if (text.includes("可爱") || text.includes("轻松") || text.includes("治愈")) {
    questions.push("你希望玩家的主要情绪更偏轻松治愈、手忙脚乱的快乐，还是紧张但不挫败？");
  }
  if (questions.length < 3) {
    questions.push("玩家每局最核心的一句话目标是什么？");
    questions.push("玩家失败后应该立刻想再来一局，还是先看到成长/奖励反馈？");
  }

  return [
    "策划已接收 idea，我不会把立项讨论自动结束。",
    "我先围绕这个 idea 提出当前最需要制作人判断的设计问题：",
    ...questions.slice(0, 4).map((question, index) => `${index + 1}. ${question}`),
    "你可以继续补充任何细节；只有你明确发起门禁评审并二次确认后，本阶段才会进入开发落地。"
  ].join("\n");
}

function buildArtOpeningQuestion(idea: string): string {
  const text = idea.toLowerCase();
  const prompts: string[] = [];
  if (text.includes("毛线") || text.includes("猫") || text.includes("可爱")) {
    prompts.push("毛线球和场景要偏手作毛绒、扁平贴纸，还是更像柔软 3D 玩具？");
  }
  if (text.includes("轻松") || text.includes("治愈") || text.includes("可爱")) {
    prompts.push("整体色彩要偏奶油暖色、清爽浅色，还是高对比的街机糖果色？");
  }
  if (text.includes("篮球") || text.includes("篮")) {
    prompts.push("篮子/边界要明显游戏化，还是融入生活化场景让防守目标更自然？");
  }
  if (prompts.length < 3) {
    prompts.push("有没有明确参考图、参考游戏或不想出现的视觉风格？");
    prompts.push("首个可玩阶段优先保证角色识别、操作反馈，还是场景氛围？");
  }

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

function ensureStageOneTasks(kernel: StudioKernel, now: string): void {
  const projectId = kernel.project.projectId;
  const stageId: StageId = "concept_discussion";
  const groupId = "task_group_stage_1";
  const designTaskId = "task_stage_1_design_clarification";
  const artTaskId = "task_stage_1_art_direction";
  const producerTaskId = "task_stage_1_scope_review";

  ensureTask(kernel, {
    taskId: groupId,
    projectId,
    stageId,
    taskLevel: "task_group",
    ownerAgentId: "studio_orchestrator",
    title: "阶段 1：立项、机制和世界观讨论",
    description: "把制作人 idea 澄清成可执行 GDD baseline、Art Bible baseline 和第一可玩范围。",
    status: "doing",
    priority: 100,
    sortOrder: 10,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [],
    outputArtifacts: [],
    acceptanceCriteria: ["核心玩法已确认", "美术方向已确认", "第一可玩范围已确认"],
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
    title: "澄清玩法并生成 GDD baseline",
    description: "确认核心循环、单局时长、胜负条件、机制边界和第一可玩范围。",
    status: "doing",
    priority: 90,
    sortOrder: 20,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [],
    outputArtifacts: ["artifact_gdd_baseline_draft"],
    acceptanceCriteria: ["GDD baseline 已提交", "制作人完成核心玩法审批"],
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
    description: "确认视觉风格、色板、UI 可读性、资产规格方向和禁用风格。",
    status: "doing",
    priority: 80,
    sortOrder: 30,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: [],
    outputArtifacts: ["artifact_art_bible_baseline_draft"],
    acceptanceCriteria: ["Art Bible baseline 已提交", "制作人完成美术方向审批"],
    blockers: ["等待制作人提供视觉参考或风格选择"],
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
    description: "组织制作人确认核心玩法、美术方向和第一可玩范围。",
    status: "todo",
    priority: 85,
    sortOrder: 40,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_art_bible_baseline_draft"],
    outputArtifacts: [],
    acceptanceCriteria: ["制作人完成 Stage 1 审批或提交变更请求"],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });
}

function ensureStageTwoTasksAndArtifacts(kernel: StudioKernel, message: StudioMessage, now: string): void {
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
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_art_bible_baseline_draft"],
    outputArtifacts: [
      "artifact_asset_manifest_draft",
      "artifact_scene_blueprint_draft",
      "artifact_gameplay_source",
      "artifact_wechat_dev_build",
      "artifact_qa_playtest_report"
    ],
    acceptanceCriteria: ["核心循环可玩", "资产已导入", "QA 试玩报告已生成"],
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
    description: "根据 Art Bible 生成 SVG 源资产，渲染 Cocos 可直接导入的透明 PNG，并维护 asset manifest。",
    status: "doing",
    priority: 90,
    sortOrder: 110,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_art_bible_baseline_draft"],
    outputArtifacts: ["artifact_asset_manifest_draft"],
    acceptanceCriteria: ["asset manifest 存在且 runtimePath 指向 PNG", "每个 SVG 源资产都有经工具验证的同名 PNG", "关键资产符合 Art Bible"],
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
    description: "根据 GDD 定义场景层级、Prefab 边界、资源加载契约和性能预算。",
    status: "doing",
    priority: 95,
    sortOrder: 115,
    progressPercent: 10,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft"],
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
    description: "根据 GDD 和 SceneBlueprint 实现点击防守玩法、状态机和基础 UI TypeScript 代码。",
    status: "todo",
    priority: 90,
    sortOrder: 120,
    progressPercent: 50,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_gdd_baseline_draft", "artifact_scene_blueprint_draft"],
    outputArtifacts: ["artifact_gameplay_source"],
    acceptanceCriteria: ["玩法 TypeScript 源码已写入 Cocos assets/scripts", "核心循环状态机和 UI 逻辑明确"],
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
    description: "通过 Cocos 引擎桥导入资产、应用场景蓝图、生成 Prefab 并执行微信小游戏开发构建。",
    status: "todo",
    priority: 85,
    sortOrder: 125,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_asset_manifest_draft", "artifact_scene_blueprint_draft", "artifact_gameplay_source"],
    outputArtifacts: ["artifact_wechat_dev_build"],
    acceptanceCriteria: ["Cocos MCP 构建命令成功", "微信小游戏开发构建可启动"],
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
    description: "运行 Cocos MiniGame Bench，生成试玩报告、截图和 Bug 列表。",
    status: "todo",
    priority: 85,
    sortOrder: 130,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_wechat_dev_build"],
    outputArtifacts: ["artifact_qa_playtest_report"],
    acceptanceCriteria: [
      "真实 Cocos Web 构建已在 Chrome 中启动",
      "开始、运行、胜负终局和重新开始状态路径全部通过",
      "终局统计不存在 N/M/下划线等占位值",
      "文字不溢出且活动 UI 组件不存在显著重叠",
      "控制台无运行时错误",
      "截图、控制台日志和机器可读 QA 报告均已登记证据"
    ],
    blockers: [],
    createdAt: now,
    updatedAt: now
  });

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
    relatedArtifactIds: ["artifact_asset_manifest_draft"],
    content: "Stage 2 美术资产任务已排队；资产生产 Agent 必须通过工具生成资产清单和可验证输出。"
  });
  writeAgentMessage(kernel, {
    agentId: "cocos_tech_lead",
    roomKind: "engineering-room",
    messageType: "progress_update",
    relatedArtifactIds: ["artifact_scene_blueprint_draft"],
    content: "Stage 2 Cocos 架构任务已排队；场景蓝图完成后会交接给玩法程序和 Cocos 自动化。"
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
    description: "完成微信发布准备、QA 发布门禁、部署记录、回滚方案和 LiveOps backlog。",
    status: "doing",
    priority: 100,
    sortOrder: 200,
    progressPercent: 0,
    childrenSummary: emptyChildrenSummary(),
    inputArtifacts: ["artifact_wechat_dev_build", "artifact_qa_playtest_report"],
    outputArtifacts: ["artifact_wechat_release_build", "artifact_release_gate_report", "artifact_deployment_report", "artifact_rollback_plan", "artifact_release_notes"],
    acceptanceCriteria: ["发布门禁通过", "部署记录存在", "回滚方案存在", "LiveOps backlog 存在"],
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
      inputArtifacts: ["artifact_wechat_release_build"],
      outputArtifacts: ["artifact_release_gate_report"],
      acceptanceCriteria: ["真实 Cocos 试玩全状态路径通过", "不存在 blocker/critical/major 缺陷", "发布门禁证据完整"],
      blockers: [],
      createdAt: now,
      updatedAt: now
    },
    {
      taskId: "task_stage_3_devops_deploy",
      projectId,
      stageId,
      parentTaskId: groupId,
      roomId: kernel.getRoom("release-room").roomId,
      taskLevel: "task",
      ownerAgentId: "devops",
      title: "准备部署记录和回滚方案",
      description: "使用 Secret Vault 引用生成部署计划、部署记录和回滚方案。",
      status: "todo",
      priority: 85,
      sortOrder: 230,
      childrenSummary: emptyChildrenSummary(),
      inputArtifacts: ["artifact_release_gate_report"],
      outputArtifacts: ["artifact_deployment_report", "artifact_rollback_plan"],
      acceptanceCriteria: ["部署记录存在", "回滚方案存在"],
      blockers: ["等待制作人发布审批"],
      createdAt: now,
      updatedAt: now
    },
    {
      taskId: "task_stage_3_liveops_backlog",
      projectId,
      stageId,
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
      artifactId: "artifact_deployment_report",
      projectId,
      type: "deployment_report",
      path: "agents/devops/deployment-reports/deploy-001.md",
      ownerAgentId: "devops",
      stageId,
      status: "draft",
      version: 1,
      sourceTaskId: "task_stage_3_devops_deploy",
      sourceDecisionIds: [],
      metadata: { secretMode: "vault_reference_only" },
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
      sourceTaskId: "task_stage_3_devops_deploy",
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
      stageId,
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

function ensureArtifact(kernel: StudioKernel, artifact: Artifact): void {
  if (!kernel.listArtifacts().some((candidate) => candidate.artifactId === artifact.artifactId)) {
    kernel.addArtifact(artifact);
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

function requireVerifiedArtifacts(kernel: StudioKernel, artifactIds: string[]): void {
  const missing = artifactIds.filter((artifactId) => {
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId);
    return !ledger || ledger.status !== "verified" || !ledger.hash || !ledger.sizeBytes;
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

function writeEvidenceBlocker(kernel: StudioKernel, gate: GateAction, error: unknown): void {
  writeAgentMessage(kernel, {
    agentId: "studio_orchestrator",
    roomKind: "studio-main",
    messageType: "blocker",
    content: `无法执行「${gate.label}」：${error instanceof Error ? error.message : String(error)}。请等待对应 Agent 通过工具写入产物并完成 claim 验证后再确认。`
  });
}
