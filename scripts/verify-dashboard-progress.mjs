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

const qaTask = {
  taskId: "qa-blocked",
  ownerAgentId: "qa_evaluator",
  status: "blocked",
  progressPercent: 50,
  subtasks: []
};
const summary = summarizeProjectDashboard({
  taskBoard: {
    total: 3,
    buckets: { doing: 1, blocked: 1, todo: 0, done: 1 },
    taskGroups: [{ tasks: [{ ...designTask, subtasks: [] }, qaTask, { ...repairTask, subtasks: [] }] }]
  },
  artifacts: [
    { artifactId: "current", status: "submitted" },
    { artifactId: "draft", status: "draft" },
    { artifactId: "old", status: "superseded" }
  ],
  productionAudit: {
    findings: [
      { findingId: "high", status: "open", severity: "high" },
      { findingId: "closed", status: "resolved", severity: "critical" }
    ]
  },
  teamOwnerGroups: [["game_designer"], ["qa_evaluator"], ["art_director"]]
});
assert.equal(summary.taskTotal, 3);
assert.equal(summary.doneCount, 1, "headline completion must match the canonical task-board buckets");
assert.equal(summary.progressPercent, 70);
assert.equal(summary.deliverableCount, 2);
assert.equal(summary.blockedTaskCount, 1);
assert.equal(summary.auditBlockingCount, 1);
assert.equal(summary.blockerCount, 2);
assert.equal(summary.activeTeamCount, 2);
assert.equal(summary.nextTask.taskId, qaTask.taskId, "blocked work must be the dashboard's first focus");

const groupedDeliverables = groupProjectDeliverables([
  { artifactId: "gdd-v1", type: "gdd", ownerAgentId: "game_designer", stageId: "concept_discussion", version: 1 },
  { artifactId: "gdd-v3", type: "gdd", ownerAgentId: "game_designer", stageId: "concept_discussion", version: 3 },
  { artifactId: "art-v2", type: "art_bible", ownerAgentId: "art_director", stageId: "concept_discussion", version: 2 }
]);
assert.equal(groupedDeliverables.length, 2, "versioned deliverables must collapse into stable families");
assert.equal(groupedDeliverables[0].latest.artifactId, "gdd-v3", "the highest version must lead its family");
assert.deepEqual(groupedDeliverables[0].history.map((artifact) => artifact.artifactId), ["gdd-v1"]);

const [html, app, css] = await Promise.all([
  readFile(new URL("../apps/api/public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../apps/api/public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../apps/api/public/styles.css", import.meta.url), "utf8")
]);
const workspaceColumn = html.match(/<aside class="workspace-column"[\s\S]*?<\/aside>/)?.[0] ?? "";
assert.match(workspaceColumn, /id="open-project-dashboard"/, "the main workspace column must expose one dashboard entry");
for (const detailId of ["task-board", "artifact-list", "production-audit", "workspace-tree"]) {
  assert.doesNotMatch(workspaceColumn, new RegExp(`id="${detailId}"`), `${detailId} must leave the main workspace column`);
  assert.match(html, new RegExp(`id="${detailId}"`), `${detailId} must remain available inside the dashboard page`);
}
for (const marker of [
  "project-dashboard-page",
  "dashboard-metric-tasks",
  "dashboard-stage-track",
  "dashboard-tasks",
  "dashboard-artifacts",
  "dashboard-audit",
  "dashboard-teams"
]) {
  assert.match(html, new RegExp(`id="${marker}"`), `missing project dashboard marker #${marker}`);
}
for (const target of ["dashboard-tasks", "dashboard-artifacts", "dashboard-audit", "dashboard-teams"]) {
  assert.match(html, new RegExp(`data-open-dashboard-target="${target}"`), `main overview must open #${target}`);
  assert.match(html, new RegExp(`class="dashboard-metric-card" data-dashboard-target="${target}"`), `dashboard metric must open #${target}`);
  assert.match(html, new RegExp(`id="${target}"[^>]*tabindex="-1"`), `#${target} must accept programmatic focus`);
}
assert.match(app, /#project-dashboard/, "the dashboard must have a page-level URL state");
assert.match(app, /history\.pushState/, "opening the dashboard must preserve browser back navigation");
assert.match(app, /summarizeProjectDashboard/, "main overview and dashboard metrics must share one summary rule");
assert.match(app, /data-dashboard-task-filter/, "the detailed task board must support status filtering");
assert.match(app, /groupProjectDeliverables/, "deliverable versions must use progressive grouping");
assert.match(app, /data-deliverable-family-toggle/, "historical versions must remain available on demand");
assert.match(app, /function openDashboardSection/, "main overview metrics must deep-link into dashboard details");
assert.match(app, /function focusDashboardSection/, "dashboard metric cards must focus their detail section");
assert.match(css, /\.project-dashboard-page\s*\{/);
assert.match(css, /\.overview-metric-card\s*\{/, "overview metrics must communicate clickability");
assert.match(css, /\.dashboard-metric-card\s*\{/, "dashboard metrics must communicate clickability");
assert.match(css, /\.dashboard-card:focus-visible\s*\{/, "focused dashboard details must remain visible to keyboard users");
assert.match(css, /\.project-dashboard-page\[hidden\]\s*\{\s*display:\s*none/, "the route-owned dashboard must stay hidden on the main page");
assert.match(css, /\.deliverable-history\[hidden\]\s*\{\s*display:\s*none/, "collapsed artifact history must not consume dashboard height");
assert.match(css, /@media \(max-width: 780px\)/, "the dashboard must retain a mobile layout");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "dashboard motion must respect user preferences");

console.log("Project dashboard passed: concise main overview, moved detail panels, metrics, filters, routing, and responsive UI");
