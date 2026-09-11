import { createHash } from "node:crypto";
import { workflowTaskStages, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentId, Artifact, MemoryRecord, Task } from "@game-pipeline/shared-schemas";
import { materializeQaFailureRepairs, resumeQaTasksAfterVerifiedRepairs } from "./qaRepairFlow.js";
import { readVerifiedQaPlaytestReceipts, type QaPlaytestReceipt } from "./qaPlaytestReceipt.js";
import { captureCurrentTaskInputProvenance, taskOutputsVerified } from "./taskOutputEvidence.js";
import { resolveProjectWorkspaceRoot } from "./workspaceWriter.js";

export interface QaResultIngestionOutcome {
  processedOperationIds: string[];
  failedOperationIds: string[];
  queuedAgentIds: AgentId[];
}

const stalePlaytestError = "上一轮 QA 评审缺少有效 run_playtest 收据或当前文件 hash 不一致，已强制重新试玩。";

function isPlaytestExecutionTask(kernel: StudioKernel, task: Task): boolean {
  return task.ownerAgentId === "qa_evaluator" && task.taskLevel !== "task_group" && task.outputArtifacts.some((id) =>
    kernel.listArtifacts().some((artifact) => artifact.artifactId === id && artifact.type === "qa_report" &&
      artifact.ownerAgentId === task.ownerAgentId && artifact.sourceTaskId === task.taskId));
}

export function reconcileQaPlaytestResults(kernel: StudioKernel): QaResultIngestionOutcome {
  const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
  const processedOperationIds: string[] = [];
  const failedOperationIds: string[] = [];
  const queuedAgentIds = new Set<AgentId>();
  const executionStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const oldState = kernel.getAgentLoopState().agents.qa_evaluator;
  const oldTask = oldState?.taskId ? kernel.findTask(oldState.taskId) : undefined;
  if (oldState?.lastError === stalePlaytestError && oldTask && !isPlaytestExecutionTask(kernel, oldTask) && oldTask.status === "done") {
    kernel.updateAgentLoopAgent("qa_evaluator", { status: "waiting", lastError: undefined, updatedAt: new Date().toISOString() });
  }

  for (const receipt of readVerifiedQaPlaytestReceipts(projectRoot)) {
    if (wasReceiptProcessed(kernel, receipt.operationId)) {
      continue;
    }
    const qaTask = findQaTask(kernel, receipt);
    if (!qaTask) {
      continue;
    }
    if (!receiptInputsMatchCurrentTask(kernel, qaTask, receipt)) {
      continue;
    }
    const reportArtifactId = registerReceiptEvidence(kernel, qaTask, receipt);
    if (receipt.result.verdict !== "pass") {
      const failure = materializeQaFailureRepairs(kernel, qaTask);
      if (failure) {
        kernel.updateTask(qaTask.taskId, {
          status: "blocked",
          progressPercent: Math.max(50, qaTask.progressPercent ?? 0),
          blockers: [
            ...qaTask.blockers.filter((blocker) => !blocker.startsWith("QA_PLAYTEST_FAILED:")),
            failure.reason
          ],
          updatedAt: receipt.result.completedAt
        });
        kernel.updateAgentLoopAgent(qaTask.ownerAgentId, {
          status: "blocked",
          taskId: qaTask.taskId,
          lastError: failure.reason,
          updatedAt: receipt.result.completedAt
        });
        for (const agentId of failure.repairAgentIds) {
          queuedAgentIds.add(agentId);
          kernel.updateAgentLoopAgent(agentId, {
            status: "queued",
            iteration: kernel.getAgentLoopState().iteration,
            updatedAt: receipt.result.completedAt
          });
        }
      }
      failedOperationIds.push(receipt.operationId);
    }
    writeIngestionMemory(kernel, receipt, reportArtifactId);
    processedOperationIds.push(receipt.operationId);
  }

  resumeQaTasksAfterVerifiedRepairs(kernel);
  for (const task of kernel.listTasks().filter((candidate) =>
    isPlaytestExecutionTask(kernel, candidate) &&
    executionStages.has(candidate.stageId) &&
    ["review", "done"].includes(candidate.status)
  )) {
    if (taskOutputsVerified(kernel, task)) {
      kernel.updateAgentLoopAgent(task.ownerAgentId, {
        status: "waiting",
        taskId: task.taskId,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      });
      continue;
    }
    const now = new Date().toISOString();
    kernel.updateTask(task.taskId, {
      status: "doing",
      progressPercent: 65,
      blockers: [],
      updatedAt: now
    });
    kernel.updateAgentLoopAgent(task.ownerAgentId, {
      status: "queued",
      taskId: task.taskId,
      lastError: stalePlaytestError,
      updatedAt: now
    });
    queuedAgentIds.add(task.ownerAgentId);
  }
  for (const task of kernel.listTasks().filter((candidate) =>
    isPlaytestExecutionTask(kernel, candidate) &&
    executionStages.has(candidate.stageId) &&
    ["todo", "doing"].includes(candidate.status)
  )) {
    if (taskOutputsVerified(kernel, task)) {
      kernel.updateTask(task.taskId, {
        status: "review",
        progressPercent: 90,
        blockers: [],
        updatedAt: new Date().toISOString()
      });
    }
  }

  return {
    processedOperationIds,
    failedOperationIds,
    queuedAgentIds: [...queuedAgentIds]
  };
}

function receiptInputsMatchCurrentTask(kernel: StudioKernel, task: Task, receipt: QaPlaytestReceipt): boolean {
  try {
    const expected = captureCurrentTaskInputProvenance(kernel, task);
    const actual = [...(receipt.taskInputEvidence ?? [])].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    return JSON.stringify(expected) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

function findQaTask(kernel: StudioKernel, receipt: QaPlaytestReceipt): Task | undefined {
  const executionStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const eligible = (task: Task) => isPlaytestExecutionTask(kernel, task) && executionStages.has(task.stageId) && task.status !== "cancelled";
  const reportArtifact = kernel.listArtifacts().find((artifact) => artifact.path === receipt.reportPath && artifact.ownerAgentId === "qa_evaluator");
  if (reportArtifact?.sourceTaskId) {
    const task = kernel.findTask(reportArtifact.sourceTaskId);
    if (task && eligible(task)) return task;
  }
  return kernel.listTasks().find((task) =>
    eligible(task) &&
    task.outputArtifacts.some((artifactId) => kernel.listArtifacts().some((artifact) => artifact.artifactId === artifactId && artifact.path === receipt.reportPath))
  );
}

function registerReceiptEvidence(kernel: StudioKernel, qaTask: Task, receipt: QaPlaytestReceipt): string {
  const now = receipt.result.completedAt;
  let reportArtifactId = "";
  for (const evidence of receipt.evidence) {
    // Build bytes remain hash-bound in the receipt; do not expand the task
    // ledger with a deliverable for each engine bundle or imported texture.
    if (evidence.path !== receipt.reportPath && !evidence.path.startsWith("agents/qa/playtest-runs/")) continue;
    const existing = kernel.listArtifacts().find((artifact) => artifact.path === evidence.path);
    const isReport = evidence.path === receipt.reportPath;
    const artifact = kernel.upsertArtifact({
      artifactId: existing?.artifactId ?? stableEvidenceArtifactId(kernel.project.projectId, receipt.operationId, evidence.path),
      projectId: kernel.project.projectId,
      type: existing?.type ?? (isReport ? "qa_report" : "asset"),
      path: evidence.path,
      ownerAgentId: "qa_evaluator",
      stageId: kernel.project.currentStage,
      status: receipt.result.verdict === "pass" ? "submitted" : "change_requested",
      version: (existing?.version ?? 0) + 1,
      sourceTaskId: qaTask.taskId,
      sourceDecisionIds: existing?.sourceDecisionIds ?? [],
      metadata: {
        ...(existing?.metadata ?? {}),
        generatedBy: "qa_result_ingestion",
        nativeHarnessManaged: true,
        ...(!isReport ? { evidenceRole: "supporting" } : {}),
        toolName: "run_playtest",
        toolExecutedAt: now,
        playtestOperationId: receipt.operationId,
        playtestVerdict: receipt.result.verdict,
        playtestChecks: receipt.result.checks,
        playtestDefects: receipt.result.defects,
        playtestEvidencePaths: receipt.result.evidencePaths,
        playtestRuntime: receipt.result.runtime,
        ...(receipt.result.schemaVersion === 2 ? { playtestSchemaVersion: 2 } : {}),
        ...(receipt.result.contract ? { playtestContract: receipt.result.contract } : {}),
        ...(receipt.result.scenarios ? { playtestScenarios: receipt.result.scenarios } : {}),
        playtestTaskInputEvidence: receipt.taskInputEvidence ?? []
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    kernel.recordArtifactMaterialization(artifact.artifactId, {
      path: evidence.path,
      hash: evidence.hash,
      sizeBytes: evidence.sizeBytes,
      materializedAt: now
    });
    if (isReport) reportArtifactId = artifact.artifactId;
  }
  if (!reportArtifactId) {
    throw new Error(`QA 结果 ${receipt.operationId} 未登记主报告。`);
  }
  return reportArtifactId;
}

function writeIngestionMemory(kernel: StudioKernel, receipt: QaPlaytestReceipt, reportArtifactId: string): void {
  const memoryId = ingestionMemoryId(receipt.operationId);
  if (kernel.memory.list(kernel.project.projectId).some((record) => record.memoryId === memoryId)) {
    return;
  }
  const record: MemoryRecord = {
    memoryId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    scope: "qa",
    ownerAgent: "qa_evaluator",
    type: "playtest_result_ingested",
    status: "active",
    content: `真实试玩 ${receipt.operationId} 已摄取，verdict=${receipt.result.verdict}，严重缺陷=${receipt.result.defects.filter((defect) => ["blocker", "critical", "major"].includes(defect.severity)).length}。`,
    sourceArtifactId: reportArtifactId,
    createdAt: receipt.result.completedAt,
    updatedAt: receipt.result.completedAt
  };
  kernel.writeMemory(record);
}

function wasReceiptProcessed(kernel: StudioKernel, operationId: string): boolean {
  return kernel.memory.list(kernel.project.projectId).some((record) => record.memoryId === ingestionMemoryId(operationId));
}

function ingestionMemoryId(operationId: string): string {
  return `mem_qa_playtest_ingested_${operationId}`;
}

function stableEvidenceArtifactId(projectId: string, operationId: string, path: string): string {
  return `artifact_qa_${createHash("sha1").update(`${projectId}:${operationId}:${path}`).digest("hex").slice(0, 16)}`;
}
