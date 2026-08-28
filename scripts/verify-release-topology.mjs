import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  LocalAgentRuntime,
  workflowTaskStages
} from "../packages/agent-runtime/dist/index.js";
import { inferArtifactType } from "../apps/api/dist/toolExecutor.js";

const projectId = "game_release_topology_test";
const seed = createStudioKernel(projectId, "Release topology", "producer_test", "test idea");
const seedSnapshot = seed.toSnapshot();
const kernel = createStudioKernelFromSnapshot({
  ...seedSnapshot,
  project: {
    ...seedSnapshot.project,
    currentStage: "production",
    updatedAt: "2026-08-13T08:00:00.000Z"
  },
  workflow: undefined
});
const runtime = new LocalAgentRuntime();
assert.equal(inferArtifactType("devops", "agents/devops/deployment-plans/deploy-plan-001.md"), "deployment_plan");
assert.equal(inferArtifactType("devops", "agents/devops/deployment-reports/deploy-001.md"), "deployment_report");

for (const evidence of [
  ["artifact_game_contract_draft", "game_contract", "agents/design/contracts/game-contract.json"],
  ["artifact_asset_manifest_draft", "asset_manifest", "agents/art/asset-manifest.json"],
  ["artifact_asset_contact_sheet", "asset", "agents/art/asset-contact-sheet.png"],
  ["artifact_stage_2_visual_quality_review", "quality_review", "agents/review/art/first-playable.quality-review.json"],
  ["artifact_scene_blueprint_draft", "scene_blueprint", "agents/engineering/scene-blueprint.json"],
  ["artifact_playtest_contract_draft", "playtest_contract", "agents/qa/playtest-contract.json"],
  ["artifact_gameplay_source", "source_code", "assets/scripts/Game.ts"],
  ["artifact_wechat_dev_build", "build", "shared/build-artifacts/wechat/dev"],
  ["artifact_qa_playtest_report", "qa_report", "agents/qa/playtest-reports/first-playable.md"]
]) {
  addVerifiedArtifact(kernel, ...evidence, {
    ...(evidence[0] === "artifact_qa_playtest_report"
      ? { toolName: "run_playtest", playtestVerdict: "pass", playtestDefects: [] }
      : {})
  });
}

runtime.handleProducerMessage(
  kernel,
  producerMessage(kernel, "发起首个可玩通过门禁评审"),
  { scriptedReplies: false }
);
assert.equal(kernel.project.currentStage, "first_playable_review");
runtime.handleProducerMessage(
  kernel,
  producerMessage(kernel, "执行确认：首个可玩通过"),
  { scriptedReplies: false }
);
assert.equal(kernel.project.currentStage, "release_preparation");

const planTask = requireTask(kernel, "task_stage_3_devops_plan");
const deployTask = requireTask(kernel, "task_stage_3_devops_deploy");
const liveopsTask = requireTask(kernel, "task_stage_3_liveops_backlog");
assert.equal(planTask.stageId, "release_preparation");
assert.deepEqual(planTask.outputArtifacts, ["artifact_deployment_plan", "artifact_rollback_plan"]);
assert.deepEqual(planTask.blockers, [], "approval preparation must not wait for the approval it enables");
assert.equal(deployTask.stageId, "production_deploy");
assert.deepEqual(deployTask.outputArtifacts, ["artifact_deployment_report"]);
assert.equal(liveopsTask.stageId, "liveops");
assert.deepEqual(liveopsTask.inputArtifacts, ["artifact_deployment_report"]);

assertArtifactSource(kernel, "artifact_deployment_plan", planTask.taskId, "release_preparation");
assertArtifactSource(kernel, "artifact_rollback_plan", planTask.taskId, "release_preparation");
assertArtifactSource(kernel, "artifact_deployment_report", deployTask.taskId, "production_deploy");
assertArtifactSource(kernel, "artifact_release_notes", liveopsTask.taskId, "liveops");
assertAcyclicReleaseDependencies(kernel);

materializeExisting(kernel, "artifact_wechat_release_build");
materializeExisting(kernel, "artifact_release_gate_report", {
  toolName: "run_playtest",
  playtestVerdict: "pass",
  playtestDefects: []
});
materializeExisting(kernel, "artifact_deployment_plan", {
  secretMode: "vault_reference_only",
  executionStatus: "not_started"
});
materializeExisting(kernel, "artifact_rollback_plan");

runtime.handleProducerMessage(
  kernel,
  producerMessage(kernel, "发起批准发布门禁评审"),
  { scriptedReplies: false }
);
assert.equal(kernel.project.currentStage, "release_gate");
const gate = kernel.getWorkflowSnapshot().gates.at(-1);
assert.ok(gate);
assert.deepEqual(new Set(gate.requiredArtifacts), new Set([
  "artifact_wechat_release_build",
  "artifact_release_gate_report",
  "artifact_deployment_plan",
  "artifact_rollback_plan"
]));
assert.equal(gate.requiredArtifacts.includes("artifact_deployment_report"), false);
assert.equal(gate.requiredArtifacts.includes("artifact_release_notes"), false);

runtime.handleProducerMessage(
  kernel,
  producerMessage(kernel, "执行确认：批准发布"),
  { scriptedReplies: false }
);
assert.equal(kernel.project.currentStage, "production_deploy");
assert.equal(requireTask(kernel, "task_stage_3_devops_plan").status, "done");
assert.equal(requireTask(kernel, "task_stage_3_devops_deploy").status, "doing");
assert.equal(requireTask(kernel, "task_stage_3_liveops_backlog").status, "todo");
assert.deepEqual(workflowTaskStages(kernel.project.currentStage), ["production_deploy"]);

const deploymentReport = requireArtifact(kernel, "artifact_deployment_report");
const deploymentLedger = kernel.listArtifactLedger().find((entry) => entry.artifactId === deploymentReport.artifactId);
assert.equal(deploymentReport.metadata.toolExecutedAt, undefined, "approval must not fabricate a deployment report");
assert.equal(deploymentLedger?.status, "pending", "deployment evidence remains pending until real execution writes it");

materializeExisting(kernel, "artifact_deployment_report", {
  deploymentStatus: "succeeded",
  healthCheckStatus: "pass"
});
kernel.updateTaskStatus("task_stage_3_devops_deploy", "done");
kernel.executeWorkflow({
  type: "transition_stage",
  expectedRevision: kernel.getWorkflowSnapshot().revision,
  idempotencyKey: "release-topology-health-check-passed",
  actor: { actorId: "devops", role: "orchestrator" },
  targetStage: "liveops",
  reason: "Verified production deployment and health checks passed."
});
assert.equal(kernel.project.currentStage, "liveops");
assert.deepEqual(workflowTaskStages(kernel.project.currentStage), ["liveops"]);

console.log("Release approval topology verification passed");

function producerMessage(targetKernel, content) {
  return {
    messageId: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: targetKernel.project.projectId,
    roomId: targetKernel.getRoom("studio-main").roomId,
    senderType: "producer",
    senderId: targetKernel.project.producerId,
    messageType: "decision_record",
    content,
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: {},
    createdAt: new Date().toISOString()
  };
}

function addVerifiedArtifact(targetKernel, artifactId, type, path, metadata = {}) {
  const now = new Date().toISOString();
  const content = `verified:${artifactId}`;
  targetKernel.addArtifact({
    artifactId,
    projectId: targetKernel.project.projectId,
    type,
    path,
    ownerAgentId: "studio_orchestrator",
    stageId: "production",
    status: "submitted",
    version: 1,
    sourceDecisionIds: [],
    metadata: { ...metadata, toolExecutedAt: now, toolContent: content },
    createdAt: now,
    updatedAt: now
  });
  targetKernel.recordArtifactMaterialization(artifactId, {
    path,
    hash: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    materializedAt: now
  });
}

function materializeExisting(targetKernel, artifactId, metadata = {}) {
  const artifact = requireArtifact(targetKernel, artifactId);
  const now = new Date().toISOString();
  const content = `verified:${artifactId}:${artifact.version + 1}`;
  targetKernel.upsertArtifact({
    ...artifact,
    version: artifact.version + 1,
    metadata: { ...artifact.metadata, ...metadata, toolExecutedAt: now, toolContent: content },
    updatedAt: now
  });
  targetKernel.recordArtifactMaterialization(artifactId, {
    path: artifact.path,
    hash: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    materializedAt: now
  });
}

function requireTask(targetKernel, taskId) {
  const task = targetKernel.findTask(taskId);
  assert.ok(task, `missing task ${taskId}`);
  return task;
}

function requireArtifact(targetKernel, artifactId) {
  const artifact = targetKernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  assert.ok(artifact, `missing artifact ${artifactId}`);
  return artifact;
}

function assertArtifactSource(targetKernel, artifactId, taskId, stageId) {
  const artifact = requireArtifact(targetKernel, artifactId);
  assert.equal(artifact.sourceTaskId, taskId);
  assert.equal(artifact.stageId, stageId);
}

function assertAcyclicReleaseDependencies(targetKernel) {
  const stageRank = new Map([
    ["release_preparation", 0],
    ["production_deploy", 1],
    ["liveops", 2]
  ]);
  const tasks = targetKernel.listTasks().filter((task) => stageRank.has(task.stageId));
  const artifacts = targetKernel.listArtifacts();
  for (const consumer of tasks) {
    for (const artifactId of consumer.inputArtifacts) {
      const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
      const producer = artifact?.sourceTaskId ? tasks.find((task) => task.taskId === artifact.sourceTaskId) : undefined;
      if (!producer) continue;
      assert.ok(
        stageRank.get(producer.stageId) <= stageRank.get(consumer.stageId),
        `${consumer.taskId} depends on later-stage output from ${producer.taskId}`
      );
      assert.notEqual(producer.taskId, consumer.taskId, `${consumer.taskId} must not depend on its own output`);
    }
  }
}
