import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "btp-asset-raster-"));
const sourcePath = "assets/art/source.svg";
const outputPath = "assets/art/source.png";
const operationLog = join(root, "operations.jsonl");
const authorization = {
  mode: "task",
  taskId: "task_asset_raster",
  inputArtifactIds: ["artifact_svg"],
  outputArtifactIds: [],
  artifacts: [{
    artifactId: "artifact_svg",
    type: "asset",
    path: sourcePath,
    ownerAgentId: "asset_production",
    sourceTaskId: "task_asset_raster"
  }],
  readRoots: [],
  serviceReadPaths: [],
  serviceWritePaths: [outputPath]
};
mkdirSync(join(root, "assets/art"), { recursive: true });
writeFileSync(
  join(root, sourcePath),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><rect width="32" height="16" fill="#f2a6b8"/></svg>\n'
);

const child = spawn(process.execPath, [resolve("apps/api/dist/harnessMcpServer.js")], {
  env: {
    ...process.env,
    BTP_PROJECT_ROOT: root,
    BTP_AGENT_ID: "asset_production",
    BTP_TOOL_MODE: "task",
    BTP_AUTHORIZATION: JSON.stringify(authorization),
    BTP_OPERATION_LOG_PATH: operationLog
  },
  stdio: ["pipe", "pipe", "pipe"]
});
const reader = createInterface({ input: child.stdout });
const pending = new Map();
reader.on("line", (line) => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  if (waiter) {
    pending.delete(response.id);
    waiter(response);
  }
});

let requestId = 0;
function rpc(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 5_000);
    pending.set(id, (response) => {
      clearTimeout(timeout);
      resolveResponse(response);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await rpc("initialize", { protocolVersion: "2025-03-26" });
  const tools = await rpc("tools/list");
  assert(tools.result.tools.some((tool) => tool.name === "render_svg_to_png"));
  const rendered = await rpc("tools/call", {
    name: "render_svg_to_png",
    arguments: { sourcePath, path: outputPath, width: 64 }
  });
  assert.equal(rendered.result.isError, undefined);
  assert.equal(rendered.result.structuredContent.width, 64);
  assert.equal(rendered.result.structuredContent.height, 32);
  assert.deepEqual([...readFileSync(join(root, outputPath)).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const operation = JSON.parse(readFileSync(operationLog, "utf8").trim());
  assert.equal(operation.toolName, "render_svg_to_png");
  assert.equal(operation.path, outputPath);
  console.log("Asset raster smoke passed: authorized SVG rendered to evidenced PNG");
} finally {
  child.stdin.end();
  reader.close();
  child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}
