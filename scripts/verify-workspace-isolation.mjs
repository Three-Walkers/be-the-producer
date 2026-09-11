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
    const oldChunk = "shared/build-artifacts/wechat/dev/old-chunk.js";
    mkdirSync(join(canonical, "shared/build-artifacts/wechat/dev"), { recursive: true });
    writeFileSync(join(canonical, oldChunk), "old build bytes\n");
    const replacement = stageWorkspaceCommit(canonical, isolated.root, [], [oldChunk]);
    assert.equal(existsSync(join(canonical, oldChunk)), false);
    replacement.rollback();
    assert.equal(readFileSync(join(canonical, oldChunk), "utf8"), "old build bytes\n");
    assert.throws(() => stageWorkspaceCommit(canonical, isolated.root, ["missing-new-file.js"], [oldChunk]));
    assert.equal(readFileSync(join(canonical, oldChunk), "utf8"), "old build bytes\n", "failed replacement restores deleted files atomically");
    stageWorkspaceCommit(canonical, isolated.root, [], [oldChunk]).finalize();
    assert.equal(existsSync(join(canonical, oldChunk)), false);
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
