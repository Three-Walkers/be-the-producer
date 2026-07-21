import assert from "node:assert/strict";
import { createStudioKernel } from "../packages/agent-runtime/dist/index.js";
import { reconcileClaimRepairs } from "../apps/api/dist/claimRepair.js";
import { migrateLegacyClaimRepairStorm } from "../apps/api/dist/claimRepairMigration.js";
import { verifyProjectClaims } from "../apps/api/dist/claimVerifier.js";

const kernel = createStudioKernel(`game_claim_${Date.now()}`, "Claim repair test", "producer_test", "test");
const roomId = kernel.getRoom("design-room").roomId;

kernel.recordMessage(agentMessage("write-one", "已写入 `agents/design/missing.md`。"));
kernel.recordMessage(agentMessage("write-two", "已写入 `agents/design/missing.md`。"));
kernel.recordMessage(agentMessage("reference", "下一步需要创建 `assets/scenes/main.scene`，当前尚未执行。"));
kernel.recordMessage({
  ...agentMessage("workflow-event", "Stage 1 已审批，已创建美术资产、玩法代码和 QA 首轮任务。"),
  senderId: "studio_orchestrator",
  metadata: { generatedBy: "local_agent_runtime" }
});

verifyProjectClaims(kernel);
reconcileClaimRepairs(kernel);

assert.equal(kernel.listClaimRepairs().length, 1, "duplicate claims for the same semantic target must share one repair");
assert.equal(guardianMessages(kernel).length, 1, "one semantic repair must emit one guardian message");
assert.equal(
  kernel.listClaimVerifications().find((claim) => claim.messageId === "msg_reference")?.claimType,
  "path_reference",
  "future work path references must not be treated as completed writes"
);
assert.ok(
  !kernel.listClaimVerifications().some((claim) => claim.messageId === "msg_workflow-event"),
  "orchestrator workflow events must not be treated as artifact completion claims"
);

verifyProjectClaims(kernel);
reconcileClaimRepairs(kernel);
assert.equal(kernel.listClaimRepairs().length, 1, "guardian messages must not recursively generate repairs");
assert.equal(guardianMessages(kernel).length, 1, "guardian messages must not recursively post messages");

kernel.recordMessage({
  ...agentMessage("legacy-guardian", "证据守卫已创建补证任务，处理 agents/design/missing.md。"),
  senderId: "studio_orchestrator",
  metadata: { generatedBy: "claim_repair_guardian" }
});
const migration = migrateLegacyClaimRepairStorm(kernel);
assert.equal(migration.changed, true);
assert.equal(guardianMessages(migration.kernel).length, 0, "migration must remove recursive guardian history");
assert.equal(migration.kernel.listClaimRepairs().length, 0, "migration must rebuild derived repairs from clean source messages");
assert.ok(!migration.kernel.findTask("task_group_claim_repair"), "migration must remove polluted repair tasks");

verifyProjectClaims(migration.kernel);
reconcileClaimRepairs(migration.kernel);
assert.equal(migration.kernel.listClaimRepairs().length, 1, "clean reconciliation must restore only the real repair");
assert.equal(guardianMessages(migration.kernel).length, 1);
assert.equal(guardianMessages(migration.kernel)[0].metadata.claimRepairProtocolVersion, 2);

console.log("Claim repair smoke passed: no recursion, semantic dedupe, clean migration");

function agentMessage(id, content) {
  return {
    messageId: `msg_${id}`,
    projectId: kernel.project.projectId,
    roomId,
    senderType: "agent",
    senderId: "game_designer",
    messageType: "progress_update",
    content,
    mentions: [],
    relatedTaskIds: [],
    relatedArtifactIds: [],
    metadata: { generatedBy: "claude_cli_harness" },
    createdAt: new Date().toISOString()
  };
}

function guardianMessages(targetKernel) {
  return targetKernel.listMessages().filter((message) => message.metadata?.generatedBy === "claim_repair_guardian");
}
