import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStudioKernel } from "@game-pipeline/agent-runtime";
import { CocosEngineBridge } from "../apps/api/dist/cocosEngineBridge.js";
import { captureWorkspaceSnapshot } from "../apps/api/dist/harnessWorkspaceEvidence.js";
import { resolvePathWithinRoot } from "../apps/api/dist/pathSafety.js";
import { loadPlaytestContract } from "../apps/api/dist/playtestContractLoader.js";
import {
  readWorkspaceTree,
  resolveProjectWorkspaceRoot,
  resolveWorkspacePathTarget,
  syncProjectWorkspace,
  writeToolArtifactContent
} from "../apps/api/dist/workspaceWriter.js";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-path-safety-"));
try {
  const outside = join(tempRoot, "outside");
  const workspaceRoot = join(tempRoot, "workspaces");
  mkdirSync(outside, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const outsideSentinel = join(outside, "sentinel.txt");
  writeFileSync(outsideSentinel, "outside-original\n", "utf8");

  const projectId = "path_safety_project";
  const kernel = createStudioKernel(projectId, "Path Safety", "producer_test", "path safety regression");
  const synced = syncProjectWorkspace(kernel, workspaceRoot);
  const projectRoot = synced.projectRoot;
  const now = new Date().toISOString();
  const safeArtifact = artifact({
    artifactId: "artifact_safe_path",
    projectId,
    path: "agents/design/path-safety/safe.md",
    now
  });
  const safeWrite = writeToolArtifactContent(kernel, safeArtifact, { content: "safe", mode: "replace" }, workspaceRoot);
  assert.match(safeWrite.content, /^safe/m);

  symlinkSync(outside, join(projectRoot, "escape"), "dir");
  const escapingArtifact = artifact({
    artifactId: "artifact_escape_path",
    projectId,
    path: "escape/sentinel.txt",
    now
  });
  assert.throws(
    () => writeToolArtifactContent(kernel, escapingArtifact, { content: "compromised", mode: "replace" }, workspaceRoot),
    /符号链接/
  );
  assert.equal(readFileSync(outsideSentinel, "utf8"), "outside-original\n", "workspace write must not alter symlink destination");
  assert.throws(() => resolveWorkspacePathTarget(projectId, "escape/sentinel.txt", workspaceRoot), /符号链接/);
  assert.throws(() => readWorkspaceTree(projectId, workspaceRoot), /符号链接/);
  assert.throws(() => captureWorkspaceSnapshot(projectRoot), /符号链接/);

  const mcpRoot = join(tempRoot, "mcp-project");
  mkdirSync(join(mcpRoot, "agents"), { recursive: true });
  symlinkSync(outside, join(mcpRoot, "agents", "design"), "dir");
  const mcpSentinel = join(outside, "mcp-notes.md");
  writeFileSync(mcpSentinel, "mcp-outside-original\n", "utf8");
  const mcpAuthorization = {
    mode: "task",
    taskId: "task_path_safety",
    inputArtifactIds: [],
    outputArtifactIds: ["artifact_mcp_path_safety"],
    artifacts: [{
      artifactId: "artifact_mcp_path_safety",
      type: "gdd",
      path: "agents/design/mcp-notes.md",
      ownerAgentId: "game_designer",
      sourceTaskId: "task_path_safety"
    }],
    readRoots: [],
    serviceReadPaths: [],
    serviceWritePaths: []
  };
  const mcp = spawnSync(process.execPath, [join(process.cwd(), "apps/api/dist/harnessMcpServer.js")], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "write_artifact",
        arguments: { path: "agents/design/mcp-notes.md", content: "compromised" }
      }
    })}\n`,
    env: {
      ...process.env,
      BTP_PROJECT_ROOT: mcpRoot,
      BTP_AGENT_ID: "game_designer",
      BTP_TOOL_MODE: "task",
      BTP_AUTHORIZATION: JSON.stringify(mcpAuthorization)
    }
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const mcpResponse = JSON.parse(mcp.stdout.trim());
  assert.equal(mcpResponse.result?.isError, true, mcp.stdout);
  assert.match(mcpResponse.result?.content?.[0]?.text ?? "", /符号链接/);
  assert.equal(readFileSync(mcpSentinel, "utf8"), "mcp-outside-original\n", "MCP write must not alter symlink destination");

  const dangling = join(projectRoot, "dangling");
  symlinkSync(join(outside, "missing"), dangling, "dir");
  assert.throws(
    () => resolvePathWithinRoot(projectRoot, "dangling/file.txt", { allowMissing: true }),
    /符号链接/
  );

  const linkedProjectId = "linked_project";
  symlinkSync(outside, join(workspaceRoot, linkedProjectId), "dir");
  assert.throws(() => resolveProjectWorkspaceRoot(linkedProjectId, workspaceRoot), /符号链接/);
  assert.equal(readFileSync(outsideSentinel, "utf8"), "outside-original\n");

  const cocosRoot = join(tempRoot, "cocos");
  mkdirSync(join(cocosRoot, "assets", "art"), { recursive: true });
  mkdirSync(join(cocosRoot, "assets", "resources"), { recursive: true });
  mkdirSync(join(cocosRoot, "agents", "art"), { recursive: true });
  mkdirSync(join(cocosRoot, "settings"), { recursive: true });
  writeFileSync(join(cocosRoot, "package.json"), JSON.stringify({ creator: { version: "3.8.7" } }), "utf8");
  writeFileSync(
    join(cocosRoot, "assets", "art", "safe.png"),
    Buffer.from("89504e470d0a1a0a", "hex")
  );
  writeFileSync(
    join(cocosRoot, "agents", "art", "asset-manifest.json"),
    JSON.stringify({ assets: [{ id: "outside", runtimePath: "assets/art/safe.png" }] }),
    "utf8"
  );
  const outsideImportRoot = join(outside, "cocos-destination");
  mkdirSync(outsideImportRoot, { recursive: true });
  symlinkSync(outsideImportRoot, join(cocosRoot, "assets", "resources", "btp-art"), "dir");
  const bridge = new CocosEngineBridge(cocosRoot, {
    executablePath: "",
    version: "3.8.7",
    platform: "wechatgame",
    buildConfigPath: "",
    timeoutMs: 60_000
  });
  const importResult = bridge.importAssets();
  assert.equal(importResult.ok, false);
  assert.match(importResult.error ?? "", /符号链接/);
  assert.equal(existsSync(join(outsideImportRoot, "outside.png")), false, "Cocos import must not write through a linked destination");

  const qaRoot = join(tempRoot, "qa");
  const outsideContracts = join(outside, "contracts");
  mkdirSync(join(qaRoot, "agents", "qa"), { recursive: true });
  mkdirSync(outsideContracts, { recursive: true });
  writeFileSync(join(outsideContracts, "core-loop.playtest-contract.json"), "{}\n", "utf8");
  symlinkSync(outsideContracts, join(qaRoot, "agents", "qa", "contracts"), "dir");
  assert.throws(
    () => loadPlaytestContract(qaRoot, "agents/qa/contracts/core-loop.playtest-contract.json"),
    /符号链接/
  );

  console.log("Path safety verification passed: workspace/MCP reads and writes, Harness scans, Cocos import, and QA contract reads reject symlink traversal without modifying external targets.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function artifact({ artifactId, projectId, path, now }) {
  return {
    artifactId,
    projectId,
    type: "gdd",
    path,
    ownerAgentId: "game_designer",
    stageId: "concept_discussion",
    status: "draft",
    version: 1,
    sourceDecisionIds: [],
    metadata: {},
    createdAt: now,
    updatedAt: now
  };
}
