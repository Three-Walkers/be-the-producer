import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "game-pipeline-persistence-"));

try {
  const { createStudioKernel, LocalAgentRuntime } = await import("@game-pipeline/agent-runtime");
  const { ProjectPersistenceStore } = await import("../apps/api/dist/projectPersistence.js");

  const repository = new ProjectPersistenceStore(tempRoot);
  const alpha = createStudioKernel("project_alpha", "Alpha", "producer", "first revision");
  repository.save(alpha);
  alpha.updateProject({ initialIdea: "second revision", updatedAt: new Date().toISOString() });
  repository.save(alpha);

  const alphaDirectory = join(tempRoot, "project_alpha");
  const primaryPath = join(alphaDirectory, "studio-state.json");
  const backupPath = join(alphaDirectory, "studio-state.backup.json");
  assert.equal(JSON.parse(readFileSync(primaryPath, "utf8")).project.initialIdea, "second revision");
  assert.equal(JSON.parse(readFileSync(backupPath, "utf8")).project.initialIdea, "first revision");
  assert.deepEqual(
    readdirSync(alphaDirectory).filter((name) => name.endsWith(".tmp")),
    [],
    "atomic save must not leave temporary files behind"
  );

  const restarted = new ProjectPersistenceStore(tempRoot);
  assert.equal(restarted.load("project_alpha")?.project.initialIdea, "second revision");

  writeFileSync(primaryPath, "{corrupted", "utf8");
  const recovering = new ProjectPersistenceStore(tempRoot);
  assert.equal(recovering.load("project_alpha")?.project.initialIdea, "first revision");
  assert.equal(JSON.parse(readFileSync(primaryPath, "utf8")).project.initialIdea, "first revision");
  assert.ok(recovering.listIssues().some((issue) => issue.kind === "recovered_from_backup"));

  const beta = createStudioKernel("project_beta", "Beta", "producer", "healthy project");
  recovering.save(beta);
  const corruptDirectory = join(tempRoot, "project_corrupt");
  mkdirSync(corruptDirectory, { recursive: true });
  writeFileSync(join(corruptDirectory, "studio-state.json"), JSON.stringify({ version: 1, savedAt: "missing-critical-fields" }), "utf8");
  writeFileSync(join(tempRoot, ".orphan-state.tmp"), "not a project", "utf8");

  const isolated = new ProjectPersistenceStore(tempRoot);
  assert.deepEqual(
    isolated.loadAll().map((kernel) => kernel.project.projectId).sort(),
    ["project_alpha", "project_beta"]
  );
  assert.deepEqual(
    isolated.listSummaries().map((summary) => summary.projectId).sort(),
    ["project_alpha", "project_beta"]
  );
  assert.ok(isolated.listIssues().some((issue) => issue.projectId === "project_corrupt" && issue.kind === "invalid_snapshot"));

  const legacy = createStudioKernel("project_legacy_alias", "Legacy Alias", "producer", "legacy alias migration");
  legacy.updateProject({ executionStatus: "running", startedAt: new Date().toISOString() });
  new LocalAgentRuntime().handleProducerMessage(
    legacy,
    {
      messageId: "msg_legacy_alias_bootstrap",
      projectId: legacy.project.projectId,
      roomId: legacy.getRoom("studio-main").roomId,
      senderType: "producer",
      senderId: "producer",
      messageType: "plan_submission",
      content: "验证旧动态产物身份迁移。",
      mentions: [],
      relatedTaskIds: [],
      relatedArtifactIds: [],
      metadata: {},
      createdAt: new Date().toISOString()
    },
    { scriptedReplies: false, protocolFlows: false, bootstrapProjectState: true }
  );
  const legacySnapshot = legacy.toSnapshot();
  legacySnapshot.project.currentStage = "production";
  delete legacySnapshot.workflow;
  const completedLegacyTask = legacySnapshot.tasks.find(
    (task) => task.taskId === "task_stage_1_design_clarification"
  );
  assert.ok(completedLegacyTask);
  completedLegacyTask.status = "done";
  completedLegacyTask.progressPercent = 100;
  const canonicalId = "artifact_gdd_baseline_draft";
  const canonicalPath = "agents/design/gdd/00_overview.md";
  const dynamicId = stableArtifactId(legacy.project.projectId, "game_designer", canonicalPath);
  rewriteSnapshotArtifactId(legacySnapshot, canonicalId, dynamicId);
  const legacyDirectory = join(tempRoot, legacy.project.projectId);
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "studio-state.json"), `${JSON.stringify(legacySnapshot, null, 2)}\n`, "utf8");

  const migrating = new ProjectPersistenceStore(tempRoot);
  const migratedKernel = migrating.load(legacy.project.projectId);
  assert.ok(migratedKernel?.listArtifacts().some((artifact) => artifact.artifactId === canonicalId));
  assert.ok(!migratedKernel?.listArtifacts().some((artifact) => artifact.artifactId === dynamicId));
  assert.equal(migratedKernel?.project.currentStage, "production");
  assert.equal(
    migratedKernel?.findTask("task_stage_1_design_clarification")?.status,
    "done",
    "production identity-only migration must not reopen completed Stage 1 work"
  );
  const migratedPrimary = JSON.parse(readFileSync(join(legacyDirectory, "studio-state.json"), "utf8"));
  const migrationBackup = JSON.parse(readFileSync(join(legacyDirectory, "studio-state.backup.json"), "utf8"));
  assert.ok(migratedPrimary.artifacts.some((artifact) => artifact.artifactId === canonicalId));
  assert.ok(migrationBackup.artifacts.some((artifact) => artifact.artifactId === dynamicId));

  assert.throws(() => isolated.load("../escape"), /Invalid project ID/);
  assert.throws(() => isolated.delete("project/escape"), /Invalid project ID/);
  const unsafeKernel = createStudioKernel("../escape", "Unsafe", "producer");
  assert.throws(() => isolated.save(unsafeKernel), /Invalid project ID/);

  if (process.platform !== "win32") {
    assert.equal(statSync(tempRoot).mode & 0o777, 0o700);
    assert.equal(statSync(alphaDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(primaryPath).mode & 0o777, 0o600);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
  }

  process.stdout.write(
    "Project persistence passed: atomic save, restart, backup recovery, alias migration, corruption isolation, safe paths, private permissions\n"
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function stableArtifactId(projectId, ownerAgentId, path) {
  return `artifact_${createHash("sha1").update(`${projectId}:${ownerAgentId}:${path}`).digest("hex").slice(0, 12)}`;
}

function rewriteSnapshotArtifactId(snapshot, fromArtifactId, toArtifactId) {
  const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === fromArtifactId);
  assert.ok(artifact);
  artifact.artifactId = toArtifactId;
  for (const task of snapshot.tasks) {
    task.inputArtifacts = task.inputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
    task.outputArtifacts = task.outputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
  }
  for (const operation of snapshot.artifactOperations) {
    if (operation.artifactId === fromArtifactId) operation.artifactId = toArtifactId;
  }
  for (const ledger of snapshot.artifactLedger) {
    if (ledger.artifactId === fromArtifactId) ledger.artifactId = toArtifactId;
  }
  for (const event of snapshot.auditEvents) {
    event.inputArtifacts = event.inputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
    event.outputArtifacts = event.outputArtifacts.map((artifactId) => artifactId === fromArtifactId ? toArtifactId : artifactId);
  }
}
