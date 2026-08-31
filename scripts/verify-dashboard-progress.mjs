import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  groupProjectDeliverables,
  selectTeamTasks,
  summarizeProjectDashboard,
  summarizeTaskProgress,
  taskProgressPercent
} from "../apps/api/public/dashboard-progress.js";

const designTask = {
  taskId: "design",
  ownerAgentId: "game_designer",
  status: "review",
  progressPercent: 90
};
const producerGate = {
  taskId: "producer-gate",
  ownerAgentId: "producer",
  status: "todo",
  progressPercent: 0
};
const repairTask = {
  taskId: "repair",
  parentTaskId: "task_group_claim_repair",
  ownerAgentId: "game_designer",
  status: "blocked",
  progressPercent: 0
};

assert.equal(taskProgressPercent({ status: "review" }), 90, "review fallback must match the task board domain rule");
assert.equal(taskProgressPercent({ status: "blocked" }), 50, "blocked fallback must match the task board domain rule");
assert.equal(summarizeTaskProgress([designTask]).progressPercent, 90, "team delivery progress must match its task");
const designTeamTasks = selectTeamTasks([designTask, producerGate, repairTask], ["game_designer"]);
assert.deepEqual(designTeamTasks, [designTask], "producer gate work must not be counted as design delivery work");
assert.ok(!designTeamTasks.includes(repairTask), "evidence repair tasks must not block business team progress");
assert.equal(summarizeTaskProgress(designTeamTasks).progressPercent, 90, "team delivery progress must exclude producer gates");
assert.deepEqual(summarizeTaskProgress([]), {
  total: 0,
  doneCount: 0,
  blockedCount: 0,
  progressPercent: 0
});

console.log("Dashboard progress smoke passed");
