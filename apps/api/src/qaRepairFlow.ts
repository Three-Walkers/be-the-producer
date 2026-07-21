import { createHash } from "node:crypto";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentId, Task } from "@game-pipeline/shared-schemas";
import { readTaskPlaytestEvidence, taskOutputsVerified } from "./taskOutputEvidence.js";

const blockerPrefix = "QA_PLAYTEST_FAILED:";

export interface QaFailureOutcome {
  operationId: string;
  reason: string;
  repairAgentIds: AgentId[];
  repairTaskIds: string[];
}

export function materializeQaFailureRepairs(kernel: StudioKernel, qaTask: Task): QaFailureOutcome | undefined {
  const result = readTaskPlaytestEvidence(kernel, qaTask);
  if (!result || result.verdict === "pass") {
    return undefined;
  }
  const defects = result.defects.filter((defect) => ["blocker", "critical", "major"].includes(defect.severity));
  const effectiveDefects = defects.length > 0 ? defects : [{
    defectId: `bug_${result.operationId}_infrastructure`,
    severity: "blocker" as const,
    category: "runtime" as const,
    title: "恢复真实试玩执行能力",
    details: "QA 运行处于 blocked，必须先修复构建、浏览器或运行环境。",
    ownerAgentId: "cocos_automation" as const,
    evidencePaths: result.evidencePaths
  }];
  const now = new Date().toISOString();
  const parentTaskId = kernel.findTask("task_group_stage_2")?.taskId ?? kernel.findTask("task_group_stage_3")?.taskId;
  const repairAgentIds = new Set<AgentId>();
  const repairTaskIds: string[] = [];

  for (const defect of effectiveDefects) {
    repairAgentIds.add(defect.ownerAgentId);
    const fingerprint = createHash("sha1").update(`${result.operationId}:${defect.defectId}`).digest("hex").slice(0, 12);
    const taskId = `task_qa_repair_${fingerprint}`;
    const artifactId = `artifact_qa_repair_${fingerprint}`;
    repairTaskIds.push(taskId);
    const outputPath = `${repairWorkspace(defect.ownerAgentId)}/${defect.defectId}.md`;
    if (!kernel.findTask(taskId)) {
      kernel.addTask({
        taskId,
        projectId: kernel.project.projectId,
        stageId: kernel.project.currentStage,
        ...(parentTaskId ? { parentTaskId } : {}),
        roomId: repairRoomId(kernel, defect.ownerAgentId),
        taskLevel: "task",
        ownerAgentId: defect.ownerAgentId,
        title: `修复 QA：${defect.title}`,
        description: `[playtest:${result.operationId}] ${defect.details}。必须修改真实工程源文件，并在修复记录中列出变更文件和验证方式；只写修复说明不算完成。证据：${defect.evidencePaths.join("、") || "见 QA 报告"}`,
        status: "todo",
        priority: defect.severity === "blocker" ? 100 : defect.severity === "critical" ? 95 : 90,
        sortOrder: 500,
        progressPercent: 0,
        childrenSummary: { doing: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 },
        inputArtifacts: qaTask.outputArtifacts,
        outputArtifacts: [artifactId],
        acceptanceCriteria: [
          "真实 Cocos 工程源文件已通过工具修改并登记证据",
          `缺陷已处理：${defect.title}`,
          "修复记录列出修改文件、原因和复测关注点"
        ],
        blockers: [],
        createdAt: now,
        updatedAt: now
      });
    }
    if (!kernel.listArtifacts().some((artifact) => artifact.artifactId === artifactId)) {
      kernel.addArtifact({
        artifactId,
        projectId: kernel.project.projectId,
        type: "bug_report",
        path: outputPath,
        ownerAgentId: defect.ownerAgentId,
        stageId: kernel.project.currentStage,
        status: "draft",
        version: 1,
        sourceTaskId: taskId,
        sourceDecisionIds: [],
        metadata: {
          playtestOperationId: result.operationId,
          playtestDefectId: defect.defectId,
          severity: defect.severity,
          category: defect.category
        },
        createdAt: now,
        updatedAt: now
      });
    }
  }

  writeQaFailureMessages(kernel, qaTask, result, repairTaskIds);

  return {
    operationId: result.operationId,
    reason: `${blockerPrefix}${result.operationId}: 真实试玩结论为 ${result.verdict}，${effectiveDefects.length} 个阻断缺陷已回流到责任 Agent。`,
    repairAgentIds: [...repairAgentIds],
    repairTaskIds
  };
}

export function resumeQaTasksAfterVerifiedRepairs(kernel: StudioKernel): void {
  const now = new Date().toISOString();
  for (const qaTask of kernel.listTasks().filter((task) => task.ownerAgentId === "qa_evaluator" && task.status === "blocked")) {
    const blocker = qaTask.blockers.find((item) => item.startsWith(blockerPrefix));
    const operationId = blocker?.slice(blockerPrefix.length).split(":")[0]?.trim();
    if (!operationId) continue;
    const repairTasks = kernel.listTasks().filter((task) => task.description.includes(`[playtest:${operationId}]`));
    if (repairTasks.length === 0 || !repairTasks.every((task) => ["review", "done"].includes(task.status) && taskOutputsVerified(kernel, task))) {
      continue;
    }
    kernel.updateTask(qaTask.taskId, {
      status: "doing",
      progressPercent: 65,
      blockers: qaTask.blockers.filter((item) => !item.startsWith(blockerPrefix)),
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(qaTask.ownerAgentId, {
      status: "queued",
      taskId: qaTask.taskId,
      lastError: undefined,
      updatedAt: now
    });
  }
}

function repairWorkspace(agentId: AgentId): string {
  switch (agentId) {
    case "art_director":
      return "agents/art/qa-repairs";
    case "cocos_automation":
      return "agents/cocos-automation/qa-repairs";
    case "cocos_tech_lead":
    case "gameplay_programmer":
    default:
      return "agents/engineering/qa-repairs";
  }
}

function repairRoomId(kernel: StudioKernel, agentId: AgentId): string {
  const kind = agentId === "art_director" ? "art-room" : "engineering-room";
  return kernel.getRoom(kind).roomId;
}

function writeQaFailureMessages(
  kernel: StudioKernel,
  qaTask: Task,
  result: NonNullable<ReturnType<typeof readTaskPlaytestEvidence>>,
  repairTaskIds: string[]
): void {
  const seriousDefects = result.defects.filter((defect) => ["blocker", "critical", "major"].includes(defect.severity));
  const relatedArtifactIds = qaTask.outputArtifacts;
  writePlaytestMessageOnce(kernel, {
    operationId: result.operationId,
    marker: "qa_failure",
    roomId: kernel.getRoom("qa-room").roomId,
    messageType: "qa_failure",
    mentions: [...new Set(seriousDefects.map((defect) => defect.ownerAgentId))],
    relatedTaskIds: [qaTask.taskId, ...repairTaskIds],
    relatedArtifactIds,
    content: [
      `真实 Cocos 试玩未通过：${result.operationId}。QA 任务已阻塞，不能进入首个可玩或发布门禁。`,
      ...seriousDefects.map((defect) => `- [${defect.severity}] ${defect.title}：${defect.details}；责任角色：@${defect.ownerAgentId}；证据：${defect.evidencePaths.join("、") || "见 QA 报告"}`)
    ].join("\n")
  });

  for (const agentId of [...new Set(seriousDefects.map((defect) => defect.ownerAgentId))]) {
    const defects = seriousDefects.filter((defect) => defect.ownerAgentId === agentId);
    const taskIds = repairTaskIds.filter((taskId) => kernel.findTask(taskId)?.ownerAgentId === agentId);
    writePlaytestMessageOnce(kernel, {
      operationId: result.operationId,
      marker: `handoff_${agentId}`,
      roomId: repairRoomId(kernel, agentId),
      messageType: "handoff",
      mentions: [agentId],
      relatedTaskIds: taskIds,
      relatedArtifactIds,
      content: [
        `@${agentId}，QA 将真实试玩缺陷交接给你处理。修复任务已经进入当前房间，完成前 QA 保持阻塞。`,
        ...defects.map((defect) => `- ${defect.title}：${defect.details}；证据：${defect.evidencePaths.join("、") || "见 QA 报告"}`),
        "必须修改真实 Cocos 工程文件并登记 Artifact Ledger；只回复已修复或只写说明不能关闭任务。修复证据通过后系统会自动重新运行 QA。"
      ].join("\n")
    });
  }
}

function writePlaytestMessageOnce(
  kernel: StudioKernel,
  input: {
    operationId: string;
    marker: string;
    roomId: string;
    messageType: "qa_failure" | "handoff";
    mentions: AgentId[];
    relatedTaskIds: string[];
    relatedArtifactIds: string[];
    content: string;
  }
): void {
  const exists = kernel.listMessages().some((message) =>
    message.metadata.playtestOperationId === input.operationId && message.metadata.qaNotification === input.marker
  );
  if (exists) return;
  const now = new Date().toISOString();
  kernel.recordMessage({
    messageId: `msg_qa_${input.marker}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: kernel.project.projectId,
    roomId: input.roomId,
    senderType: "agent",
    senderId: "qa_evaluator",
    messageType: input.messageType,
    content: input.content,
    mentions: input.mentions,
    relatedTaskIds: input.relatedTaskIds,
    relatedArtifactIds: input.relatedArtifactIds,
    metadata: {
      generatedBy: "qa_result_ingestion",
      playtestOperationId: input.operationId,
      qaNotification: input.marker
    },
    createdAt: now
  });
}
