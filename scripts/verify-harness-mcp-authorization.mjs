import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "btp-harness-mcp-auth-"));
const projectRoot = join(root, "project");
const serverPath = resolve("apps/api/dist/harnessMcpServer.js");
const operationLog = join(root, "operations.jsonl");
const ownPath = "assets/scripts/gameplay/Own.ts";
const foreignPath = "assets/scripts/gameplay/Foreign.ts";
mkdirSync(join(projectRoot, "assets/scripts/gameplay"), { recursive: true });
writeFileSync(join(projectRoot, ownPath), "export const own = 1;\n");
writeFileSync(join(projectRoot, foreignPath), "export const foreign = 7;\n");
const foreignBefore = readFileSync(join(projectRoot, foreignPath));

const gameplayAuthorization = {
  mode: "task",
  taskId: "task_gameplay_a",
  inputArtifactIds: [],
  outputArtifactIds: ["artifact_own"],
  artifacts: [
    { artifactId: "artifact_own", type: "source_code", path: ownPath, ownerAgentId: "gameplay_programmer", sourceTaskId: "task_gameplay_a" },
    { artifactId: "artifact_foreign", type: "source_code", path: foreignPath, ownerAgentId: "gameplay_programmer", sourceTaskId: "task_gameplay_b" }
  ],
  readRoots: ["assets/scripts"],
  serviceReadPaths: [],
  serviceWritePaths: []
};

try {
  const taskResponses = runMcp(gameplayAuthorization, "gameplay_programmer", [
    rpc(1, "tools/list"),
    rpc(2, "tools/call", { name: "write_artifact", arguments: { path: foreignPath, content: "export const hacked = true;" } }),
    rpc(3, "tools/call", { name: "write_artifact", arguments: { path: ownPath, content: "export const own = 2;" } })
  ]);
  assert.ok(toolNames(taskResponses, 1).includes("write_artifact"));
  assert.equal(taskResponses.get(2)?.result?.isError, true);
  assert.match(taskResponses.get(2)?.result?.content?.[0]?.text ?? "", /无权|授权|输出路径/);
  assert.deepEqual(readFileSync(join(projectRoot, foreignPath)), foreignBefore, "cross-task rejection must happen before bytes change");
  assert.equal(taskResponses.get(3)?.result?.isError, undefined);
  assert.match(readFileSync(join(projectRoot, ownPath), "utf8"), /own = 2/);

  const conversationResponses = runMcp({
    ...gameplayAuthorization,
    mode: "conversation",
    taskId: undefined,
    inputArtifactIds: [],
    outputArtifactIds: [],
    serviceWritePaths: []
  }, "gameplay_programmer", [
    rpc(10, "tools/list"),
    rpc(11, "tools/call", { name: "write_artifact", arguments: { path: ownPath, content: "conversation overwrite" } })
  ]);
  assert.deepEqual(toolNames(conversationResponses, 10).sort(), ["list_files", "read_file"]);
  assert.equal(conversationResponses.get(11)?.result?.isError, true);
  assert.match(readFileSync(join(projectRoot, ownPath), "utf8"), /own = 2/);

  const fakeCreator = join(root, "creator-fail.sh");
  writeFileSync(fakeCreator, "#!/bin/sh\nexit 9\n");
  chmodSync(fakeCreator, 0o755);
  mkdirSync(join(projectRoot, "assets/scenes"), { recursive: true });
  writeFileSync(join(projectRoot, "assets/scenes/Main.scene"), "[]\n");
  writeFileSync(join(projectRoot, "assets/scenes/Main.scene.meta"), '{"uuid":"11111111-1111-4111-8111-111111111111"}\n');
  writeFileSync(join(projectRoot, "package.json"), '{"creator":{"version":"3.8.7"}}\n');
  mkdirSync(join(projectRoot, "settings"), { recursive: true });
  const buildPath = "shared/build-artifacts/wechat/dev";
  const cocosAuthorization = {
    mode: "task",
    taskId: "task_cocos",
    inputArtifactIds: [],
    outputArtifactIds: ["artifact_build"],
    artifacts: [{ artifactId: "artifact_build", type: "build", path: buildPath, ownerAgentId: "cocos_automation", sourceTaskId: "task_cocos" }],
    readRoots: [],
    serviceReadPaths: ["package.json", "settings", "assets/scenes"],
    serviceWritePaths: [buildPath, "agents/cocos-automation/build-ops", "agents/cocos-automation/cocos-build-logs"]
  };
  const failure = runMcp(cocosAuthorization, "cocos_automation", [
    rpc(20, "tools/call", { name: "cocos_build", arguments: { platform: "wechatgame", outputDir: buildPath } })
  ], {
    BTP_OPERATION_LOG_PATH: operationLog,
    BTP_COCOS_EXECUTABLE: fakeCreator,
    BTP_COCOS_VERSION: "3.8.7",
    BTP_COCOS_PLATFORM: "wechatgame",
    BTP_COCOS_TIMEOUT_MS: "5000"
  });
  assert.equal(failure.get(20)?.result?.isError, true);
  const operations = readFileSync(operationLog, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(operations.length > 0);
  assert.ok(operations.every((operation) => operation.status === "failed" && operation.bridgeOk === false));
  assert.ok(operations.every((operation) => operation.operationId && operation.operationType === "build"));

  process.stdout.write("Harness MCP authorization passed: task-bound writes, read-only conversation, failed bridge evidence\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runMcp(authorization, agentId, requests, extraEnv = {}) {
  const result = spawnSync(process.execPath, [serverPath], {
    encoding: "utf8",
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env: {
      ...process.env,
      BTP_PROJECT_ROOT: projectRoot,
      BTP_AGENT_ID: agentId,
      BTP_TOOL_MODE: authorization.mode,
      BTP_AUTHORIZATION: JSON.stringify(authorization),
      ...extraEnv
    }
  });
  assert.equal(result.status, 0, result.stderr);
  return new Map(result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const response = JSON.parse(line);
    return [response.id, response];
  }));
}

function rpc(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

function toolNames(responses, id) {
  return (responses.get(id)?.result?.tools ?? []).map((tool) => tool.name);
}
