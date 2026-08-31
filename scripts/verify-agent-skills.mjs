import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const {
  createStudioKernel,
  createStudioKernelFromSnapshot,
  defaultAgentContracts,
  defaultAgentSkillRegistry,
  defaultAgentSkillDefinitions,
  extractProducerSkillDirectives
} = await import("@game-pipeline/agent-runtime");
const { SessionCoordinator } = await import("../apps/api/dist/sessionCoordinator.js");
const { buildProjectMemoryView } = await import("../apps/api/dist/projectMemoryView.js");

defaultAgentSkillRegistry.assertAgentBindings(defaultAgentContracts);
assert.equal(defaultAgentSkillRegistry.list().length, defaultAgentSkillDefinitions.length);
for (const skill of defaultAgentSkillRegistry.list()) {
  assert.match(skill.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(skill.origin, "internal_clean_room");
}

const designer = requiredAgent("game_designer");
const devops = requiredAgent("devops");
const producer = requiredAgent("producer");
const task = taskFixture({
  taskId: "task_skill_level",
  ownerAgentId: designer.agentId,
  title: "设计三关的波次和路线节奏",
  description: "把核心循环转成可测试的关卡路线。"
});

let resolution = defaultAgentSkillRegistry.resolve({
  agent: designer,
  stageId: "concept_discussion",
  task,
  artifacts: []
});
assert.deepEqual(resolution.active.map((skill) => skill.skillId), ["level-design"]);
assert.equal(resolution.active[0]?.activationSource, "automatic");
assert.match(resolution.active[0]?.reason ?? "", /任务语义/);

resolution = defaultAgentSkillRegistry.resolve({
  agent: designer,
  stageId: "concept_discussion",
  task: taskFixture({
    taskId: "task_skill_generic",
    ownerAgentId: designer.agentId,
    title: "补充设计说明",
    description: "补充现有文档。"
  }),
  artifacts: [],
  requestedSkillIds: ["balance-analysis"]
});
assert.deepEqual(resolution.active.map((skill) => skill.skillId), ["balance-analysis"]);
assert.equal(resolution.active[0]?.activationSource, "producer_requested");

resolution = defaultAgentSkillRegistry.resolve({
  agent: designer,
  stageId: "concept_discussion",
  task,
  artifacts: [],
  disabledSkillIds: ["level-design"]
});
assert.equal(resolution.active.length, 0);
assert.equal(resolution.available.find((skill) => skill.skillId === "level-design")?.status, "disabled");

const deploymentTask = taskFixture({
  taskId: "task_skill_deploy",
  ownerAgentId: devops.agentId,
  stageId: "release_preparation",
  title: "部署正式版本并执行健康检查",
  description: "按计划发布，并保留回滚证据。"
});
resolution = defaultAgentSkillRegistry.resolve({
  agent: devops,
  stageId: "release_preparation",
  task: deploymentTask,
  artifacts: [],
  requestedSkillIds: ["deploy-game"]
});
assert.equal(resolution.active.length, 0, "explicit text must not bypass a high-risk workflow gate");
assert.equal(resolution.available[0]?.status, "awaiting_approval");

resolution = defaultAgentSkillRegistry.resolve({
  agent: devops,
  stageId: "production_deploy",
  task: { ...deploymentTask, stageId: "production_deploy" },
  artifacts: [],
  requestedSkillIds: ["deploy-game"]
});
assert.deepEqual(resolution.active.map((skill) => skill.skillId), ["deploy-game"]);
assert.equal(resolution.active[0]?.activationSource, "workflow_approved");

resolution = defaultAgentSkillRegistry.resolve({
  agent: producer,
  stageId: "concept_discussion",
  task: { ...task, ownerAgentId: producer.agentId },
  artifacts: [],
  requestedSkillIds: ["level-design"]
});
assert.equal(resolution.active.length, 0, "a producer directive must not grant a Skill outside the role allowlist");
assert.ok(defaultAgentContracts.every((agent) => !agent.skillBindings.some((binding) => binding.skillId === "multiplayer-setup")));

assert.deepEqual(
  extractProducerSkillDirectives(
    ["本轮请用 $level-design，同时 $disable-skill:balance-analysis。"],
    defaultAgentSkillRegistry.list().map((skill) => skill.skillId)
  ),
  { requestedSkillIds: ["level-design"], disabledSkillIds: ["balance-analysis"] }
);

const kernel = createStudioKernel("agent_skill_test", "Agent Skill Test", "producer", "验证角色 Skill 自动装载");
const room = kernel.getRoom("design-room");
const now = new Date().toISOString();
kernel.addTask({
  ...task,
  projectId: kernel.project.projectId,
  roomId: room.roomId,
  createdAt: now,
  updatedAt: now
});
kernel.recordMessage({
  messageId: "msg_skill_request",
  projectId: kernel.project.projectId,
  roomId: room.roomId,
  senderType: "producer",
  senderId: "producer",
  messageType: "progress_update",
  content: "请使用 $level-design 收敛三关节奏，但不要越过策划的工具权限。",
  mentions: [designer.agentId],
  relatedTaskIds: [task.taskId],
  relatedArtifactIds: [],
  metadata: {},
  createdAt: now
});

const coordinator = new SessionCoordinator();
const session = coordinator.getOrCreateRoomSession(kernel, designer, room.roomId, {
  providerId: "test-provider",
  model: "test-model",
  harnessId: "direct-api"
});
const prepared = coordinator.prepareContext(kernel, session, designer, room.roomId, kernel.findTask(task.taskId), "msg_skill_request");
const active = prepared.context.packet.activatedSkills ?? [];
assert.deepEqual(active.map((skill) => skill.skillId), ["level-design"]);
assert.equal(active[0]?.activationSource, "producer_requested");
const skillLayer = prepared.context.packet.layers.find((layer) => layer.kind === "skill_guidance");
assert.ok(skillLayer);
assert.ok(skillLayer.sourceRefs.includes(`skill:level-design@${active[0].version}#${active[0].contentHash}`));
assert.match(skillLayer.content, /只提供专业流程，不扩大 AgentContract/);
assert.match(prepared.context.prompt, /本轮专业 Skill/);

const view = buildProjectMemoryView(kernel);
const designerView = view.agents.find((agent) => agent.agentId === designer.agentId);
assert.ok(designerView);
assert.equal(designerView.skills.latestPacketId, prepared.context.packet.packetId);
assert.deepEqual(designerView.skills.active.map((skill) => skill.skillId), ["level-design"]);
assert.ok(designerView.skills.available.some((skill) => skill.skillId === "balance-analysis"));
assert.match(view.architecture.skillActivation, /allowlist/i);

const restored = createStudioKernelFromSnapshot(JSON.parse(JSON.stringify(kernel.toSnapshot())));
assert.deepEqual(
  restored.listContextPackets().at(-1)?.activatedSkills,
  prepared.context.packet.activatedSkills,
  "activated Skill receipts must survive snapshot restoration"
);

const [app, css] = await Promise.all([
  readFile(new URL("../apps/api/public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../apps/api/public/styles.css", import.meta.url), "utf8")
]);
assert.match(app, /ROLE SKILLS/);
assert.match(app, /\$skill-/);
assert.match(css, /\.memory-skill-card[,\s]/);
assert.match(css, /\.memory-skill-row\.status-awaiting_approval/);

process.stdout.write("Agent Skill registry, gated activation, Context Packet receipt, snapshot and UI verification passed\n");

function requiredAgent(agentId) {
  const agent = defaultAgentContracts.find((candidate) => candidate.agentId === agentId);
  assert.ok(agent, `missing default agent: ${agentId}`);
  return agent;
}

function taskFixture(overrides) {
  const timestamp = "2026-08-31T08:00:00.000Z";
  return {
    taskId: "task_skill_fixture",
    projectId: "agent_skill_test",
    stageId: "concept_discussion",
    taskLevel: "task",
    ownerAgentId: "game_designer",
    title: "Skill fixture",
    description: "Skill fixture",
    status: "doing",
    priority: 50,
    sortOrder: 1,
    progressPercent: 0,
    childrenSummary: { doing: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 },
    inputArtifacts: [],
    outputArtifacts: [],
    acceptanceCriteria: ["Skill activation is observable"],
    blockers: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  };
}
