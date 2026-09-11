import type { Artifact } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";

/** These are bridge implementation details, not independently promised game
 * deliverables. The canonical build validates its import receipt and full output
 * manifest; a historical import/scene operation must not become another gate. */
export function isCocosBuildSupportingArtifact(artifact: Artifact): boolean {
  if (artifact.ownerAgentId !== "cocos_automation" || artifact.sourceTaskId !== "task_stage_2_cocos_build" ||
      artifact.artifactId === "artifact_wechat_dev_build") return false;
  return /^(agents\/cocos-automation\/(validation|imports|scene-ops|build-ops|cocos-build-logs)\/|assets\/resources\/(btp|btp-art)\/|assets\/scripts\/btp\/|assets\/scenes\/)/.test(artifact.path);
}

export function reconcileCocosSupportingEvidence(kernel: StudioKernel): void {
  const task = kernel.findTask("task_stage_2_cocos_build");
  if (!task || task.stageId !== kernel.project.currentStage || task.status === "cancelled") return;
  const supporting = kernel.listArtifacts().filter(isCocosBuildSupportingArtifact);
  for (const artifact of supporting) {
    if (artifact.metadata.evidenceRole === "supporting") continue;
    kernel.upsertArtifact({ ...artifact, metadata: { ...artifact.metadata, evidenceRole: "supporting" } });
  }
  const ids = new Set(supporting.map((artifact) => artifact.artifactId));
  const outputs = task.outputArtifacts.filter((id) => !ids.has(id));
  if (outputs.length !== task.outputArtifacts.length) {
    kernel.updateTask(task.taskId, { outputArtifacts: outputs, updatedAt: new Date().toISOString() });
  }
}
