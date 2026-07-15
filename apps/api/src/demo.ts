import { studioStore } from "./store.js";

const created = studioStore.createProject({
  name: "毛线球防守",
  producerId: "producer_demo",
  idea: "做一个微信小游戏，玩家用点击防守毛线球，不让它们滚出篮子，单局一分钟，画风轻松可爱。"
});

const projectId = created.project.projectId;
const kernel = studioStore.getKernel(projectId);

const stageOneApproval = studioStore.postProducerMessage(projectId, {
  roomKind: "studio-main",
  messageType: "decision_record",
  content: "确认立项：玩法、美术方向和第一可玩范围都同意，进入开发落地。"
});

const firstPlayableApproval = studioStore.postProducerMessage(projectId, {
  roomKind: "studio-main",
  messageType: "decision_record",
  content: "首个可玩版本通过，接受当前核心循环，进入发布准备。"
});

const releaseApproval = studioStore.postProducerMessage(projectId, {
  roomKind: "release-room",
  messageType: "decision_record",
  content: "确认发布上线，批准 release。"
});

console.log("PROJECT");
console.log(JSON.stringify(created.project, null, 2));

console.log("BOOTSTRAP ROUTE TARGETS");
console.log(JSON.stringify(created.bootstrap?.routePlan.targets, null, 2));

console.log("STAGE TRANSITIONS");
console.log(
  JSON.stringify(
    {
      stageOneApproval: stageOneApproval.agentMessages.map((message) => message.content),
      firstPlayableApproval: firstPlayableApproval.agentMessages.map((message) => message.content),
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
