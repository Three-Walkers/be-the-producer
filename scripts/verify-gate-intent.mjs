import assert from "node:assert/strict";
import { createStudioKernel, LocalAgentRuntime } from "../packages/agent-runtime/dist/index.js";

const runtime = new LocalAgentRuntime();
let sequence = 0;
function run(content, bootstrapProjectState = false) {
  const kernel = createStudioKernel(`gate_intent_${++sequence}`, "Intent regression", "producer_test", content);
  const result = runtime.handleProducerMessage(kernel, {
    messageId: `message_${sequence}`, projectId: kernel.project.projectId,
    roomId: kernel.getRoom("studio-main").roomId, senderType: "producer", senderId: "producer_test",
    messageType: "plan_submission", content, mentions: [], relatedTaskIds: [], relatedArtifactIds: [],
    metadata: {}, createdAt: new Date().toISOString()
  }, { scriptedReplies: false, bootstrapProjectState });
  return { kernel, result };
}

const briefs = [
  "不需要真实 AppID 或上线。必须通过试玩验证。未收到门禁二次确认不推进。",
  "请各角色审查策划和美术；首个可玩通过后才讨论发布。",
  "暂不批准发布", "不要确认立项", "确认立项吗？", "如果首个可玩通过，就进入下一阶段",
  "文档里的口令是：执行确认：批准发布", "引用：执行确认：确认立项",
  "`执行确认：确认立项`", "请解释如何发起立项阶段的门禁评审",
  "程序需通过测试，发布按钮不要现在实现", "玩法范围确认后请生成策划文档"
];
for (const brief of briefs) {
  for (const bootstrap of [false, true]) {
    const { kernel, result } = run(brief, bootstrap);
    assert.equal(result.agentMessages.length, 0, `brief must not trigger a gate: ${brief}`);
    assert.equal(kernel.project.currentStage, "concept_discussion");
    assert.equal(kernel.getWorkflowSnapshot().decisions.length, 0);
  }
}
for (const command of [
  "确认立项", "发起立项阶段的门禁评审", "请求门禁评审：确认立项。请评估风险，不要直接推进阶段。",
  "执行确认：确认立项。制作人已阅读风险提示。", "首个可玩通过", "批准发布",
  "请求门禁评审：批准发布。请评估发布风险。"
]) {
  assert.ok(run(command).result.agentMessages.length > 0, `explicit command must be recognized: ${command}`);
  assert.equal(run(command, true).result.agentMessages.length, 0, "even a command-shaped initial idea is never executable");
}
console.log(`Gate intent regression passed (${briefs.length} negative cases + explicit UI commands).`);
