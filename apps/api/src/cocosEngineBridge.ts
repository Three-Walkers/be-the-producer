import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { CocosEngineConfig } from "./cocosEngineSettings.js";

export interface CocosBridgeEvidence {
  path: string;
  hash: string;
  sizeBytes: number;
}

export interface CocosBridgeResult {
  ok: boolean;
  operationId: string;
  operationType: "validate_project" | "import_assets" | "apply_scene_blueprint" | "build";
  summary: string;
  reportPath: string;
  evidence: CocosBridgeEvidence[];
  details: Record<string, unknown>;
  error?: string;
}

export interface CocosImportAssetsInput {
  manifestPath?: string;
}

export interface CocosApplyBlueprintInput {
  blueprintPath?: string;
  scenePath?: string;
}

export interface CocosBuildInput {
  platform?: "wechatgame" | "web-desktop";
  debug?: boolean;
  outputDir?: string;
  configPath?: string;
}

interface ManifestAsset {
  id: string;
  runtimePath: string;
  sourcePath?: string;
  status?: string;
}

interface ScriptComponent {
  className: string;
  importPath: string;
}

const defaultManifestPath = "agents/art/asset-manifest.json";
const defaultBlueprintPath = "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json";
const defaultScenePath = "assets/scenes/MainGame.scene";
const defaultBuildOutput = "shared/build-artifacts/wechat/dev";

export class CocosEngineBridge {
  readonly projectRoot: string;

  constructor(projectRoot: string, private readonly config: CocosEngineConfig) {
    this.projectRoot = resolve(projectRoot);
  }

  validateProject(): CocosBridgeResult {
    const operationId = createOperationId("validate");
    const reportPath = `agents/cocos-automation/validation/${operationId}.json`;
    const checks = [
      checkFile(this.projectRoot, "package.json", "Cocos package.json"),
      checkDirectory(this.projectRoot, "assets", "assets 资源目录"),
      checkDirectory(this.projectRoot, "settings", "settings 配置目录"),
      checkCreatorExecutable(this.config.executablePath),
      checkCreatorVersion(this.config.version)
    ];
    const packageCheck = checks[0];
    if (packageCheck?.ok) {
      try {
        const packageDocument = readJsonFile(resolveInsideProject(this.projectRoot, "package.json"));
        const creatorVersion = nestedString(packageDocument, ["creator", "version"]);
        if (!creatorVersion) {
          packageCheck.ok = false;
          packageCheck.message = "package.json 缺少 creator.version。";
        }
      } catch (error) {
        packageCheck.ok = false;
        packageCheck.message = `package.json 无法解析：${errorMessage(error)}`;
      }
    }

    const scenes = listProjectFiles(this.projectRoot, "assets", (path) => path.endsWith(".scene"));
    const scripts = listProjectFiles(this.projectRoot, "assets", (path) => path.endsWith(".ts"));
    const ok = checks.every((check) => check.ok);
    const buildReady = ok && scenes.length > 0;
    const details = {
      projectRoot: this.projectRoot,
      engine: {
        executablePath: this.config.executablePath,
        version: this.config.version,
        configured: Boolean(this.config.executablePath),
        available: Boolean(this.config.executablePath && isExecutable(this.config.executablePath))
      },
      checks,
      scenes,
      scripts: scripts.length,
      buildReady,
      warnings: scenes.length === 0 ? ["工程内尚无 .scene；请先调用 cocos_apply_blueprint。"] : []
    };
    const report = this.writeReport(reportPath, {
      operationId,
      operationType: "validate_project",
      status: ok ? "completed" : "failed",
      createdAt: new Date().toISOString(),
      ...details
    });
    return {
      ok,
      operationId,
      operationType: "validate_project",
      summary: ok
        ? `Cocos 工程结构有效；${buildReady ? `发现 ${scenes.length} 个场景，可进入构建。` : "工程尚未生成场景。"}`
        : "Cocos 工程或 Creator 配置无效，已写入校验报告。",
      reportPath,
      evidence: [report],
      details,
      ...(!ok ? { error: checks.filter((check) => !check.ok).map((check) => check.message).join("；") } : {})
    };
  }

  importAssets(input: CocosImportAssetsInput = {}): CocosBridgeResult {
    const operationId = createOperationId("import");
    const manifestPath = normalizeRelativePath(input.manifestPath ?? defaultManifestPath);
    const reportPath = `agents/cocos-automation/imports/${operationId}.json`;
    const evidence: CocosBridgeEvidence[] = [];
    try {
      const manifestAbsolutePath = resolveInsideProject(this.projectRoot, manifestPath);
      if (!existsSync(manifestAbsolutePath) || !statSync(manifestAbsolutePath).isFile()) {
        throw new Error(`资产清单不存在：${manifestPath}`);
      }
      const manifest = readJsonFile(manifestAbsolutePath);
      const assets = collectManifestAssets(manifest);
      if (assets.length === 0) {
        throw new Error(`资产清单中没有可导入的 runtimePath：${manifestPath}`);
      }

      const imported: Array<Record<string, unknown>> = [];
      const missing: Array<Record<string, unknown>> = [];
      const assetMap: Record<string, string> = {};
      for (const asset of assets) {
        const runtimePath = normalizeRelativePath(asset.runtimePath);
        const source = resolveInsideProject(this.projectRoot, runtimePath);
        if (!existsSync(source) || !statSync(source).isFile()) {
          missing.push({ id: asset.id, runtimePath, reason: "file_not_found" });
          continue;
        }
        assertRuntimeAsset(source, runtimePath);
        const extension = extname(runtimePath).toLowerCase();
        const safeId = safeAssetId(asset.id || basename(runtimePath, extension));
        const destinationPath = `assets/resources/btp-art/${safeId}${extension}`;
        const destination = resolveInsideProject(this.projectRoot, destinationPath);
        mkdirSync(dirname(destination), { recursive: true });
        if (source !== destination) {
          copyFileSync(source, destination);
        }
        const materialized = fileEvidence(this.projectRoot, destinationPath);
        evidence.push(materialized);
        assetMap[asset.id] = `btp-art/${safeId}`;
        imported.push({
          assetId: asset.id,
          sourcePath: runtimePath,
          cocosPath: destinationPath,
          resourcePath: assetMap[asset.id],
          hash: materialized.hash,
          sizeBytes: materialized.sizeBytes
        });
      }

      const mapPath = "assets/resources/btp/asset-map.json";
      evidence.push(this.writeJson(mapPath, { generatedBy: "Be The Producer Cocos Engine Bridge", manifestPath, assets: assetMap }));
      const ok = missing.length === 0;
      const report = this.writeReport(reportPath, {
        operationId,
        operationType: "import_assets",
        status: ok ? "completed" : "failed",
        createdAt: new Date().toISOString(),
        manifestPath,
        imported,
        missing,
        importMode: "copied_to_assets_resources",
        note: "Cocos Creator AssetDB will perform the native import when the project is opened or built."
      });
      evidence.push(report);
      return {
        ok,
        operationId,
        operationType: "import_assets",
        summary: ok ? `已物化 ${imported.length} 个 Cocos runtime 资产，等待 Creator AssetDB 原生导入。` : `资产导入校验失败：${missing.length} 个 runtime 文件不存在。`,
        reportPath,
        evidence,
        details: { manifestPath, imported, missing, assetMap },
        ...(!ok ? { error: `以下 runtime 资产不存在：${missing.map((item) => item.runtimePath).join(", ")}` } : {})
      };
    } catch (error) {
      const failure = this.writeReport(reportPath, {
        operationId,
        operationType: "import_assets",
        status: "failed",
        createdAt: new Date().toISOString(),
        manifestPath,
        error: errorMessage(error)
      });
      return {
        ok: false,
        operationId,
        operationType: "import_assets",
        summary: "Cocos 资产导入失败，已保存失败报告。",
        reportPath,
        evidence: [failure],
        details: { manifestPath },
        error: errorMessage(error)
      };
    }
  }

  applySceneBlueprint(input: CocosApplyBlueprintInput = {}): CocosBridgeResult {
    const operationId = createOperationId("blueprint");
    const blueprintPath = normalizeRelativePath(input.blueprintPath ?? defaultBlueprintPath);
    const scenePath = normalizeScenePath(input.scenePath ?? defaultScenePath);
    const reportPath = `agents/cocos-automation/scene-ops/${operationId}.json`;
    const evidence: CocosBridgeEvidence[] = [];
    try {
      const blueprintAbsolutePath = resolveInsideProject(this.projectRoot, blueprintPath);
      if (!existsSync(blueprintAbsolutePath) || !statSync(blueprintAbsolutePath).isFile()) {
        throw new Error(`SceneBlueprint 不存在：${blueprintPath}`);
      }
      const blueprint = readJsonFile(blueprintAbsolutePath);
      const normalized = normalizeBlueprint(blueprint);
      const scriptComponents = discoverScriptComponents(this.projectRoot);
      const scriptPath = "assets/scripts/btp/BtpRuntimeBootstrap.ts";
      const scriptUuid = deterministicUuid(`${scriptPath}:btp-cocos-bridge`);
      const sceneUuid = deterministicUuid(`${scenePath}:${normalized.sceneName}`);
      const descriptorPath = "assets/resources/btp/scene-blueprint.json";
      const scriptMetaPath = `${scriptPath}.meta`;
      const sceneMetaPath = `${scenePath}.meta`;

      evidence.push(this.writeJson(descriptorPath, normalized));
      evidence.push(this.writeText(scriptPath, renderRuntimeBootstrap(scriptComponents)));
      evidence.push(this.writeJson(scriptMetaPath, typescriptMeta(scriptUuid)));
      evidence.push(this.writeJson(scenePath, createBootstrapScene(normalized, scriptUuid, sceneUuid)));
      evidence.push(this.writeJson(sceneMetaPath, sceneMeta(sceneUuid)));
      const report = this.writeReport(reportPath, {
        operationId,
        operationType: "apply_scene_blueprint",
        status: "completed",
        createdAt: new Date().toISOString(),
        blueprintPath,
        scenePath,
        sceneUuid,
        descriptorPath,
        scriptPath,
        scriptComponents,
        nodeCount: countBlueprintNodes(normalized.root)
      });
      evidence.push(report);
      return {
        ok: true,
        operationId,
        operationType: "apply_scene_blueprint",
        summary: `SceneBlueprint 已通过受控生成器应用到 ${scenePath}；Creator 将在构建时校验序列化、脚本和资源引用。`,
        reportPath,
        evidence,
        details: {
          blueprintPath,
          scenePath,
          sceneUuid,
          descriptorPath,
          scriptPath,
          scriptComponents,
          nodeCount: countBlueprintNodes(normalized.root)
        }
      };
    } catch (error) {
      const failure = this.writeReport(reportPath, {
        operationId,
        operationType: "apply_scene_blueprint",
        status: "failed",
        createdAt: new Date().toISOString(),
        blueprintPath,
        scenePath,
        error: errorMessage(error)
      });
      return {
        ok: false,
        operationId,
        operationType: "apply_scene_blueprint",
        summary: "SceneBlueprint 应用失败，未生成完成声明。",
        reportPath,
        evidence: [failure],
        details: { blueprintPath, scenePath },
        error: errorMessage(error)
      };
    }
  }

  build(input: CocosBuildInput = {}): CocosBridgeResult {
    const operationId = createOperationId("build");
    const platform = input.platform ?? this.config.platform;
    const debug = input.debug ?? true;
    const logPath = `agents/cocos-automation/cocos-build-logs/${operationId}.log`;
    const operationReportPath = `agents/cocos-automation/build-ops/${operationId}.json`;
    let outputDir = defaultBuildOutput;
    let reportPath = operationReportPath;
    const evidence: CocosBridgeEvidence[] = [];
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    try {
      outputDir = normalizeBuildOutput(input.outputDir ?? defaultBuildOutput);
      reportPath = `${outputDir}/build-report.json`;
      if (!this.config.executablePath || !isExecutable(this.config.executablePath)) {
        throw new Error(`Cocos Creator 未配置或不可执行：${this.config.executablePath || "未设置"}`);
      }
      if (platform !== "wechatgame" && platform !== "web-desktop") {
        throw new Error(`当前 Bridge 只允许构建 wechatgame 或 QA 专用 web-desktop，收到：${platform}`);
      }
      const scene = findBuildScene(this.projectRoot);
      if (!scene) {
        throw new Error("工程没有可构建的 .scene 及 .scene.meta。请先调用 cocos_apply_blueprint。");
      }
      const outputAbsolute = resolveInsideProject(this.projectRoot, outputDir);
      const logAbsolute = resolveInsideProject(this.projectRoot, logPath);
      mkdirSync(outputAbsolute, { recursive: true });
      mkdirSync(dirname(logAbsolute), { recursive: true });

      const configPath = input.configPath?.trim() || this.config.buildConfigPath;
      const buildOptions = configPath
        ? buildOptionsFromConfig(this.projectRoot, configPath, logAbsolute)
        : buildOptionsInline(platform, debug, outputDir, scene.uuid, logAbsolute);
      const args = ["--project", this.projectRoot, "--build", buildOptions];
      const processResult = spawnSync(this.config.executablePath, args, {
        cwd: this.projectRoot,
        encoding: "utf8",
        timeout: this.config.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env
      });
      const processOutput = `${processResult.stdout ?? ""}\n${processResult.stderr ?? ""}`.trim();
      const existingLog = existsSync(logAbsolute) && statSync(logAbsolute).isFile() ? readFileSync(logAbsolute, "utf8") : "";
      writeFileSync(logAbsolute, `${existingLog}${existingLog && processOutput ? "\n" : ""}${processOutput}\n`, "utf8");
      evidence.push(fileEvidence(this.projectRoot, logPath));

      const exitSucceeded = processResult.status === 0 || processResult.status === 36;
      const outputFiles = listProjectFiles(this.projectRoot, outputDir, (path, stats) =>
        stats.isFile() && !path.endsWith("/.gitkeep") && !path.endsWith("/build-report.json") && stats.mtimeMs >= startedAtMs - 2_000
      );
      const ok = !processResult.error && exitSucceeded && outputFiles.length > 0;
      const failureReason = processResult.error?.message
        ?? (!exitSucceeded ? `Creator 退出码 ${processResult.status ?? "unknown"}` : outputFiles.length === 0 ? "Creator 未生成新的构建文件" : "unknown");
      const reportDocument = {
        buildId: operationId,
        operationId,
        operationType: "build",
        status: ok ? "success" : "failed",
        platform,
        debug,
        executablePath: this.config.executablePath,
        creatorVersion: this.config.version,
        projectPath: this.projectRoot,
        scenePath: scene.path,
        sceneUuid: scene.uuid,
        outputPath: outputDir,
        logsPath: logPath,
        command: { executable: this.config.executablePath, args },
        exitCode: processResult.status,
        signal: processResult.signal,
        outputFiles,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ...(ok ? {} : { error: failureReason })
      };
      evidence.push(this.writeJson(reportPath, reportDocument));
      evidence.push(this.writeReport(operationReportPath, reportDocument));
      return {
        ok,
        operationId,
        operationType: "build",
        summary: ok
          ? `Cocos Creator 已完成 ${platform} 构建，生成 ${outputFiles.length} 个本轮文件。`
          : `Cocos Creator 构建失败：${failureReason}`,
        reportPath,
        evidence,
        details: reportDocument,
        ...(!ok ? { error: failureReason } : {})
      };
    } catch (error) {
      const failureDocument = {
        buildId: operationId,
        operationId,
        operationType: "build",
        status: "failed",
        platform,
        debug,
        outputPath: outputDir,
        logsPath: logPath,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        error: errorMessage(error)
      };
      if (reportPath !== operationReportPath) {
        evidence.push(this.writeJson(reportPath, failureDocument));
      }
      evidence.push(this.writeReport(operationReportPath, failureDocument));
      return {
        ok: false,
        operationId,
        operationType: "build",
        summary: `Cocos Creator 构建未执行成功：${errorMessage(error)}`,
        reportPath,
        evidence,
        details: failureDocument,
        error: errorMessage(error)
      };
    }
  }

  private writeReport(path: string, value: unknown): CocosBridgeEvidence {
    return this.writeJson(path, value);
  }

  private writeJson(path: string, value: unknown): CocosBridgeEvidence {
    return this.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private writeText(path: string, content: string): CocosBridgeEvidence {
    const relativePath = normalizeRelativePath(path);
    const absolutePath = resolveInsideProject(this.projectRoot, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
    return fileEvidence(this.projectRoot, relativePath);
  }
}

function createOperationId(prefix: string): string {
  return `cocos_${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

function checkFile(root: string, path: string, label: string): { check: string; ok: boolean; message: string } {
  const target = resolveInsideProject(root, path);
  const ok = existsSync(target) && statSync(target).isFile();
  return { check: path, ok, message: ok ? `${label} 存在。` : `${label} 不存在：${path}` };
}

function checkDirectory(root: string, path: string, label: string): { check: string; ok: boolean; message: string } {
  const target = resolveInsideProject(root, path);
  const ok = existsSync(target) && statSync(target).isDirectory();
  return { check: path, ok, message: ok ? `${label} 存在。` : `${label} 不存在：${path}` };
}

function checkCreatorExecutable(path: string): { check: string; ok: boolean; message: string } {
  const ok = Boolean(path && isExecutable(path));
  return { check: "creator_executable", ok, message: ok ? `Creator 可执行文件存在：${path}` : `Creator 未配置或不可执行：${path || "未设置"}` };
}

function checkCreatorVersion(version: string): { check: string; ok: boolean; message: string } {
  const majorMinor = version.match(/(\d+)\.(\d+)/);
  const ok = Boolean(majorMinor && Number(majorMinor[1]) === 3 && Number(majorMinor[2]) >= 8);
  return { check: "creator_version", ok, message: ok ? `Creator 目标版本满足 3.8+：${version}` : `Bridge 要求 Creator 3.8+，当前配置：${version}` };
}

function isExecutable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function readJsonFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`JSON 根节点必须是对象：${path}`);
  }
  return parsed;
}

function collectManifestAssets(value: unknown): ManifestAsset[] {
  const assets: ManifestAsset[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    const runtimePath = stringValue(candidate.runtimePath ?? candidate.runtime_path ?? candidate.cocosPath ?? candidate.cocos_path);
    if (runtimePath) {
      const id = stringValue(candidate.id ?? candidate.assetId ?? candidate.asset_id ?? basename(runtimePath, extname(runtimePath)));
      assets.push({
        id,
        runtimePath,
        ...(stringValue(candidate.sourcePath ?? candidate.source_path) ? { sourcePath: stringValue(candidate.sourcePath ?? candidate.source_path) } : {}),
        ...(stringValue(candidate.status) ? { status: stringValue(candidate.status) } : {})
      });
      return;
    }
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return [...new Map(assets.map((asset) => [`${asset.id}:${asset.runtimePath}`, asset])).values()];
}

function assertRuntimeAsset(absolutePath: string, relativePath: string): void {
  if (extname(relativePath).toLowerCase() === ".svg") {
    throw new Error(`SVG 不能作为 Cocos runtime 资产：${relativePath}。请先渲染 PNG。`);
  }
  if (extname(relativePath).toLowerCase() === ".png") {
    const signature = readFileSync(absolutePath).subarray(0, 8).toString("hex");
    if (signature !== "89504e470d0a1a0a") {
      throw new Error(`PNG 文件签名无效：${relativePath}`);
    }
  }
}

function normalizeBlueprint(value: Record<string, unknown>): Record<string, unknown> & { sceneName: string; resolution: Record<string, unknown>; root: Record<string, unknown> } {
  const scene = isRecord(value.scene) ? value.scene : {};
  const sceneName = safeSceneName(stringValue(value.scene_name ?? value.sceneName ?? scene.name) || "MainGame");
  const canvas = isRecord(value.canvas) ? value.canvas : isRecord(scene.canvas) ? scene.canvas : {};
  const designResolution = isRecord(scene.designResolution) ? scene.designResolution : {};
  const resolutionArray = Array.isArray(canvas.design_resolution) ? canvas.design_resolution : [];
  const width = finiteNumber(designResolution.width ?? canvas.width ?? resolutionArray[0], 750);
  const height = finiteNumber(designResolution.height ?? canvas.height ?? resolutionArray[1], 1334);
  const hierarchy = isRecord(value.nodeHierarchy) ? value.nodeHierarchy : {};
  const root = isRecord(hierarchy.root)
    ? hierarchy.root
    : isRecord(value.root)
      ? value.root
      : { name: "Canvas", children: Array.isArray(value.nodes) ? value.nodes : [] };
  if (!stringValue(root.name)) {
    root.name = "Canvas";
  }
  return {
    schemaVersion: 1,
    generatedBy: "Be The Producer Cocos Engine Bridge",
    sceneName,
    resolution: {
      width,
      height,
      fitWidth: booleanValue(designResolution.fitWidth ?? canvas.fit_width, true),
      fitHeight: booleanValue(designResolution.fitHeight ?? canvas.fit_height, false)
    },
    root,
    prefabs: value.prefabs ?? {},
    scriptAttachmentMap: value.scriptAttachmentMap ?? value.scripts ?? {},
    source: value
  };
}

function discoverScriptComponents(projectRoot: string): ScriptComponent[] {
  const scriptsRoot = resolveInsideProject(projectRoot, "assets/scripts");
  if (!existsSync(scriptsRoot)) {
    return [];
  }
  const bootstrapDirectory = resolveInsideProject(projectRoot, "assets/scripts/btp");
  const scripts = listAbsoluteFiles(scriptsRoot).filter((path) => path.endsWith(".ts") && !path.includes(`${sep}btp${sep}`));
  const components: ScriptComponent[] = [];
  for (const path of scripts) {
    const source = readFileSync(path, "utf8");
    const className = source.match(/@ccclass\(\s*["']([^"']+)["']\s*\)/)?.[1]
      ?? source.match(/export\s+class\s+(\w+)\s+extends\s+Component/)?.[1];
    if (!className || !new RegExp(`export\\s+class\\s+${escapeRegExp(className)}\\b`).test(source)) {
      continue;
    }
    const importPath = relative(bootstrapDirectory, path).split(sep).join("/").replace(/\.ts$/, "");
    components.push({ className, importPath: importPath.startsWith(".") ? importPath : `./${importPath}` });
  }
  return [...new Map(components.map((component) => [component.className, component])).values()].sort((left, right) => left.className.localeCompare(right.className));
}

function renderRuntimeBootstrap(components: ScriptComponent[]): string {
  const imports = components.map((component) => `import { ${component.className} } from '${component.importPath}';`).join("\n");
  const registry = components.map((component) => `  ${JSON.stringify(component.className)}: ${component.className},`).join("\n");
  return `import {
  _decorator,
  Color,
  Component,
  Graphics,
  JsonAsset,
  Label,
  Node,
  Prefab,
  resources,
  Sprite,
  SpriteFrame,
  Texture2D,
  UITransform,
  Vec3,
  view,
  ResolutionPolicy
} from 'cc';
${imports}

const { ccclass } = _decorator;

interface BlueprintNode {
  name?: string;
  id?: string;
  type?: string;
  text?: string;
  active?: boolean;
  asset_key?: string;
  assetKey?: string;
  components?: string[];
  position?: { x?: number; y?: number } | [number, number];
  size?: { width?: number; height?: number } | [number, number];
  labelConfig?: { defaultText?: string; fontSize?: number; color?: string };
  spriteConfig?: { defaultAsset?: string };
  colorConfig?: { safe?: string; default?: string };
  references?: Record<string, string>;
  poolConfig?: { initialSize?: number; autoExpand?: boolean; expandIncrement?: number };
  children?: BlueprintNode[];
}

interface RuntimeBlueprint {
  resolution?: { width?: number; height?: number; fitWidth?: boolean; fitHeight?: boolean };
  root?: BlueprintNode;
}

const componentRegistry: Record<string, new () => Component> = {
${registry}
};

const assetAliases: Record<string, string> = {
  background: 'background',
  basket: 'basket_body',
  basketrim: 'basket_body',
  basketshadow: 'basket_shadow',
  joystickbase: 'joystick_base',
  joystickthumb: 'joystick_cap',
  hud: 'hud_panel',
  retrybutton: 'button_normal',
  playagainbutton: 'button_normal',
  yarnball: 'yarn_ball_base',
  yarnballsprite: 'yarn_ball_base',
};

@ccclass('BtpRuntimeBootstrap')
export class BtpRuntimeBootstrap extends Component {
  private pendingBindings: Array<{ node: Node; spec: BlueprintNode; componentName: string; component: Component }> = [];

  start(): void {
    resources.load('btp/scene-blueprint', JsonAsset, (error, asset) => {
      if (error || !asset) {
        console.error('[BTP Bridge] scene blueprint load failed', error);
        return;
      }
      const blueprint = asset.json as RuntimeBlueprint;
      const resolution = blueprint.resolution ?? {};
      view.setDesignResolutionSize(
        resolution.width ?? 750,
        resolution.height ?? 1334,
        ResolutionPolicy.SHOW_ALL
      );
      this.pendingBindings.length = 0;
      for (const child of blueprint.root?.children ?? []) {
        this.materializeNode(child, this.node);
      }
      this.wireRuntimeBindings();
      console.info('[BTP Bridge] scene blueprint materialized', {
        rootChildren: this.node.children.length,
        componentBindings: this.pendingBindings.length,
      });
    });
  }

  private materializeNode(spec: BlueprintNode, parent: Node): Node {
    const node = new Node(spec.name ?? spec.id ?? 'Node');
    parent.addChild(node);
    node.layer = parent.layer;
    node.active = spec.active !== false;
    const [x, y] = Array.isArray(spec.position)
      ? [Number(spec.position[0] ?? 0), Number(spec.position[1] ?? 0)]
      : [Number(spec.position?.x ?? 0), Number(spec.position?.y ?? 0)];
    node.setPosition(new Vec3(x, y, 0));
    const [width, height] = Array.isArray(spec.size)
      ? [Number(spec.size[0] ?? 100), Number(spec.size[1] ?? 100)]
      : [Number(spec.size?.width ?? 100), Number(spec.size?.height ?? 100)];
    const transform = node.addComponent(UITransform);
    transform.setContentSize(width, height);

    const components = new Set(spec.components ?? []);
    if (spec.type === 'Label' || components.has('cc.Label')) {
      const label = node.addComponent(Label);
      label.string = spec.text ?? spec.labelConfig?.defaultText ?? node.name;
      label.color = this.parseColor(spec.labelConfig?.color, new Color(38, 42, 40, 255));
      label.fontSize = Number(spec.labelConfig?.fontSize) || Math.max(20, Math.min(48, Math.round(height * 0.5)));
      label.lineHeight = Math.round(label.fontSize * 1.2);
    } else if (spec.type === 'Sprite' || components.has('cc.Sprite')) {
      const sprite = node.addComponent(Sprite);
      sprite.sizeMode = Sprite.SizeMode.CUSTOM;
      const assetKey = this.resolveAssetKey(spec);
      const fallback = this.createFallback(node, width, height, spec);
      if (assetKey) {
        this.loadTexture(assetKey, (error, texture) => {
          if (!error && texture && sprite.isValid) {
            const frame = new SpriteFrame();
            frame.texture = texture;
            sprite.spriteFrame = frame;
            fallback.destroy();
          } else {
            console.warn('[BTP Bridge] sprite load failed, keeping fallback:', assetKey, error);
          }
        });
      }
    }

    for (const componentName of components) {
      const ComponentType = componentRegistry[componentName];
      if (ComponentType && !node.getComponent(ComponentType)) {
        const component = node.addComponent(ComponentType);
        this.pendingBindings.push({ node, spec, componentName, component });
      }
    }
    for (const child of spec.children ?? []) {
      this.materializeNode(child, node);
    }
    return node;
  }

  private loadTexture(assetKey: string, done: (error: Error | null, texture?: Texture2D) => void): void {
    const path = 'btp-art/' + assetKey;
    resources.load(path, Texture2D, (baseError, baseTexture) => {
      if (!baseError && baseTexture) {
        done(null, baseTexture);
        return;
      }
      resources.load(path + '/texture', Texture2D, (textureError, texture) => {
        if (!textureError && texture) {
          done(null, texture);
          return;
        }
        done((textureError ?? baseError) as Error | null);
      });
    });
  }

  private resolveAssetKey(spec: BlueprintNode): string | undefined {
    const explicit = spec.asset_key ?? spec.assetKey ?? spec.spriteConfig?.defaultAsset;
    if (explicit) {
      const normalized = explicit.replace(/\\\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '');
      if (normalized) return normalized;
    }
    return assetAliases[(spec.name ?? spec.id ?? '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()];
  }

  private createFallback(node: Node, width: number, height: number, spec: BlueprintNode): Node {
    const fallback = new Node('__btp_fallback');
    node.addChild(fallback);
    fallback.layer = node.layer;
    fallback.addComponent(UITransform).setContentSize(width, height);
    const graphics = fallback.addComponent(Graphics);
    const name = (spec.name ?? '').toLowerCase();
    const defaultColor = name.includes('background')
      ? new Color(255, 248, 240, 255)
      : name.includes('basket')
        ? new Color(191, 126, 79, 255)
        : name.includes('joystick')
          ? new Color(73, 144, 120, 150)
          : name.includes('yarn')
            ? new Color(242, 166, 184, 255)
            : new Color(170, 170, 170, 220);
    graphics.fillColor = this.parseColor(spec.colorConfig?.safe ?? spec.colorConfig?.default, defaultColor);
    graphics.roundRect(-width / 2, -height / 2, width, height, Math.min(18, width / 4, height / 4));
    graphics.fill();
    return fallback;
  }

  private wireRuntimeBindings(): void {
    for (const binding of this.pendingBindings) {
      const target = binding.component as Component & Record<string, unknown>;
      for (const [property, path] of Object.entries(binding.spec.references ?? {})) {
        target[property] = this.findNode(path);
      }

      if (binding.componentName === 'BasketController') {
        target.basketRim = binding.node.getChildByName('BasketRim');
      } else if (binding.componentName === 'JoystickInput') {
        target.joystickBase = binding.node.getChildByName('JoystickBase');
        target.joystickThumb = binding.node.getChildByName('JoystickThumb');
        target._basketController = this.findNode('Canvas/GameLayer/Basket')?.getComponent(componentRegistry.BasketController);
      } else if (binding.componentName === 'HUDManager') {
        target.timerLabel = binding.node.getChildByName('TimerLabel')?.getComponent(Label);
        target.interceptionLabel = binding.node.getChildByName('InterceptionCount')?.getComponent(Label);
        target.phaseLabel = binding.node.getChildByName('PhaseIndicator')?.getComponent(Label);
        const indicator = binding.node.getChildByName('ErrorIndicator');
        target.errorDot1 = indicator?.getChildByName('ErrorDot1') ?? null;
        target.errorDot2 = indicator?.getChildByName('ErrorDot2') ?? null;
      } else if (binding.componentName === 'ObjectPool') {
        const pool = binding.spec.poolConfig ?? {};
        target.initialSize = Number(pool.initialSize) || 10;
        target.autoExpand = pool.autoExpand !== false;
        target.expandIncrement = Number(pool.expandIncrement) || 2;
        target.yarnBallPrefab = this.createYarnBallPrefab(binding.node.layer);
      } else if (binding.componentName === 'GameController') {
        target.objectPoolNode = this.findNode('Canvas/Managers/ObjectPool');
        target.audioManager = this.findNode('Canvas/Managers/AudioManager');
        target.scoreManager = this.findNode('Canvas/Managers/ScoreManager');
        const basketNode = target.basketNode as Node | null;
        const objectPoolNode = target.objectPoolNode as Node | null;
        target._basketController = basketNode?.getComponent(componentRegistry.BasketController) ?? null;
        target._objectPool = objectPoolNode?.getComponent(componentRegistry.ObjectPool) ?? null;
      }
    }
  }

  private createYarnBallPrefab(layer: number): Prefab {
    const template = new Node('YarnBall');
    template.layer = layer;
    template.addComponent(UITransform).setContentSize(56, 56);
    const graphics = template.addComponent(Graphics);
    graphics.fillColor = new Color(242, 166, 184, 255);
    graphics.circle(0, 0, 28);
    graphics.fill();
    const ControllerType = componentRegistry.YarnBallController;
    if (ControllerType) {
      template.addComponent(ControllerType);
    }
    const prefab = new Prefab();
    prefab.data = template;
    return prefab;
  }

  private findNode(path: string): Node | null {
    const segments = path.replace(/\\\\/g, '/').split('/').filter(Boolean);
    if (segments[0] === this.node.name || segments[0] === 'Canvas') {
      segments.shift();
    }
    let current: Node | null = this.node;
    for (const segment of segments) {
      current = current?.getChildByName(segment) ?? null;
      if (!current) return null;
    }
    return current;
  }

  private parseColor(value: string | undefined, fallback: Color): Color {
    const match = value?.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (!match) return fallback;
    const rgb = Number.parseInt(match[1], 16);
    const alpha = match[2] ? Number.parseInt(match[2], 16) : 255;
    return new Color((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255, alpha);
  }
}
`;
}

function typescriptMeta(uuid: string): Record<string, unknown> {
  return { ver: "4.0.23", importer: "typescript", imported: true, uuid, files: [], subMetas: {}, userData: {} };
}

function sceneMeta(uuid: string): Record<string, unknown> {
  return { ver: "1.1.27", importer: "scene", imported: true, uuid, files: [".json"], subMetas: {}, userData: {} };
}

function createBootstrapScene(
  blueprint: { sceneName: string; resolution: Record<string, unknown> },
  scriptUuid: string,
  sceneUuid: string
): Array<Record<string, unknown>> {
  const width = finiteNumber(blueprint.resolution.width, 750);
  const height = finiteNumber(blueprint.resolution.height, 1334);
  const id = (value: string): string => compressUuid(deterministicUuid(`${sceneUuid}:${value}`));
  return [
    { __type__: "cc.SceneAsset", _name: "", _objFlags: 0, _native: "", scene: { __id__: 1 }, asyncLoadAssets: false },
    {
      __type__: "cc.Scene",
      _name: blueprint.sceneName,
      _objFlags: 0,
      _parent: null,
      _children: [{ __id__: 2 }],
      _active: true,
      _components: [],
      _prefab: null,
      autoReleaseAssets: false,
      _globals: { __id__: 8 },
      _id: sceneUuid
    },
    {
      __type__: "cc.Node",
      _name: "Canvas",
      _objFlags: 0,
      _parent: { __id__: 1 },
      _children: [{ __id__: 6 }],
      _active: true,
      _components: [{ __id__: 3 }, { __id__: 4 }, { __id__: 5 }],
      _prefab: null,
      _lpos: { __type__: "cc.Vec3", x: width / 2, y: height / 2, z: 0 },
      _lrot: { __type__: "cc.Quat", x: 0, y: 0, z: 0, w: 1 },
      _lscale: { __type__: "cc.Vec3", x: 1, y: 1, z: 1 },
      _layer: 33554432,
      _euler: { __type__: "cc.Vec3", x: 0, y: 0, z: 0 },
      _id: id("canvas-node")
    },
    {
      __type__: "cc.UITransform",
      _name: "",
      _objFlags: 0,
      node: { __id__: 2 },
      _enabled: true,
      __prefab: null,
      _contentSize: { __type__: "cc.Size", width, height },
      _anchorPoint: { __type__: "cc.Vec2", x: 0.5, y: 0.5 },
      _id: id("canvas-transform")
    },
    {
      __type__: "cc.Canvas",
      _name: "",
      _objFlags: 0,
      node: { __id__: 2 },
      _enabled: true,
      __prefab: null,
      _cameraComponent: { __id__: 7 },
      _alignCanvasWithScreen: true,
      _id: id("canvas-component")
    },
    {
      __type__: compressUuid(scriptUuid),
      _name: "",
      _objFlags: 0,
      node: { __id__: 2 },
      _enabled: true,
      __prefab: null,
      _id: id("bootstrap-component")
    },
    {
      __type__: "cc.Node",
      _name: "Camera",
      _objFlags: 0,
      _parent: { __id__: 2 },
      _children: [],
      _active: true,
      _components: [{ __id__: 7 }],
      _prefab: null,
      _lpos: { __type__: "cc.Vec3", x: 0, y: 0, z: 1000 },
      _lrot: { __type__: "cc.Quat", x: 0, y: 0, z: 0, w: 1 },
      _lscale: { __type__: "cc.Vec3", x: 1, y: 1, z: 1 },
      _layer: 33554432,
      _euler: { __type__: "cc.Vec3", x: 0, y: 0, z: 0 },
      _id: id("camera-node")
    },
    {
      __type__: "cc.Camera",
      _name: "",
      _objFlags: 0,
      node: { __id__: 6 },
      _enabled: true,
      __prefab: null,
      _projection: 0,
      _priority: 1073741824,
      _fov: 45,
      _fovAxis: 0,
      _orthoHeight: height / 2,
      _near: 1,
      _far: 2000,
      _color: { __type__: "cc.Color", r: 255, g: 248, b: 240, a: 255 },
      _depth: 1,
      _stencil: 0,
      _clearFlags: 7,
      _rect: { __type__: "cc.Rect", x: 0, y: 0, width: 1, height: 1 },
      _aperture: 19,
      _shutter: 7,
      _iso: 0,
      _screenScale: 1,
      _visibility: 41943040,
      _targetTexture: null,
      _id: id("camera-component")
    },
    { __type__: "cc.SceneGlobals", ambient: { __id__: 9 }, shadows: { __id__: 10 }, _skybox: { __id__: 11 }, fog: { __id__: 12 } },
    {
      __type__: "cc.AmbientInfo",
      _skyColor: { __type__: "cc.Color", r: 51, g: 128, b: 204, a: 1 },
      _skyIllum: 20000,
      _groundAlbedo: { __type__: "cc.Color", r: 51, g: 51, b: 51, a: 255 }
    },
    {
      __type__: "cc.ShadowsInfo",
      _type: 0,
      _enabled: false,
      _normal: { __type__: "cc.Vec3", x: 0, y: 1, z: 0 },
      _distance: 0,
      _shadowColor: { __type__: "cc.Color", r: 76, g: 76, b: 76, a: 255 },
      _maxReceived: 4,
      _size: { __type__: "cc.Vec2", x: 512, y: 512 }
    },
    { __type__: "cc.SkyboxInfo", _envmap: null, _isRGBE: false, _enabled: false, _useIBL: false },
    {
      __type__: "cc.FogInfo",
      _type: 0,
      _fogColor: { __type__: "cc.Color", r: 200, g: 200, b: 200, a: 255 },
      _enabled: false,
      _fogDensity: 0.3,
      _fogStart: 0.5,
      _fogEnd: 300,
      _fogAtten: 5,
      _fogTop: 1.5,
      _fogRange: 1.2
    }
  ];
}

function findBuildScene(projectRoot: string): { path: string; uuid: string } | undefined {
  const scenePaths = listProjectFiles(projectRoot, "assets", (path) => path.endsWith(".scene"));
  for (const path of scenePaths) {
    const metaPath = `${path}.meta`;
    const absoluteMeta = resolveInsideProject(projectRoot, metaPath);
    if (!existsSync(absoluteMeta)) {
      continue;
    }
    const meta = readJsonFile(absoluteMeta);
    const uuid = stringValue(meta.uuid);
    if (uuid) {
      return { path, uuid };
    }
  }
  return undefined;
}

function buildOptionsInline(platform: string, debug: boolean, outputDir: string, sceneUuid: string, logAbsolute: string): string {
  const buildPath = dirname(outputDir).replaceAll("\\", "/");
  const outputName = basename(outputDir);
  return [
    `platform=${platform}`,
    `debug=${debug}`,
    `buildPath=project://${buildPath}`,
    `outputName=${outputName}`,
    `startScene=${sceneUuid}`,
    `scenes=${sceneUuid}`,
    `logDest=${logAbsolute}`
  ].join(";");
}

function buildOptionsFromConfig(projectRoot: string, configPath: string, logAbsolute: string): string {
  const absoluteConfig = isAbsolute(configPath) ? resolve(configPath) : resolveInsideProject(projectRoot, configPath);
  if (!existsSync(absoluteConfig) || !statSync(absoluteConfig).isFile()) {
    throw new Error(`Cocos 构建配置不存在：${configPath}`);
  }
  return `configPath=${absoluteConfig};stage=build;logDest=${logAbsolute}`;
}

function listProjectFiles(
  projectRoot: string,
  startPath: string,
  predicate: (path: string, stats: Stats) => boolean
): string[] {
  const absoluteStart = resolveInsideProject(projectRoot, startPath);
  if (!existsSync(absoluteStart)) {
    return [];
  }
  return listAbsoluteFiles(absoluteStart)
    .map((absolutePath) => ({ absolutePath, path: relative(projectRoot, absolutePath).split(sep).join("/"), stats: statSync(absolutePath) }))
    .filter((entry) => predicate(entry.path, entry.stats))
    .map((entry) => entry.path)
    .sort();
}

function listAbsoluteFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (statSync(root).isFile()) {
    return [root];
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || [".git", ".be-the-producer", "node_modules", "library", "temp"].includes(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function resolveInsideProject(projectRoot: string, path: string): string {
  const relativePath = normalizeRelativePath(path);
  const absolutePath = resolve(projectRoot, relativePath);
  const inside = relative(projectRoot, absolutePath);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`路径超出 Cocos 项目根目录：${path}`);
  }
  return absolutePath;
}

function normalizeRelativePath(path: string): string {
  const cleaned = normalize(path.trim().replace(/^\.\/+/, ""));
  if (!cleaned || isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${sep}`) || cleaned.includes(`${sep}..${sep}`)) {
    throw new Error(`不安全的 Cocos 项目路径：${path}`);
  }
  return cleaned.split(sep).join("/");
}

function normalizeScenePath(path: string): string {
  const normalized = normalizeRelativePath(path);
  if (!normalized.startsWith("assets/scenes/") || !normalized.endsWith(".scene")) {
    throw new Error(`场景输出必须位于 assets/scenes/ 且扩展名为 .scene：${normalized}`);
  }
  return normalized;
}

function normalizeBuildOutput(path: string): string {
  const normalized = normalizeRelativePath(path).replace(/\/+$/, "");
  if (!normalized.startsWith("shared/build-artifacts/") && !normalized.startsWith("builds/")) {
    throw new Error(`构建输出必须位于 shared/build-artifacts/ 或 builds/：${normalized}`);
  }
  return normalized;
}

function fileEvidence(projectRoot: string, path: string): CocosBridgeEvidence {
  const relativePath = normalizeRelativePath(path);
  const absolutePath = resolveInsideProject(projectRoot, relativePath);
  const body = readFileSync(absolutePath);
  return {
    path: relativePath,
    hash: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.byteLength
  };
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function compressUuid(uuid: string): string {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    return uuid;
  }
  const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = hex.slice(0, 5);
  for (let index = 5; index < hex.length; index += 3) {
    const value = Number.parseInt(hex.slice(index, index + 3), 16);
    output += `${base64[value >> 6]}${base64[value & 63]}`;
  }
  return output;
}

function countBlueprintNodes(root: Record<string, unknown>): number {
  const children = Array.isArray(root.children) ? root.children.filter(isRecord) : [];
  return 1 + children.reduce((total, child) => total + countBlueprintNodes(child), 0);
}

function nestedString(value: Record<string, unknown>, path: string[]): string {
  let current: unknown = value;
  for (const segment of path) {
    current = isRecord(current) ? current[segment] : undefined;
  }
  return stringValue(current);
}

function safeSceneName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "MainGame";
}

function safeAssetId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "asset";
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
