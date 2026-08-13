import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "game-pipeline-persistence-"));

try {
  const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
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
    "Project persistence passed: atomic save, restart, backup recovery, corruption isolation, safe paths, private permissions\n"
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
