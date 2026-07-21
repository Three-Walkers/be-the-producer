import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type { Task } from "@game-pipeline/shared-schemas";
import { readArtifactContentForModel } from "./workspaceWriter.js";
import { hashWorkspaceFile, resolveWorkspacePathTarget } from "./workspaceWriter.js";
import type { PlaytestReportEvidence } from "./playtestEvidence.js";

const requiredPlaytestChecks = [
  "launch",
  "start_flow",
  "terminal_flow",
  "hud_runtime_values",
  "dynamic_values",
  "text_fit",
  "terminal_panel_state",
  "label_overlap",
  "terminal_exclusivity",
  "viewport_fit",
  "restart_control",
  "restart_flow",
  "console_errors"
];

export function requiredRuntimePngPaths(kernel: StudioKernel, task: Task): string[] {
  if (task.ownerAgentId !== "asset_production") {
    return [];
  }
  return task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId)?.path)
    .filter((path): path is string => Boolean(path?.toLowerCase().endsWith(".svg")))
    .map((path) => path.replace(/\.svg$/i, ".png"));
}

export function expectedHarnessOutputPaths(kernel: StudioKernel, task: Task): string[] {
  const registeredPaths = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId)?.path)
    .filter((path): path is string => Boolean(path));
  return [...new Set([...registeredPaths, ...requiredRuntimePngPaths(kernel, task)])];
}

export function taskOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  if (task.outputArtifacts.length === 0) {
    return false;
  }
  const artifacts = kernel.listArtifacts();
  const ledger = kernel.listArtifactLedger();
  const registeredOutputsVerified = task.outputArtifacts.every((artifactId) => {
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    const evidence = ledger.find((candidate) => candidate.artifactId === artifactId);
    return Boolean(artifact?.metadata.toolExecutedAt && evidence?.status === "verified");
  });
  if (!registeredOutputsVerified) {
    return false;
  }

  if (task.ownerAgentId === "qa_evaluator") {
    return qaPlaytestOutputsVerified(kernel, task);
  }
  if (task.taskId.startsWith("task_qa_repair_")) {
    return qaRepairOutputsVerified(kernel, task);
  }

  const runtimePngPaths = requiredRuntimePngPaths(kernel, task);
  if (runtimePngPaths.length === 0) {
    return true;
  }
  const pngEvidenceVerified = runtimePngPaths.every((path) => {
    const artifact = artifacts.find((candidate) => candidate.path === path);
    const evidence = artifact ? ledger.find((candidate) => candidate.artifactId === artifact.artifactId) : undefined;
    return Boolean(artifact?.metadata.toolExecutedAt && evidence?.status === "verified");
  });
  if (!pngEvidenceVerified) {
    return false;
  }
  const manifest = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "asset_manifest");
  const manifestContent = manifest ? readArtifactContentForModel(kernel.project.projectId, manifest, 1_000_000) : undefined;
  return Boolean(manifestContent && runtimePngPaths.every((path) => manifestContent.includes(path)));
}

export function readTaskPlaytestEvidence(kernel: StudioKernel, task: Task): PlaytestReportEvidence | undefined {
  const artifacts = kernel.listArtifacts();
  const report = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "qa_report" && artifact.path.endsWith(".md"));
  if (!report) {
    return undefined;
  }
  if (!report || report.metadata.generatedBy !== "qa_result_ingestion") {
    return undefined;
  }
  const operationId = typeof report.metadata.playtestOperationId === "string" ? report.metadata.playtestOperationId : undefined;
  const verdict = report.metadata.playtestVerdict;
  const checks = report.metadata.playtestChecks;
  const defects = report.metadata.playtestDefects;
  const evidencePaths = report.metadata.playtestEvidencePaths;
  const runtime = report.metadata.playtestRuntime;
  if (
    !operationId ||
    !["pass", "fail", "blocked"].includes(String(verdict)) ||
    !Array.isArray(checks) ||
    !Array.isArray(defects) ||
    !Array.isArray(evidencePaths) ||
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime)
  ) {
    return undefined;
  }
  return {
    operationId,
    verdict: verdict as PlaytestReportEvidence["verdict"],
    completedAt: typeof report.metadata.toolExecutedAt === "string" ? report.metadata.toolExecutedAt : report.updatedAt,
    checks: checks as PlaytestReportEvidence["checks"],
    defects: defects as PlaytestReportEvidence["defects"],
    evidencePaths: evidencePaths.filter((path): path is string => typeof path === "string"),
    runtime: runtime as PlaytestReportEvidence["runtime"]
  };
}

function qaPlaytestOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  const result = readTaskPlaytestEvidence(kernel, task);
  const report = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "qa_report");
  const provenByPlaytestTool = report?.metadata.generatedBy === "qa_result_ingestion" && report.metadata.toolName === "run_playtest";
  if (!result || !report || !provenByPlaytestTool || !artifactMatchesLedger(kernel, report.artifactId, report.path) || result.verdict !== "pass") {
    return false;
  }
  if (result.defects.some((defect) => ["blocker", "critical", "major"].includes(defect.severity))) {
    return false;
  }
  if (!requiredPlaytestChecks.every((checkId) => result.checks.some((check) => check.checkId === checkId && check.status === "passed"))) {
    return false;
  }
  const artifacts = kernel.listArtifacts();
  return result.evidencePaths.length >= 4 && result.evidencePaths.every((path) => {
    const artifact = artifacts.find((candidate) => candidate.path === path);
    return Boolean(artifact?.metadata.toolExecutedAt && artifactMatchesLedger(kernel, artifact.artifactId, path));
  });
}

function artifactMatchesLedger(kernel: StudioKernel, artifactId: string, path: string): boolean {
  const target = resolveWorkspacePathTarget(kernel.project.projectId, path);
  const evidence = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  return target.exists && target.type === "file" && Boolean(
    evidence?.status === "verified" &&
    evidence.hash === hashWorkspaceFile(target.absolutePath) &&
    evidence.sizeBytes === target.sizeBytes
  );
}

function qaRepairOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  const artifacts = kernel.listArtifacts();
  const ledger = kernel.listArtifactLedger();
  return task.outputArtifacts.some((artifactId) => {
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact || artifact.path.includes("/qa-repairs/")) {
      return false;
    }
    const evidence = ledger.find((candidate) => candidate.artifactId === artifact.artifactId);
    const materializedAt = evidence?.materializedAt ? Date.parse(evidence.materializedAt) : 0;
    return Boolean(
      artifact.metadata.toolExecutedAt &&
      evidence?.status === "verified" &&
      materializedAt >= Date.parse(task.createdAt) &&
      (/^(assets|settings)\//.test(artifact.path) || /^agents\/(engineering|art|cocos-automation)\//.test(artifact.path))
    );
  });
}
