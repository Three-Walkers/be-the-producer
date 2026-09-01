import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIsolatedWorkspace, stageWorkspaceCommit } from "../apps/api/dist/isolatedWorkspace.js";

const root = mkdtempSync(join(tmpdir(), "btp-workspace-isolation-test-"));
const canonical = join(root, "canonical");
mkdirSync(join(canonical, "agents/design"), { recursive: true });
writeFileSync(join(canonical, "agents/design/gdd.md"), "original\n", "utf8");

try {
  const isolated = createIsolatedWorkspace(canonical, "design-task");
  try {
    assert.equal(readFileSync(join(isolated.root, "agents/design/gdd.md"), "utf8"), "original\n");
    writeFileSync(join(isolated.root, "agents/design/gdd.md"), "candidate\n", "utf8");
    writeFileSync(join(isolated.root, "agents/design/new.md"), "new candidate\n", "utf8");
    assert.equal(readFileSync(join(canonical, "agents/design/gdd.md"), "utf8"), "original\n");
    assert.equal(existsSync(join(canonical, "agents/design/new.md")), false);

    const rollback = stageWorkspaceCommit(canonical, isolated.root, [
      "agents/design/gdd.md",
      "agents/design/new.md"
    ]);
    assert.equal(readFileSync(join(canonical, "agents/design/gdd.md"), "utf8"), "candidate\n");
    rollback.rollback();
    assert.equal(readFileSync(join(canonical, "agents/design/gdd.md"), "utf8"), "original\n");
    assert.equal(existsSync(join(canonical, "agents/design/new.md")), false);

    const commit = stageWorkspaceCommit(canonical, isolated.root, [
      "agents/design/gdd.md",
      "agents/design/new.md"
    ]);
    commit.finalize();
    assert.equal(readFileSync(join(canonical, "agents/design/gdd.md"), "utf8"), "candidate\n");
    assert.equal(readFileSync(join(canonical, "agents/design/new.md"), "utf8"), "new candidate\n");
  } finally {
    isolated.dispose();
  }

  const unsafe = join(root, "unsafe");
  mkdirSync(unsafe, { recursive: true });
  symlinkSync("/tmp", join(unsafe, "escape"));
  assert.throws(() => createIsolatedWorkspace(unsafe, "unsafe"), /拒绝符号链接/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Workspace isolation passed: copy-on-run staging, rollback, atomic finalize, and symlink rejection");
