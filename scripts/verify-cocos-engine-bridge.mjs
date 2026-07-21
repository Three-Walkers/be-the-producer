import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CocosEngineBridge } from "../apps/api/dist/cocosEngineBridge.js";
import { CocosEngineSettingsStore } from "../apps/api/dist/cocosEngineSettings.js";

const root = mkdtempSync(join(tmpdir(), "btp-cocos-bridge-"));
const projectRoot = join(root, "project");
const settingsRoot = join(root, "settings");
mkdirSync(join(projectRoot, "assets", "art"), { recursive: true });
mkdirSync(join(projectRoot, "assets", "scripts", "gameplay"), { recursive: true });
mkdirSync(join(projectRoot, "settings"), { recursive: true });
mkdirSync(join(projectRoot, "agents", "art"), { recursive: true });
mkdirSync(join(projectRoot, "agents", "engineering", "cocos-scene-blueprints"), { recursive: true });

writeFileSync(
  join(projectRoot, "package.json"),
  JSON.stringify({ name: "bridge-test", creator: { version: "3.8.7" } }, null, 2)
);
writeFileSync(
  join(projectRoot, "assets", "scripts", "gameplay", "GameController.ts"),
  "import { _decorator, Component } from 'cc';\nconst { ccclass } = _decorator;\n@ccclass('GameController')\nexport class GameController extends Component {}\n"
);
writeFileSync(
  join(projectRoot, "assets", "art", "ball.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=", "base64")
);
writeFileSync(
  join(projectRoot, "agents", "art", "asset-manifest.json"),
  JSON.stringify({ assets: { sprites: [{ id: "ball", runtimePath: "assets/art/ball.png", status: "ready" }] } }, null, 2)
);
writeFileSync(
  join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "main.scene-blueprint.json"),
  JSON.stringify(
    {
      scene: { name: "MainGame", designResolution: { width: 750, height: 1334, fitWidth: true, fitHeight: false } },
      nodeHierarchy: {
        root: {
          name: "Canvas",
          children: [
            { name: "Background", type: "Sprite", asset_key: "ball", size: { width: 750, height: 1334 } },
            { name: "TimerLabel", components: ["cc.Label"], labelConfig: { defaultText: "01:30", fontSize: 48, color: "#FF6B6B" } },
            { name: "GameController", components: ["GameController"], size: { width: 1, height: 1 } }
          ]
        }
      }
    },
    null,
    2
  )
);

const fakeCreator = join(root, "CocosCreator");
writeFileSync(
  fakeCreator,
  `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Cocos Creator 3.8.7"
  exit 0
fi
project=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--project" ]; then
    shift
    project="$1"
  fi
  shift
done
if [ -z "$project" ]; then
  echo "missing project" >&2
  exit 32
fi
mkdir -p "$project/shared/build-artifacts/wechat/dev"
printf 'window.__BTP_COCOS_BUILD__ = true;\n' > "$project/shared/build-artifacts/wechat/dev/game.js"
printf '{"appid":"touristappid","compileType":"game"}\n' > "$project/shared/build-artifacts/wechat/dev/project.config.json"
echo "fake Creator build completed"
exit 36
`
);
chmodSync(fakeCreator, 0o755);

const settings = new CocosEngineSettingsStore(settingsRoot);
const saved = settings.save({ executablePath: fakeCreator, version: "3.8.7", platform: "wechatgame", timeoutMs: 60_000 });
assert.equal(saved.executableExists, true);
const connection = await settings.test();
assert.equal(connection.ok, true, connection.message);
assert.equal(connection.version, "3.8.7");

const bridge = new CocosEngineBridge(projectRoot, settings.getResolvedConfig({}));
const initialValidation = bridge.validateProject();
assert.equal(initialValidation.ok, true, initialValidation.error);
assert.equal(initialValidation.details.buildReady, false);

const imported = bridge.importAssets();
assert.equal(imported.ok, true, imported.error);
assert.equal(existsSync(join(projectRoot, "assets", "resources", "btp-art", "ball.png")), true);
assert.equal(existsSync(join(projectRoot, "assets", "resources", "btp", "asset-map.json")), true);

const applied = bridge.applySceneBlueprint();
assert.equal(applied.ok, true, applied.error);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "MainGame.scene")), true);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "MainGame.scene.meta")), true);
assert.equal(existsSync(join(projectRoot, "assets", "scripts", "btp", "BtpRuntimeBootstrap.ts")), true);
const bootstrapSource = readFileSync(join(projectRoot, "assets", "scripts", "btp", "BtpRuntimeBootstrap.ts"), "utf8");
assert.match(bootstrapSource, /GameController/);
assert.match(bootstrapSource, /node\.layer = parent\.layer/);
assert.match(bootstrapSource, /spec\.labelConfig\?\.defaultText/);
assert.match(bootstrapSource, /keeping fallback/);
assert.match(bootstrapSource, /ResolutionPolicy\.SHOW_ALL/);
assert.match(bootstrapSource, /resources\.load\(path, Texture2D/);
assert.match(bootstrapSource, /wireRuntimeBindings/);
assert.match(bootstrapSource, /createYarnBallPrefab/);
const sceneDocument = JSON.parse(readFileSync(join(projectRoot, "assets", "scenes", "MainGame.scene"), "utf8"));
const cameraDocument = sceneDocument.find((entry) => entry.__type__ === "cc.Camera");
assert.equal(cameraDocument?._clearFlags, 7);

const readyValidation = bridge.validateProject();
assert.equal(readyValidation.ok, true, readyValidation.error);
assert.equal(readyValidation.details.buildReady, true);

const build = bridge.build();
assert.equal(build.ok, true, build.error);
assert.equal(existsSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js")), true);
const report = JSON.parse(readFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "build-report.json"), "utf8"));
assert.equal(report.status, "success");
assert.equal(report.exitCode, 36);
assert.ok(report.outputFiles.includes("shared/build-artifacts/wechat/dev/game.js"));

const invalidOutput = bridge.build({ outputDir: "../outside" });
assert.equal(invalidOutput.ok, false);
assert.match(invalidOutput.error, /不安全|必须位于/);

const operationLogPath = join(root, "mcp-operations.jsonl");
const rpcRequests = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "cocos_validate_project", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "cocos_import_assets", arguments: {} } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "cocos_apply_blueprint", arguments: {} } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "cocos_build", arguments: { platform: "wechatgame", debug: true } } }
];
const mcp = spawnSync(process.execPath, [join(process.cwd(), "apps", "api", "dist", "harnessMcpServer.js")], {
  encoding: "utf8",
  input: `${rpcRequests.map((request) => JSON.stringify(request)).join("\n")}\n`,
  env: {
    ...process.env,
    BTP_PROJECT_ROOT: projectRoot,
    BTP_AGENT_ID: "cocos_automation",
    BTP_ALLOWED_ROOTS: JSON.stringify(["agents/cocos-automation", "assets", "settings", "shared/build-artifacts"]),
    BTP_EXPECTED_PATHS: JSON.stringify(["shared/build-artifacts/wechat/dev"]),
    BTP_OPERATION_LOG_PATH: operationLogPath,
    BTP_COCOS_EXECUTABLE: fakeCreator,
    BTP_COCOS_VERSION: "3.8.7",
    BTP_COCOS_PLATFORM: "wechatgame",
    BTP_COCOS_TIMEOUT_MS: "60000"
  }
});
assert.equal(mcp.status, 0, mcp.stderr);
const rpcResponses = mcp.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
const tools = rpcResponses.find((response) => response.id === 2)?.result?.tools ?? [];
for (const toolName of ["cocos_validate_project", "cocos_import_assets", "cocos_apply_blueprint", "cocos_build"]) {
  assert.ok(tools.some((tool) => tool.name === toolName), `MCP tool missing: ${toolName}`);
}
for (const responseId of [3, 4, 5, 6]) {
  const response = rpcResponses.find((candidate) => candidate.id === responseId);
  assert.equal(response?.result?.isError, false, JSON.stringify(response));
}
assert.match(readFileSync(operationLogPath, "utf8"), /cocos_build/);

console.log("Cocos Engine Bridge verification passed.");
