import type { GateEvidencePolicy, StudioKernel } from "@game-pipeline/agent-runtime";
import { artifactReadyForConsumption, directoryManifestIsCurrent, readTaskPlaytestEvidence, taskOutputsVerified } from "./taskOutputEvidence.js";
import { hashWorkspaceFile, resolveWorkspacePathTarget } from "./workspaceWriter.js";

/** API adapter for the runtime's evidence-policy port. */
export const apiGateEvidencePolicy: GateEvidencePolicy = {
  assertGateEvidence(kernel, requirement): void {
    const rejectedArtifacts = requirement.requiredArtifactIds.filter(
      (artifactId) => !artifactHasCurrentConsumableEvidence(kernel, artifactId)
    );
    if (rejectedArtifacts.length > 0) {
      throw new Error(`缺少当前且可消费的产物证据：${rejectedArtifacts.join("、")}`);
    }

    if (!requirement.qaTaskId) {
      return;
    }
    const qaTask = kernel.findTask(requirement.qaTaskId);
    if (!qaTask) {
      throw new Error(`缺少 QA 门禁任务：${requirement.qaTaskId}`);
    }
    if (requirement.qaReportArtifactId && !qaTask.outputArtifacts.includes(requirement.qaReportArtifactId)) {
      throw new Error(`QA 门禁任务未声明报告产物：${requirement.qaReportArtifactId}`);
    }
    if (!taskOutputsVerified(kernel, qaTask)) {
      throw new Error(`QA 门禁任务证据未通过受保护收据校验：${requirement.qaTaskId}`);
    }
    const playtestEvidence = readTaskPlaytestEvidence(kernel, qaTask);
    if (playtestEvidence?.schemaVersion !== 2) {
      throw new Error(`QA 门禁任务必须使用绑定当前 PlaytestContract 的 v2 收据：${requirement.qaTaskId}`);
    }
  }
};

function artifactHasCurrentConsumableEvidence(kernel: StudioKernel, artifactId: string): boolean {
  if (!artifactReadyForConsumption(kernel, artifactId)) {
    return false;
  }
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  if (!artifact || !ledger?.hash || ledger.sizeBytes === undefined || ledger.status !== "verified") {
    return false;
  }
  if (artifact.type === "build" && !directoryManifestIsCurrent(kernel, ledger.directoryManifest)) {
    return false;
  }
  const registeredPath = artifact.path.replace(/\/+$/, "");
  const evidencePath = ledger.path.replace(/\/+$/, "");
  const evidenceIsDescendant = evidencePath.startsWith(`${registeredPath}/`);
  if (evidencePath !== registeredPath && !evidenceIsDescendant) {
    return false;
  }
  try {
    if (evidenceIsDescendant) {
      const registeredTarget = resolveWorkspacePathTarget(kernel.project.projectId, registeredPath);
      if (!registeredTarget.exists || registeredTarget.type !== "directory") {
        return false;
      }
    }
    const target = resolveWorkspacePathTarget(kernel.project.projectId, evidencePath);
    return Boolean(
      target.exists &&
      target.type === "file" &&
      target.sizeBytes === ledger.sizeBytes &&
      hashWorkspaceFile(target.absolutePath) === ledger.hash
    );
  } catch {
    return false;
  }
}
