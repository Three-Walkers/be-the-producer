import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "btp-artifact-provenance-")));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");

const { createStudioKernel } = await import("../packages/agent-runtime/dist/index.js");
const { artifactReadyForConsumption } = await import("../apps/api/dist/taskOutputEvidence.js");

try {
  const kernel = createStudioKernel("artifact_provenance", "Artifact Provenance", "producer_test", "验证跨产物新鲜度");
  const now = new Date().toISOString();
  addTask(kernel, "task_input", "game_designer", [], ["artifact_input"]);
  addTask(kernel, "task_output", "game_designer", ["artifact_input"], ["artifact_output"]);

  materialize(kernel, {
    artifactId: "artifact_input",
    taskId: "task_input",
    path: "agents/design/input.md",
    content: "input-v1\n",
    version: 1,
    now
  });
  materialize(kernel, {
    artifactId: "artifact_output",
    taskId: "task_output",
    path: "agents/design/output.md",
    content: "derived-from-v1\n",
    version: 1,
    now
  });
  assert.equal(artifactReadyForConsumption(kernel, "artifact_output"), true);

  materialize(kernel, {
    artifactId: "artifact_input",
    taskId: "task_input",
    path: "agents/design/input.md",
    content: "input-v2\n",
    version: 2,
    now: new Date(Date.now() + 1_000).toISOString()
  });
  assert.equal(artifactReadyForConsumption(kernel, "artifact_output"), false, "input revision/hash change must stale an old output");

  // A schema-compatible or plain external edit is rejected even when metadata,
  // versions and the ledger were not touched.
  write("artifact_provenance", "agents/design/input.md", "externally-tampered-but-valid-text\n");
  assert.equal(artifactReadyForConsumption(kernel, "artifact_input"), false, "current file hash/size must match ledger");

  console.log("Artifact provenance verification passed: current inputs consumed; revised/tampered inputs stale outputs");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function addTask(kernel, taskId, ownerAgentId, inputArtifacts, outputArtifacts) {
  const now = new Date().toISOString();
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: kernel.project.currentStage,
    roomId: kernel.getRoom("design-room").roomId,
    taskLevel: "task",
    title: taskId,
    description: "provenance fixture",
    ownerAgentId,
    participantAgentIds: [],
    status: "doing",
    priority: 1,
    sortOrder: 1,
    progressPercent: 0,
    blockers: [],
    inputArtifacts,
    outputArtifacts,
    acceptanceCriteria: ["current provenance"],
    createdAt: now,
    updatedAt: now
  });
}

function materialize(kernel, { artifactId, taskId, path, content, version, now }) {
  write(kernel.project.projectId, path, content);
  const artifact = kernel.upsertArtifact({
    artifactId,
    projectId: kernel.project.projectId,
    type: "gdd",
    path,
    ownerAgentId: "game_designer",
    stageId: kernel.project.currentStage,
    status: "submitted",
    version,
    sourceTaskId: taskId,
    sourceDecisionIds: [],
    metadata: { toolName: "write_artifact", toolExecutedAt: now, toolContent: content },
    createdAt: now,
    updatedAt: now
  });
  const body = Buffer.from(content);
  kernel.recordArtifactMaterialization(artifact.artifactId, {
    path,
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength,
    materializedAt: now
  });
}

function write(projectId, path, content) {
  const absolute = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
