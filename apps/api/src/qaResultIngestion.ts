import { createHash } from "node:crypto";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentId, Artifact, MemoryRecord, Task } from "@game-pipeline/shared-schemas";
import { materializeQaFailureRepairs, resumeQaTasksAfterVerifiedRepairs } from "./qaRepairFlow.js";
import { readVerifiedQaPlaytestReceipts, type QaPlaytestReceipt } from "./qaPlaytestReceipt.js";
import { taskOutputsVerified } from "./taskOutputEvidence.js";
import { resolveProjectWorkspaceRoot } from "./workspaceWriter.js";

export interface QaResultIngestionOutcome {
  processedOperationIds: string[];
  failedOperationIds: string[];
  queuedAgentIds: AgentId[];
}

export function reconcileQaPlaytestResults(kernel: StudioKernel): QaResultIngestionOutcome {
  const projectRoot = resolveProjectWorkspaceRoot(kernel.project.projectId);
  const processedOperationIds: string[] = [];
  const failedOperationIds: string[] = [];
  const queuedAgentIds = new Set<AgentId>();

  for (const receipt of readVerifiedQaPlaytestReceipts(projectRoot)) {
    if (wasReceiptProcessed(kernel, receipt.operationId)) {
      continue;
    }
    const qaTask = findQaTask(kernel, receipt);
    if (!qaTask) {
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
    candidate.ownerAgentId === "qa_evaluator" &&
    candidate.stageId === kernel.project.currentStage &&
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
      lastError: "上一轮 QA 评审缺少有效 run_playtest 收据或当前文件 hash 不一致，已强制重新试玩。",
      updatedAt: now
    });
    queuedAgentIds.add(task.ownerAgentId);
  }
  for (const task of kernel.listTasks().filter((candidate) => candidate.ownerAgentId === "qa_evaluator" && ["todo", "doing"].includes(candidate.status))) {
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

function findQaTask(kernel: StudioKernel, receipt: QaPlaytestReceipt): Task | undefined {
  const reportArtifact = kernel.listArtifacts().find((artifact) => artifact.path === receipt.reportPath && artifact.ownerAgentId === "qa_evaluator");
  if (reportArtifact?.sourceTaskId) {
    const task = kernel.findTask(reportArtifact.sourceTaskId);
    if (task) return task;
  }
  return kernel.listTasks().find((task) =>
    task.ownerAgentId === "qa_evaluator" &&
    task.stageId === kernel.project.currentStage &&
    task.taskLevel !== "task_group" &&
    task.outputArtifacts.some((artifactId) => kernel.listArtifacts().some((artifact) => artifact.artifactId === artifactId && artifact.path === receipt.reportPath))
  );
}

function registerReceiptEvidence(kernel: StudioKernel, qaTask: Task, receipt: QaPlaytestReceipt): string {
  const now = receipt.result.completedAt;
  let reportArtifactId = "";
  for (const evidence of receipt.evidence) {
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
        toolName: "run_playtest",
        toolExecutedAt: now,
        playtestOperationId: receipt.operationId,
        playtestVerdict: receipt.result.verdict,
        playtestChecks: receipt.result.checks,
        playtestDefects: receipt.result.defects,
        playtestEvidencePaths: receipt.result.evidencePaths,
        playtestRuntime: receipt.result.runtime
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
