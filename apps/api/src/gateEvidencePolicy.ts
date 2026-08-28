import type { GateEvidencePolicy, StudioKernel } from "@game-pipeline/agent-runtime";
import {
  artifactReadyForConsumption,
  directoryManifestIsCurrent,
  readTaskPlaytestEvidence,
  stageOneCanonicalArtifactIdentityMismatch,
  taskOutputsVerified
} from "./taskOutputEvidence.js";
import { hashWorkspaceFile, resolveWorkspacePathTarget } from "./workspaceWriter.js";
import {
  qualityReviewContractForArtifact,
  qualityReviewReadyForGate
} from "./qualityReviewArtifacts.js";
import { assertProductionAuditReadyForGate, reconcileProductionAudit } from "./productionAudit.js";
import { reconcileInvalidQualityReviewEvidence } from "./evidenceReconciliation.js";

/** API adapter for the runtime's evidence-policy port. */
export const apiGateEvidencePolicy: GateEvidencePolicy = {
  assertGateEvidence(kernel, requirement): void {
    // Gate attempts are also a repair trigger for receipts created by older
    // runtimes that accepted unresolvable locators. The invalid receipt remains
    // rejected, while its reviewer task is immediately queued for regeneration.
    const qualityReviewRepair = reconcileInvalidQualityReviewEvidence(kernel);
    const audit = reconcileProductionAudit(kernel, {
      trigger: requirement.gateActionId === "release" ? "release_gate" : "stage_gate",
      triggerRef: `gate:${requirement.gateActionId}:${requirement.phase}:r${kernel.getWorkflowSnapshot().revision}`,
      gateActionId: requirement.gateActionId,
      phase: requirement.phase,
      requiredArtifactIds: requirement.requiredArtifactIds,
      ...(requirement.qaTaskId ? { qaTaskId: requirement.qaTaskId } : {}),
      ...(requirement.qaReportArtifactId ? { qaReportArtifactId: requirement.qaReportArtifactId } : {})
    });
    const canonicalIdentityMismatches = requirement.requiredArtifactIds.flatMap((artifactId) => {
      const mismatch = stageOneCanonicalArtifactIdentityMismatch(kernel, artifactId);
      return mismatch ? [`${artifactId}（${mismatch}）`] : [];
    });
    if (canonicalIdentityMismatches.length > 0) {
      throw new Error(`Stage 1 canonical 产物身份不匹配：${canonicalIdentityMismatches.join("、")}`);
    }

    const rejectedQualityReviews = requirement.requiredArtifactIds.flatMap((artifactId) => {
      if (!qualityReviewContractForArtifact(artifactId)) return [];
      const result = qualityReviewReadyForGate(kernel, artifactId, true);
      return result.ok ? [] : [`${artifactId}（${result.reason ?? "quality review 未通过"}）`];
    });
    if (rejectedQualityReviews.length > 0) {
      throw new Error(
        `独立质量审查必须绑定当前产物且 verdict=pass：${rejectedQualityReviews.join("、")}` +
        (qualityReviewRepair.taskIds.length > 0
          ? `。系统已将无效审查退回复审并重新排队：${qualityReviewRepair.taskIds.join("、")}`
          : "")
      );
    }

    const rejectedArtifacts = requirement.requiredArtifactIds.filter(
      (artifactId) => !artifactHasCurrentConsumableEvidence(kernel, artifactId)
    );
    if (rejectedArtifacts.length > 0) {
      throw new Error(`缺少当前且可消费的产物证据：${rejectedArtifacts.join("、")}`);
    }

    if (requirement.qaTaskId) {
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

    assertProductionAuditReadyForGate(audit.run);
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
