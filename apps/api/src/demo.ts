import { studioStore } from "./store.js";

const created = studioStore.createProject({
  name: "毛线球防守",
  producerId: "producer_demo",
  idea: "做一个微信小游戏，玩家用点击防守毛线球，不让它们滚出篮子，单局一分钟，画风轻松可爱。"
});

const projectId = created.project.projectId;
const started = await studioStore.startProject(projectId);

const stageOneReview = await studioStore.postProducerMessage(projectId, {
  roomKind: "studio-main",
  messageType: "review",
  content: "请求门禁评审：确认立项。"
});

const stageOneApproval = await studioStore.postProducerMessage(projectId, {
  roomKind: "studio-main",
  messageType: "decision_record",
  content: "执行确认：确认立项。制作人已阅读 Agent 门禁评审和风险提示，仍确认进入开发落地。"
});

const firstPlayableReview = await studioStore.postProducerMessage(projectId, {
  roomKind: "studio-main",
  messageType: "review",
  content: "请求门禁评审：首个可玩通过。"
});

const firstPlayableApproval = await studioStore.postProducerMessage(projectId, {
  roomKind: "studio-main",
  messageType: "decision_record",
  content: "执行确认：首个可玩通过。制作人已阅读 Agent 门禁评审和风险提示，仍确认进入发布准备。"
});

const releaseReview = await studioStore.postProducerMessage(projectId, {
  roomKind: "release-room",
  messageType: "review",
  content: "请求门禁评审：批准发布。"
});

const releaseApproval = await studioStore.postProducerMessage(projectId, {
  roomKind: "release-room",
  messageType: "decision_record",
  content: "执行确认：批准发布。制作人已阅读 Agent 门禁评审和风险提示，仍确认进入发布和持续运营。"
});

const kernel = studioStore.getKernel(projectId);

console.log("PROJECT");
console.log(JSON.stringify(created.project, null, 2));

console.log("BOOTSTRAP ROUTE TARGETS");
console.log(JSON.stringify(started.routePlan.targets, null, 2));

console.log("STAGE TRANSITIONS");
console.log(
  JSON.stringify(
    {
      stageOneReview: stageOneReview.agentMessages.map((message) => message.content),
      stageOneApproval: stageOneApproval.agentMessages.map((message) => message.content),
      firstPlayableReview: firstPlayableReview.agentMessages.map((message) => message.content),
      firstPlayableApproval: firstPlayableApproval.agentMessages.map((message) => message.content),
      releaseReview: releaseReview.agentMessages.map((message) => message.content),
      releaseApproval: releaseApproval.agentMessages.map((message) => message.content),
      currentStage: kernel.project.currentStage
    },
    null,
    2
  )
);

console.log("AGENT MESSAGES");
console.log(JSON.stringify(kernel.listMessages(), null, 2));

console.log("TASK BOARD");
console.log(JSON.stringify(kernel.buildTaskBoard(), null, 2));

console.log("WORKSPACE");
console.log(JSON.stringify(studioStore.readWorkspaceTree(projectId), null, 2));

console.log("ARTIFACTS");
console.log(JSON.stringify(kernel.listArtifacts(), null, 2));

console.log("MEMORY");
console.log(
  JSON.stringify(
    kernel.memory.query({
      projectId,
      status: ["active", "draft"]
    }),
    null,
    2
  )
);
