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

const retractionKernel = createStudioKernel(`game_retraction_${Date.now()}`, "Retraction", "producer_test", "test");
const source = { ...agentMessage("unsupported_completion", "文档规范已写入。"), projectId: retractionKernel.project.projectId,
  roomId: retractionKernel.getRoom("design-room").roomId, createdAt: "2026-09-01T00:00:00.000Z" };
retractionKernel.recordMessage(source);
verifyProjectClaims(retractionKernel);
reconcileClaimRepairs(retractionKernel);
const repair = retractionKernel.listClaimRepairs()[0];
assert.ok(repair);
const retract = { ...source, messageId: "msg_retract", content: `撤回声明：${repair.claimId}\n此条仅为计划，尚未落盘。`, createdAt: "2026-09-01T00:01:00.000Z" };
retractionKernel.recordMessage({ ...retract, messageId: "wrong_author", senderId: "art_director" });
retractionKernel.recordMessage({ ...retract, messageId: "quoted", content: `有人建议：${retract.content}` });
reconcileClaimRepairs(retractionKernel);
assert.equal(retractionKernel.listClaimRepairs()[0].status, "open", "only an explicit retraction by the original agent is valid");
retractionKernel.recordMessage(retract);
verifyProjectClaims(retractionKernel);
reconcileClaimRepairs(retractionKernel);
assert.equal(retractionKernel.listClaimRepairs()[0].resolution, "claim_retracted");
assert.equal(retractionKernel.findTask(repair.taskId).status, "done");
assert.equal(retractionKernel.listArtifacts().length, 0, "retraction must never fabricate completion evidence");
assert.notEqual(retractionKernel.listClaimVerifications().find((claim) => claim.claimId === repair.claimId).verdict, "verified");
retractionKernel.updateTask(repair.taskId, {status: "blocked", blockers: ["late stale loop reply"]});
reconcileClaimRepairs(retractionKernel);
assert.equal(retractionKernel.findTask(repair.taskId).status, "done", "grounded resolved audit work repairs a late stale task projection");
const { AgentLoopService } = await import("../apps/api/dist/agentLoop.js");
retractionKernel.updateTask(repair.taskId, {status: "doing", blockers: []});
retractionKernel.updateProject({executionStatus: "running"});
const auditLoop = new AgentLoopService({getKernel: () => retractionKernel, checkpoint: () => {}, modelRuntime: {
  async respondToTask(current) {
    reconcileClaimRepairs(current); // Simulate evidence resolving while the worker returns.
    return {...retract, messageId: "late_audit_worker", relatedTaskIds: [repair.taskId],
      metadata: {loopControl: {status: "blocked", reason: "No output file", handoffAgentIds: []}}};
  }
}});
auditLoop.start(retractionKernel.project.projectId, {reason: "audit race regression"});
const auditDeadline = Date.now() + 2000;
while (retractionKernel.getAgentLoopState().status === "running" && Date.now() < auditDeadline) await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(retractionKernel.findTask(repair.taskId).status, "done", "a late loop-control result cannot reopen a resolved evidence repair");
auditLoop.pause(retractionKernel.project.projectId);
const { reconcileProductionAudit } = await import("../apps/api/dist/productionAudit.js");
const repairedAudit = reconcileProductionAudit(retractionKernel, { trigger: "checkpoint" });
assert.ok(!repairedAudit.run.findings.some((finding) => finding.signature === `task-output:${repair.taskId}`),
  "a grounded retraction completes a correction task without inventing an output file");
assert.ok(!repairedAudit.run.findings.some((finding) => finding.signature === "task-output:task_group_claim_repair"),
  "a task group is not an unmaterialized file");
const savedRetraction = retract.content;
retract.content = "仅仅修改文字，未撤回。";
const forgedAudit = reconcileProductionAudit(retractionKernel, { trigger: "checkpoint", triggerRef: "invalid-retraction" });
assert.ok(forgedAudit.run.findings.some((finding) => finding.signature === `task-output:${repair.taskId}`),
  "resolved status alone cannot replace the actual owner-bound retraction evidence");
retract.content = savedRetraction;
retractionKernel.recordMessage({ ...source, messageId: "new_false_completion", createdAt: "2099-01-01T00:00:00.000Z" });
verifyProjectClaims(retractionKernel);
reconcileClaimRepairs(retractionKernel);
assert.equal(retractionKernel.listClaimRepairs()[0].status, "open", "a later false claim cannot hide behind an earlier retraction");

console.log("Claim repair smoke passed: no recursion, semantic dedupe, clean migration, owner-bound explicit retraction without artifact approval");

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
