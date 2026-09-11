import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  CocosEngineBridge,
  minimalCreatorEnvironment,
  verifyCocosBuildImportReceipt,
  verifyCocosBuildManifest
} from "../apps/api/dist/cocosEngineBridge.js";
import { CocosEngineSettingsStore } from "../apps/api/dist/cocosEngineSettings.js";
import { artifactReadyForConsumption, taskOutputsVerified } from "../apps/api/dist/taskOutputEvidence.js";
import { createStudioKernel, defaultAgentContracts } from "../packages/agent-runtime/dist/index.js";
import { captureWorkspaceSnapshot, recordHarnessWorkspaceChanges, analyzeHarnessWorkspaceChanges } from "../apps/api/dist/harnessWorkspaceEvidence.js";
import { reconcileCocosSupportingEvidence } from "../apps/api/dist/cocosSupportingEvidence.js";

const root = mkdtempSync(join(tmpdir(), "btp-cocos-bridge-"));
const projectRoot = join(root, "project");
const settingsRoot = join(root, "settings");
process.env.STUDIO_WORKSPACE_ROOT = root;
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
      schemaVersion: "1.0.0",
      kind: "scene_blueprint",
      blueprintId: "tile_puzzle.scenes",
      revision: 1,
      gameContract: { contractId: "tile_puzzle.contract", revision: 1 },
      entrySceneId: "puzzle_room",
      prefabs: [],
      scenes: [{
        sceneId: "puzzle_room",
        name: "PuzzleRoom",
        role: "gameplay",
        nodes: [
          {
            nodeId: "board",
            testId: "puzzle_board",
            name: "PuzzleBoard",
            kind: "sprite",
            transform: { position: [0, 0], rotation: 0, scale: [1, 1], size: [750, 1334] },
            components: [{
              componentId: "board_sprite",
              type: "cc.Sprite",
              properties: { assetKey: "ball", fallbackColor: "#334455" },
              bindings: [],
              references: []
            }],
            tags: ["gameplay"]
          },
          {
            nodeId: "move_counter",
            testId: "move_counter",
            name: "MoveCounter",
            kind: "label",
            parentNodeId: "board",
            transform: { position: [0, 580], rotation: 0, scale: [1, 1], size: [300, 80] },
            components: [{
              componentId: "counter_label",
              type: "cc.Label",
              properties: { string: "Moves: 0", fontSize: 48, color: "#FF6B6B" },
              bindings: [],
              references: []
            }],
            tags: ["hud"]
          },
          {
            nodeId: "controller",
            testId: "puzzle_controller",
            name: "PuzzleController",
            kind: "custom",
            transform: { position: [0, 0], rotation: 0, scale: [1, 1], size: [1, 1] },
            components: [{
              componentId: "game_controller",
              type: "GameController",
              properties: { boardSize: 4 },
              bindings: [{ property: "progressSignal", source: { type: "runtime_signal", ref: "moves" } }],
              references: [{ property: "board_node", kind: "node", sceneId: "puzzle_room", nodeId: "board" }]
            }],
            tags: ["controller"]
          }
        ]
      }]
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
const creatorEnvironment = minimalCreatorEnvironment({
  PATH: "/bin",
  HOME: "/tmp/home",
  LANG: "C.UTF-8",
  BTP_API_TOKEN: "must-not-leak",
  OPENAI_API_KEY: "must-not-leak",
  MODEL_SECRET: "must-not-leak"
});
assert.equal(creatorEnvironment.PATH, "/bin");
assert.equal(creatorEnvironment.CI, "1");
assert.equal(creatorEnvironment.BTP_API_TOKEN, undefined);
assert.equal(creatorEnvironment.OPENAI_API_KEY, undefined);
assert.equal(creatorEnvironment.MODEL_SECRET, undefined);
const initialValidation = bridge.validateProject();
assert.equal(initialValidation.ok, true, initialValidation.error);
assert.equal(initialValidation.details.buildReady, false);

const imported = bridge.importAssets();
assert.equal(imported.ok, true, imported.error);
assert.equal(existsSync(join(projectRoot, "assets", "resources", "btp-art", "ball.png")), true);
assert.equal(existsSync(join(projectRoot, "assets", "resources", "btp", "asset-map.json")), true);
const currentReceiptPath = join(projectRoot, "agents", "cocos-automation", "imports", "current.json");
assert.equal(existsSync(currentReceiptPath), true);
const initialReceipt = JSON.parse(readFileSync(currentReceiptPath, "utf8"));
assert.equal(initialReceipt.kind, "cocos_asset_import_receipt");
assert.equal(initialReceipt.schemaVersion, 1);
assert.equal(initialReceipt.manifest.path, "agents/art/asset-manifest.json");
assert.equal(initialReceipt.imported.length, 1);
assert.deepEqual(initialReceipt.imported[0].source, {
  path: "assets/art/ball.png",
  hash: initialReceipt.imported[0].destination.hash,
  sizeBytes: initialReceipt.imported[0].destination.sizeBytes
});
assert.equal(initialReceipt.imported[0].destination.path, "assets/resources/btp-art/ball.png");
assert.match(initialReceipt.importedDigest, /^[a-f0-9]{64}$/);
const stableAssetMap = readFileSync(join(projectRoot, "assets", "resources", "btp", "asset-map.json"), "utf8");

writeFileSync(
  join(projectRoot, "agents", "art", "missing-last-manifest.json"),
  JSON.stringify({
    assets: [
      { id: "valid-before-missing", runtimePath: "assets/art/ball.png" },
      { id: "missing-last", runtimePath: "assets/art/does-not-exist.png" }
    ]
  }, null, 2)
);
const missingLastImport = bridge.importAssets({ manifestPath: "agents/art/missing-last-manifest.json" });
assert.equal(missingLastImport.ok, false);
assert.match(missingLastImport.error, /does-not-exist\.png|不存在/);
assert.equal(
  existsSync(join(projectRoot, "assets", "resources", "btp-art", "valid-before-missing.png")),
  false,
  "a later missing asset must prevent earlier valid entries from being copied"
);
assert.equal(
  readFileSync(join(projectRoot, "assets", "resources", "btp", "asset-map.json"), "utf8"),
  stableAssetMap,
  "a failed manifest preflight must not replace the last valid asset map"
);
assert.deepEqual(missingLastImport.details.imported, []);
assert.equal(JSON.parse(readFileSync(join(projectRoot, missingLastImport.reportPath), "utf8")).status, "failed");

writeFileSync(join(projectRoot, "assets", "art", "invalid-signature.png"), "not a PNG");
writeFileSync(
  join(projectRoot, "agents", "art", "invalid-last-manifest.json"),
  JSON.stringify({
    assets: [
      { id: "valid-before-invalid", runtimePath: "assets/art/ball.png" },
      { id: "invalid-last", runtimePath: "assets/art/invalid-signature.png" }
    ]
  }, null, 2)
);
const invalidLastImport = bridge.importAssets({ manifestPath: "agents/art/invalid-last-manifest.json" });
assert.equal(invalidLastImport.ok, false);
assert.match(invalidLastImport.error, /PNG 文件签名无效|invalid-signature\.png/);
assert.equal(
  existsSync(join(projectRoot, "assets", "resources", "btp-art", "valid-before-invalid.png")),
  false,
  "a later invalid asset must prevent earlier valid entries from being copied"
);
assert.equal(
  readFileSync(join(projectRoot, "assets", "resources", "btp", "asset-map.json"), "utf8"),
  stableAssetMap,
  "an invalid runtime asset must not replace the last valid asset map"
);

writeFileSync(
  join(projectRoot, "assets", "art", "ball-alt.png"),
  readFileSync(join(projectRoot, "assets", "art", "ball.png"))
);
writeFileSync(
  join(projectRoot, "agents", "art", "duplicate-target-manifest.json"),
  JSON.stringify({
    assets: [
      { id: "same/target", runtimePath: "assets/art/ball.png" },
      { id: "same?target", runtimePath: "assets/art/ball-alt.png" }
    ]
  }, null, 2)
);
const duplicateTargetImport = bridge.importAssets({ manifestPath: "agents/art/duplicate-target-manifest.json" });
assert.equal(duplicateTargetImport.ok, false);
assert.match(duplicateTargetImport.error, /重复目标路径/);
assert.equal(existsSync(join(projectRoot, "assets", "resources", "btp-art", "same_target.png")), false);
assert.equal(readFileSync(join(projectRoot, "assets", "resources", "btp", "asset-map.json"), "utf8"), stableAssetMap);

const applied = bridge.applySceneBlueprint();
assert.equal(applied.ok, true, applied.error);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "MainGame.scene")), true);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "MainGame.scene.meta")), true);
assert.equal(existsSync(join(projectRoot, "assets", "scripts", "btp", "BtpRuntimeBootstrap.ts")), true);
const bootstrapSource = readFileSync(join(projectRoot, "assets", "scripts", "btp", "BtpRuntimeBootstrap.ts"), "utf8");
const bootstrapScene = JSON.parse(readFileSync(join(projectRoot, "assets/scenes/MainGame.scene"), "utf8"));
const bootstrapType = bootstrapScene[5].__type__;
// Execute the generated module with both name-only and UUID-instrumented
// compiler identities. Its serialized scene component must resolve in both.
for (const primaryId of ["BtpRuntimeBootstrap", bootstrapType]) {
  const registry = new Map();
  const fixtureExports = {};
  const Component = class {};
  const cc = { Component, _decorator: { ccclass: () => (ctor) => { registry.set(primaryId, ctor); return ctor; } },
    js: { setClassAlias: (ctor, alias) => { assert.ok(!registry.has(alias) || registry.get(alias) === ctor); registry.set(alias, ctor); } } };
  const compiled = ts.transpileModule(bootstrapSource, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true
  } }).outputText;
  runInNewContext(compiled, { exports: fixtureExports, require: (id) => id === "cc" ? cc : { GameController: Component } });
  assert.equal(registry.get(bootstrapType), fixtureExports.BtpRuntimeBootstrap, "scene UUID must resolve without depending on compiler _RF injection");
}
assert.match(bootstrapSource, /GameController/);
assert.match(bootstrapSource, /node\.layer = parent\.layer/);
assert.match(bootstrapSource, /spec\.testId/);
assert.match(bootstrapSource, /spec\.kind/);
assert.match(bootstrapSource, /spec\.components/);
assert.match(bootstrapSource, /reference\.property/);
assert.match(bootstrapSource, /propertyBinding\.source\.ref/);
assert.match(bootstrapSource, /applyComponentProperty/);
assert.match(bootstrapSource, /keeping fallback/);
assert.match(bootstrapSource, /ResolutionPolicy\.SHOW_ALL/);
assert.match(bootstrapSource, /resources\.load\(path, Texture2D/);
assert.match(bootstrapSource, /applyRuntimeProperties/);
assert.match(bootstrapSource, /setSiblingIndex\(siblingIndex\)/, "dependency traversal must not invert painter order");
assert.ok(bootstrapSource.indexOf("setSiblingIndex(siblingIndex)") < bootstrapSource.indexOf("this.applyRuntimeProperties()"));
assert.match(bootstrapSource, /invalid Sprite\.sizeMode/);
assert.doesNotMatch(bootstrapSource, /yarn|basket|joystick|assetAliases/i);
const normalizedDescriptor = JSON.parse(readFileSync(join(projectRoot, "assets", "resources", "btp", "scene-blueprint.json"), "utf8"));
assert.equal(normalizedDescriptor.kind, "scene_blueprint");
assert.equal(normalizedDescriptor.schemaVersion, "1.0.0");
assert.equal(normalizedDescriptor.entrySceneId, "puzzle_room");
assert.ok(normalizedDescriptor.scenes[0].nodes.some((node) => node.testId === "puzzle_board"));
const sceneDocument = JSON.parse(readFileSync(join(projectRoot, "assets", "scenes", "MainGame.scene"), "utf8"));
const cameraDocument = sceneDocument.find((entry) => entry.__type__ === "cc.Camera");
assert.equal(cameraDocument?._clearFlags, 7);
assert.doesNotMatch(bootstrapSource, /kind: 'node' \| 'component' \| 'prefab'/);
assert.doesNotMatch(bootstrapSource, /return reference\.prefabId \?\? null/);
assert.doesNotMatch(bootstrapSource, /return this\.nodes\.get\([^\n]+\) \?\? null/);

const descriptorBeforeUnsupportedApply = readFileSync(
  join(projectRoot, "assets", "resources", "btp", "scene-blueprint.json"),
  "utf8"
);

const multiSceneBlueprint = structuredClone(normalizedDescriptor);
multiSceneBlueprint.blueprintId = "multi_scene.scenes";
multiSceneBlueprint.scenes.push({
  sceneId: "result_room",
  name: "ResultRoom",
  role: "result",
  nodes: [{
    nodeId: "result_root",
    testId: "result_root",
    name: "ResultRoot",
    kind: "container",
    transform: { position: [0, 0], rotation: 0, scale: [1, 1], size: [750, 1334] },
    components: [],
    tags: ["result"]
  }]
});
const multiScenePath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "multi-scene.scene-blueprint.json");
writeFileSync(multiScenePath, JSON.stringify(multiSceneBlueprint, null, 2));
const multiSceneRejected = bridge.applySceneBlueprint({
  blueprintPath: "agents/engineering/cocos-scene-blueprints/multi-scene.scene-blueprint.json",
  scenePath: "assets/scenes/UnsupportedMulti.scene"
});
assert.equal(multiSceneRejected.ok, false);
assert.match(multiSceneRejected.error, /fail-closed|exactly one entry scene|单一 entry scene/i);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "UnsupportedMulti.scene")), false);

const crossSceneBlueprint = structuredClone(multiSceneBlueprint);
crossSceneBlueprint.blueprintId = "cross_scene.scenes";
crossSceneBlueprint.scenes[0].nodes.find((node) => node.nodeId === "controller").components[0].references[0] = {
  property: "result_node",
  kind: "node",
  sceneId: "result_room",
  nodeId: "result_root"
};
const crossScenePath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "cross-scene.scene-blueprint.json");
writeFileSync(crossScenePath, JSON.stringify(crossSceneBlueprint, null, 2));
const crossSceneRejected = bridge.applySceneBlueprint({
  blueprintPath: "agents/engineering/cocos-scene-blueprints/cross-scene.scene-blueprint.json",
  scenePath: "assets/scenes/UnsupportedCrossScene.scene"
});
assert.equal(crossSceneRejected.ok, false);
assert.match(crossSceneRejected.error, /crosses into scene 'result_room'|跨.*scene/i);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "UnsupportedCrossScene.scene")), false);

const prefabNodeBlueprint = structuredClone(normalizedDescriptor);
prefabNodeBlueprint.blueprintId = "prefab_node.scenes";
prefabNodeBlueprint.prefabs = [{
  prefabId: "enemy_card",
  source: "assets/prefabs/EnemyCard.prefab",
  rootNodeId: "enemy_card_root",
  exposedComponentIds: []
}];
prefabNodeBlueprint.scenes[0].nodes.find((node) => node.nodeId === "board").prefabId = "enemy_card";
const prefabNodePath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "prefab-node.scene-blueprint.json");
writeFileSync(prefabNodePath, JSON.stringify(prefabNodeBlueprint, null, 2));
const prefabNodeRejected = bridge.applySceneBlueprint({
  blueprintPath: "agents/engineering/cocos-scene-blueprints/prefab-node.scene-blueprint.json",
  scenePath: "assets/scenes/UnsupportedPrefabNode.scene"
});
assert.equal(prefabNodeRejected.ok, false);
assert.match(prefabNodeRejected.error, /prefabId 'enemy_card'|Prefab instantiation/i);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "UnsupportedPrefabNode.scene")), false);

const prefabReferenceBlueprint = structuredClone(normalizedDescriptor);
prefabReferenceBlueprint.blueprintId = "prefab_reference.scenes";
prefabReferenceBlueprint.prefabs = structuredClone(prefabNodeBlueprint.prefabs);
prefabReferenceBlueprint.scenes[0].nodes.find((node) => node.nodeId === "controller").components[0].references[0] = {
  property: "enemy_card_prefab",
  kind: "prefab",
  prefabId: "enemy_card"
};
const prefabReferencePath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "prefab-reference.scene-blueprint.json");
writeFileSync(prefabReferencePath, JSON.stringify(prefabReferenceBlueprint, null, 2));
const prefabReferenceRejected = bridge.applySceneBlueprint({
  blueprintPath: "agents/engineering/cocos-scene-blueprints/prefab-reference.scene-blueprint.json",
  scenePath: "assets/scenes/UnsupportedPrefabReference.scene"
});
assert.equal(prefabReferenceRejected.ok, false);
assert.match(prefabReferenceRejected.error, /targets Prefab 'enemy_card'|Prefab loading\/binding/i);
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "UnsupportedPrefabReference.scene")), false);
assert.equal(
  readFileSync(join(projectRoot, "assets", "resources", "btp", "scene-blueprint.json"), "utf8"),
  descriptorBeforeUnsupportedApply,
  "unsupported blueprints must not replace the last valid runtime descriptor"
);

const danglingBlueprint = structuredClone(normalizedDescriptor);
danglingBlueprint.blueprintId = "runner.scenes";
danglingBlueprint.scenes[0].name = "RunnerTrack";
danglingBlueprint.scenes[0].nodes.find((node) => node.nodeId === "controller").components[0].references[0].nodeId = "missing_lane";
const danglingPath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "dangling.scene-blueprint.json");
writeFileSync(danglingPath, JSON.stringify(danglingBlueprint, null, 2));
const rejected = bridge.applySceneBlueprint({ blueprintPath: "agents/engineering/cocos-scene-blueprints/dangling.scene-blueprint.json" });
assert.equal(rejected.ok, false);
assert.match(rejected.error, /unknown|reference|引用/i);

const runnerBlueprint = structuredClone(normalizedDescriptor);
runnerBlueprint.blueprintId = "sky_runner.scenes";
runnerBlueprint.gameContract.contractId = "sky_runner.contract";
runnerBlueprint.entrySceneId = "runner_track";
runnerBlueprint.scenes[0].sceneId = "runner_track";
runnerBlueprint.scenes[0].name = "RunnerTrack";
const runnerSurface = runnerBlueprint.scenes[0].nodes.find((node) => node.nodeId === "board");
runnerSurface.nodeId = "track";
runnerSurface.testId = "runner_track";
runnerSurface.name = "Track";
const runnerCounter = runnerBlueprint.scenes[0].nodes.find((node) => node.nodeId === "move_counter");
runnerCounter.parentNodeId = "track";
runnerCounter.testId = "distance_counter";
runnerCounter.name = "DistanceCounter";
const runnerController = runnerBlueprint.scenes[0].nodes.find((node) => node.nodeId === "controller");
runnerController.testId = "runner_controller";
runnerController.components[0].properties = { speed: 8, jumpForce: 14 };
runnerController.components[0].references[0] = {
  property: "track_node",
  kind: "node",
  sceneId: "runner_track",
  nodeId: "track"
};
const runnerPath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "runner.scene-blueprint.json");
writeFileSync(runnerPath, JSON.stringify(runnerBlueprint, null, 2));
const runnerApplied = bridge.applySceneBlueprint({
  blueprintPath: "agents/engineering/cocos-scene-blueprints/runner.scene-blueprint.json",
  scenePath: "assets/scenes/Runner.scene"
});
assert.equal(runnerApplied.ok, true, runnerApplied.error);
assert.equal(runnerApplied.details.blueprintId, "sky_runner.scenes");
assert.equal(existsSync(join(projectRoot, "assets", "scenes", "Runner.scene")), true);

const legacyBlueprint = {
  scene: { name: "LegacyArcade", designResolution: { width: 750, height: 1334 } },
  nodeHierarchy: {
    root: {
      name: "Canvas",
      children: [
        { id: "playfield", name: "Playfield", type: "Sprite", asset_key: "ball", size: [750, 1334] },
        {
          id: "legacy_controller",
          name: "LegacyController",
          components: ["GameController"],
          properties: { speed: 5 },
          references: { playfield_node: "Canvas/Playfield" }
        }
      ]
    }
  }
};
const legacyPath = join(projectRoot, "agents", "engineering", "cocos-scene-blueprints", "legacy.scene-blueprint.json");
writeFileSync(legacyPath, JSON.stringify(legacyBlueprint, null, 2));
const legacyApplied = bridge.applySceneBlueprint({
  blueprintPath: "agents/engineering/cocos-scene-blueprints/legacy.scene-blueprint.json",
  scenePath: "assets/scenes/Legacy.scene"
});
assert.equal(legacyApplied.ok, true, legacyApplied.error);
const legacyDescriptor = JSON.parse(readFileSync(join(projectRoot, "assets", "resources", "btp", "scene-blueprint.json"), "utf8"));
assert.equal(legacyDescriptor.kind, "scene_blueprint");
assert.equal(legacyDescriptor.schemaVersion, "1.0.0");

const readyValidation = bridge.validateProject();
assert.equal(readyValidation.ok, true, readyValidation.error);
assert.equal(readyValidation.details.buildReady, true);

// A was imported. Change both the canonical manifest and source bytes to B;
// build must refuse to run Creator until B receives a fresh import receipt.
const ballPath = join(projectRoot, "assets", "art", "ball.png");
writeFileSync(ballPath, Buffer.concat([readFileSync(ballPath), Buffer.from("runtime-variant-b")]));
writeFileSync(
  join(projectRoot, "agents", "art", "asset-manifest.json"),
  JSON.stringify({ schemaVersion: 1, revision: 2, assets: { sprites: [{ id: "ball", runtimePath: "assets/art/ball.png", status: "ready" }] } }, null, 2)
);
const staleImportBuild = bridge.build();
assert.equal(staleImportBuild.ok, false);
assert.match(staleImportBuild.error, /导入收据|重新导入|asset manifest/);
assert.equal(
  existsSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js")),
  false,
  "Creator must not run when manifest/source B is newer than import A"
);

const importedB = bridge.importAssets();
assert.equal(importedB.ok, true, importedB.error);
const buildB = bridge.build();
assert.equal(buildB.ok, true, buildB.error);
const buildBReport = JSON.parse(readFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "build-report.json"), "utf8"));
assert.equal(buildBReport.importReceipt.operationId, importedB.operationId);
assert.equal(buildBReport.importReceipt.receipt.path, "agents/cocos-automation/imports/current.json");
assert.equal(buildBReport.importReceipt.importedDigest, importedB.details.importReceipt.importedDigest);
assert.equal(verifyCocosBuildImportReceipt(projectRoot, buildBReport.importReceipt), true);

// Destination bytes are part of the receipt too; a post-import mutation must
// invalidate build even while manifest and source remain unchanged.
const importedDestination = join(projectRoot, "assets", "resources", "btp-art", "ball.png");
writeFileSync(importedDestination, Buffer.concat([readFileSync(importedDestination), Buffer.from("tampered-destination")]));
assert.equal(
  verifyCocosBuildImportReceipt(projectRoot, buildBReport.importReceipt),
  false,
  "a destination mutation must invalidate the successful build's import provenance"
);
const tamperedDestinationBuild = bridge.build();
assert.equal(tamperedDestinationBuild.ok, false);
assert.match(tamperedDestinationBuild.error, /导入目标已变化|相同字节|重新导入/);

const repairedImport = bridge.importAssets();
assert.equal(repairedImport.ok, true, repairedImport.error);
assert.equal(
  verifyCocosBuildImportReceipt(projectRoot, buildBReport.importReceipt),
  false,
  "a newer successful import must invalidate a build bound to the previous receipt operation"
);
const build = bridge.build();
assert.equal(build.ok, true, build.error);
assert.equal(existsSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js")), true);
const report = JSON.parse(readFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "build-report.json"), "utf8"));
assert.equal(report.status, "success");
assert.equal(verifyCocosBuildImportReceipt(projectRoot, report.importReceipt), true);
assert.equal(report.exitCode, 36);
assert.ok(report.outputFiles.includes("shared/build-artifacts/wechat/dev/game.js"));
assert.equal(report.outputManifest.schemaVersion, 1);
assert.ok(report.outputManifest.files.some((entry) => entry.path.endsWith("/game.js") && entry.hash && entry.sizeBytes > 0));
assert.match(report.outputManifest.digest, /^[a-f0-9]{64}$/);
assert.equal(verifyCocosBuildManifest(projectRoot, report.outputManifest), true);

// The artifact gate must consume the same binding from build-report.json and
// must invalidate this build as soon as a newer import receipt replaces it.
const provenanceKernel = createStudioKernel("project", "Cocos receipt provenance", "producer_test", "receipt gate");
const provenanceNow = new Date().toISOString();
provenanceKernel.addTask({
  taskId: "task_stage_2_cocos_build",
  projectId: provenanceKernel.project.projectId,
  stageId: provenanceKernel.project.currentStage,
  roomId: provenanceKernel.getRoom("engineering-room").roomId,
  taskLevel: "task",
  ownerAgentId: "cocos_automation",
  title: "Cocos build receipt fixture",
  description: "Verify current import provenance",
  status: "doing",
  priority: 1,
  sortOrder: 1,
  progressPercent: 50,
  childrenSummary: { doing: 0, blocked: 0, todo: 0, done: 0, cancelled: 0 },
  inputArtifacts: [],
  outputArtifacts: ["artifact_wechat_dev_build"],
  acceptanceCriteria: [],
  blockers: [],
  createdAt: provenanceNow,
  updatedAt: provenanceNow
});
provenanceKernel.addArtifact({
  artifactId: "artifact_wechat_dev_build",
  projectId: provenanceKernel.project.projectId,
  type: "build",
  path: "shared/build-artifacts/wechat/dev",
  ownerAgentId: "cocos_automation",
  stageId: provenanceKernel.project.currentStage,
  status: "submitted",
  version: 1,
  sourceTaskId: "task_stage_2_cocos_build",
  sourceDecisionIds: [],
  metadata: {
    toolName: "cocos_build",
    toolExecutedAt: provenanceNow,
    bridgeOperationId: build.operationId,
    bridgeOperationType: "build",
    bridgeOk: true
  },
  createdAt: provenanceNow,
  updatedAt: provenanceNow
});
const buildReportBytes = readFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "build-report.json"));
provenanceKernel.recordArtifactMaterialization("artifact_wechat_dev_build", {
  path: "shared/build-artifacts/wechat/dev/build-report.json",
  hash: createHash("sha256").update(buildReportBytes).digest("hex"),
  sizeBytes: statSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "build-report.json")).size,
  materializedAt: provenanceNow,
  directoryManifest: report.outputManifest
});
assert.equal(artifactReadyForConsumption(provenanceKernel, "artifact_wechat_dev_build"), true);
const buildSnapshot = captureWorkspaceSnapshot(projectRoot);
const buildPaths = [...buildSnapshot.keys()].filter((path) => path.startsWith("shared/build-artifacts/wechat/dev/"));
const buildTask = provenanceKernel.findTask("task_stage_2_cocos_build");
const buildOperations = build.evidence.map((item) => ({
  toolName: "cocos_build", ...item, status: "completed", bridgeOk: true,
  operationId: build.operationId, operationType: "build",
  ...(item.path === build.reportPath ? { directoryManifest: report.outputManifest } : {})
}));
const previousBuild = new Map(buildSnapshot);
const oldChunkPath = "shared/build-artifacts/wechat/dev/old-hash-chunk.js";
previousBuild.set(oldChunkPath, { path: oldChunkPath, hash: "old", sizeBytes: 3 });
const cocosAgent = defaultAgentContracts.find((agent) => agent.agentId === "cocos_automation");
const replacement = analyzeHarnessWorkspaceChanges(provenanceKernel, buildTask, cocosAgent,
  previousBuild, buildSnapshot, buildPaths, buildOperations);
assert.deepEqual(replacement.deletedPaths, [oldChunkPath]);
assert.deepEqual(replacement.violations, [], "a successful exact new build manifest authorizes replacing obsolete build files");
for (const badOperations of [[], buildOperations.map(op => ({ ...op, bridgeOk: false })),
  buildOperations.map(op => ({ ...op, hash: "0".repeat(64) }))]) {
  assert.ok(analyzeHarnessWorkspaceChanges(provenanceKernel, buildTask, cocosAgent,
    previousBuild, buildSnapshot, buildPaths, badOperations).violations.some(v => v.includes(oldChunkPath)));
}
const deletedSource = new Map(buildSnapshot);
deletedSource.delete("assets/scripts/gameplay/GameController.ts");
assert.ok(analyzeHarnessWorkspaceChanges(provenanceKernel, buildTask, cocosAgent,
  buildSnapshot, deletedSource, buildPaths, buildOperations).violations.some(v => v.includes("assets/scripts/gameplay/GameController.ts")),
  "successful build does not authorize source deletion");
const harnessEvidence = recordHarnessWorkspaceChanges(provenanceKernel, buildTask,
  defaultAgentContracts.find((agent) => agent.agentId === "cocos_automation"), buildSnapshot, buildSnapshot,
  "inv_build_directory", buildPaths, buildOperations);
assert.deepEqual(harnessEvidence.violations, []);
assert.deepEqual(harnessEvidence.artifactIds, ["artifact_wechat_dev_build"]);
assert.equal(artifactReadyForConsumption(provenanceKernel, "artifact_wechat_dev_build"), true,
  "bundle files after build-report.json must not overwrite the aggregate build receipt");
assert.equal(provenanceKernel.listArtifacts().find(a => a.artifactId === "artifact_wechat_dev_build").metadata.bridgeOk, true);
assert.equal(provenanceKernel.listArtifactLedger().find(a => a.artifactId === "artifact_wechat_dev_build").directoryManifest.digest, report.outputManifest.digest);

const historic = { ...provenanceKernel.listArtifacts().find(a => a.artifactId === "artifact_wechat_dev_build"),
  artifactId: "historic_import", type: "asset_spec", path: "agents/cocos-automation/imports/cocos_import_20260911000000_abcdef12.json",
  status: "change_requested", metadata: {} };
provenanceKernel.upsertArtifact(historic);
assert.ok(provenanceKernel.findTask(buildTask.taskId).outputArtifacts.includes(historic.artifactId), "reproduce legacy sidecar attachment");
reconcileCocosSupportingEvidence(provenanceKernel);
const supporting = provenanceKernel.listArtifacts().find(a => a.artifactId === historic.artifactId);
assert.equal(supporting.status, "change_requested", "migration does not fake historical approval");
assert.equal(supporting.sourceTaskId, buildTask.taskId, "source provenance remains intact");
provenanceKernel.upsertArtifact(supporting); // Workspace synchronization must not reattach it.
reconcileCocosSupportingEvidence(provenanceKernel);
assert.deepEqual(provenanceKernel.findTask(buildTask.taskId).outputArtifacts, ["artifact_wechat_dev_build"]);
assert.equal(taskOutputsVerified(provenanceKernel, provenanceKernel.findTask(buildTask.taskId)), true,
  "historical bridge sidecars are not additional build deliverables");
const newerImport = bridge.importAssets();
assert.equal(newerImport.ok, true, newerImport.error);
assert.equal(
  artifactReadyForConsumption(provenanceKernel, "artifact_wechat_dev_build"),
  false,
  "a newer canonical import receipt must make the previous build artifact stale"
);

writeFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js"), "tampered");
assert.equal(verifyCocosBuildManifest(projectRoot, report.outputManifest), false, "bundle bytes changed while report remains untouched");
writeFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js"), "window.__BTP_COCOS_BUILD__ = true;\n");
assert.equal(verifyCocosBuildManifest(projectRoot, report.outputManifest), true);
rmSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js"));
assert.equal(verifyCocosBuildManifest(projectRoot, report.outputManifest), false, "deleted bundle file must invalidate a successful build report");
writeFileSync(join(projectRoot, "shared", "build-artifacts", "wechat", "dev", "game.js"), "window.__BTP_COCOS_BUILD__ = true;\n");

const invalidOutput = bridge.build({ outputDir: "../outside" });
assert.equal(invalidOutput.ok, false);
assert.match(invalidOutput.error, /不安全|必须位于/);

const operationLogPath = join(root, "mcp-operations.jsonl");
const mcpAuthorization = {
  mode: "task",
  taskId: "task_cocos_bridge_fixture",
  inputArtifactIds: ["artifact_manifest", "artifact_blueprint"],
  outputArtifactIds: ["artifact_build"],
  artifacts: [
    { artifactId: "artifact_manifest", type: "asset_manifest", path: "agents/art/asset-manifest.json", ownerAgentId: "asset_production" },
    { artifactId: "artifact_blueprint", type: "scene_blueprint", path: "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json", ownerAgentId: "cocos_tech_lead" },
    { artifactId: "artifact_build", type: "build", path: "shared/build-artifacts/wechat/dev", ownerAgentId: "cocos_automation", sourceTaskId: "task_cocos_bridge_fixture" }
  ],
  readRoots: [],
  serviceReadPaths: ["package.json", "assets", "settings"],
  serviceWritePaths: ["agents/cocos-automation", "assets/resources", "assets/scripts/btp", "assets/scenes", "shared/build-artifacts"]
};
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
    BTP_TOOL_MODE: "task",
    BTP_AUTHORIZATION: JSON.stringify(mcpAuthorization),
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
