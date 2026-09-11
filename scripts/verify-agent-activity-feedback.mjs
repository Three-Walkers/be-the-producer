import assert from "node:assert/strict";
import { createStudioKernel } from "../packages/agent-runtime/dist/index.js";
import { AgentActivityReporter } from "../apps/api/dist/agentActivity.js";
const kernel = createStudioKernel("feedback_fixture", "Feedback", "producer", "fixture");
const reporter = new AgentActivityReporter(kernel, {
  roomId: kernel.getRoom("engineering-room").roomId,
  agentId: "cocos_tech_lead", kind: "task_execution"
});
const base = { invocationId: "test", createdAt: new Date().toISOString() };
reporter.onHarnessProgress({ ...base, type: "model_output" });
const before = reporter.timeline().at(-1).progressPercent;
reporter.onHarnessProgress({ ...base, type: "tool_failed", toolName: "write_artifact", path: "agents/engineering/example.json", detail: "未知状态引用" });
const failure = reporter.timeline().at(-1);
assert.equal(failure.progressPercent, before, "failed writes must not inflate progress");
assert.equal(failure.status, "failed");
assert.match(failure.label, /工具执行失败/);
assert.match(failure.detail, /未知状态引用/);
reporter.onHarnessProgress({ ...base, type: "tool_completed", toolName: "write_artifact", progressPercent: 70 });
assert.equal(reporter.timeline().at(-2).status, "failed", "recovery must not relabel the earlier error as success");
assert.match(reporter.timeline().at(-1).label, /工具执行完成/);
console.log("Agent activity feedback passed: failed tools retain reasons, do not inflate progress, and remain visible after recovery.");
