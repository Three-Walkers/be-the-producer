import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { ContractValidationError, parseAssetManifest, parseSceneBlueprint } from "@game-pipeline/shared-schemas";
import type {
  ArtifactDirectoryManifest,
  CocosAssetImportReceipt,
  CocosBuildImportReceiptBinding,
  CocosFileByteEvidence,
  CocosImportedAssetReceipt,
  SceneBlueprint,
  SceneDefinition
} from "@game-pipeline/shared-schemas";
import type { CocosEngineConfig } from "./cocosEngineSettings.js";
import { adaptLegacySceneBlueprint } from "./legacySceneBlueprintAdapter.js";
import { normalizeRelativePathWithinRoot, resolvePathWithinRoot } from "./pathSafety.js";
import { playtestRuntimeBindingPath, readPlaytestRuntimeBinding } from "./playtestRuntimeBinding.js";
import { discoverScriptComponents, type ScriptComponent } from "./cocosScriptComponents.js";
import { withIsolatedCreatorMetadata } from "./cocosBuildIsolation.js";

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

export function verifyCocosBuildManifest(projectRoot: string, manifest: ArtifactDirectoryManifest): boolean {
  try {
    if (manifest.schemaVersion !== 1 || manifest.files.length === 0) return false;
    const files = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
    if (files.some((entry, index) => entry.path !== manifest.files[index]?.path)) return false;
    const rootPath = normalizeRelativePath(manifest.rootPath).replace(/\/+$/, "");
    if (files.some((entry) => !entry.path.startsWith(`${rootPath}/`))) return false;
    const actualFiles = listProjectFiles(projectRoot, rootPath, (path, stats) =>
      stats.isFile() && !path.endsWith("/.gitkeep") && !path.endsWith("/build-report.json")
    );
    if (actualFiles.length !== files.length || actualFiles.some((path, index) => path !== files[index]?.path)) return false;
    const digest = createHash("sha256").update(canonicalManifestBytes(files)).digest("hex");
    return digest === manifest.digest && files.every((expected) => {
      const actual = fileEvidence(projectRoot, expected.path);
      return actual.hash === expected.hash && actual.sizeBytes === expected.sizeBytes;
    });
  } catch {
    return false;
  }
}

interface ManifestAsset {
  id: string;
  runtimePath: string;
}

interface PreparedManifestAsset extends ManifestAsset {
  sourceAbsolutePath: string;
  destinationPath: string;
  resourcePath: string;
}

interface AssetImportOutput {
  destinationPath: string;
  stagedPath?: string;
  content?: string;
}

interface AssetImportMissingEntry {
  id: string;
  runtimePath: string;
  reason: "file_not_found" | "not_a_file";
}

class AssetImportValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
    readonly missing: AssetImportMissingEntry[]
  ) {
    super(message);
    this.name = "AssetImportValidationError";
  }
}

const defaultManifestPath = "agents/art/asset-manifest.json";
export const currentCocosImportReceiptPath = "agents/cocos-automation/imports/current.json";
const defaultBlueprintPath = "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json";
export const defaultCocosScenePath = "assets/scenes/MainGame.scene";
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
    const requestedManifestPath = input.manifestPath ?? defaultManifestPath;
    let manifestPath = requestedManifestPath;
    const reportPath = `agents/cocos-automation/imports/${operationId}.json`;
    const evidence: CocosBridgeEvidence[] = [];
    try {
      manifestPath = normalizeRelativePath(requestedManifestPath);
      const manifestAbsolutePath = resolveInsideProject(this.projectRoot, manifestPath);
      if (!existsSync(manifestAbsolutePath) || !statSync(manifestAbsolutePath).isFile()) {
        throw new Error(`资产清单不存在：${manifestPath}`);
      }
      const manifestEvidence = fileEvidence(this.projectRoot, manifestPath);
      const manifest = parseAssetManifest(readJsonFile(manifestAbsolutePath));
      const assets: ManifestAsset[] = manifest.runtimeAssets.map((asset) => ({
        id: asset.id,
        runtimePath: asset.runtimePath
      }));
      if (assets.length === 0) {
        throw new Error(`资产清单中没有可导入的 runtimePath：${manifestPath}`);
      }
      const preparedAssets = prepareManifestAssets(this.projectRoot, assets);
      const mapPath = "assets/resources/btp/asset-map.json";
      const materialized = materializeAssetImport({
        projectRoot: this.projectRoot,
        operationId,
        manifestPath,
        manifestEvidence,
        reportPath,
        receiptPath: currentCocosImportReceiptPath,
        mapPath,
        assets: preparedAssets
      });
      evidence.push(...materialized.evidence);
      return {
        ok: true,
        operationId,
        operationType: "import_assets",
        summary: `已物化 ${materialized.imported.length} 个 Cocos runtime 资产，等待 Creator AssetDB 原生导入。`,
        reportPath,
        evidence,
        details: {
          manifestPath,
          imported: materialized.imported,
          missing: [],
          assetMap: materialized.assetMap,
          importReceipt: materialized.importReceipt
        }
      };
    } catch (error) {
      const validationError = error instanceof AssetImportValidationError ? error : undefined;
      const failure = this.writeReport(reportPath, {
        operationId,
        operationType: "import_assets",
        status: "failed",
        createdAt: new Date().toISOString(),
        manifestPath,
        ...(validationError ? { validationIssues: validationError.issues, missing: validationError.missing } : {}),
        error: errorMessage(error)
      });
      return {
        ok: false,
        operationId,
        operationType: "import_assets",
        summary: validationError
          ? `资产导入预检失败：${validationError.issues.length} 个问题；未物化任何 runtime 资产。`
          : "Cocos 资产导入失败，已保存失败报告。",
        reportPath,
        evidence: [failure],
        details: {
          manifestPath,
          imported: [],
          missing: validationError?.missing ?? [],
          assetMap: {},
          ...(validationError ? { validationIssues: validationError.issues } : {})
        },
        error: errorMessage(error)
      };
    }
  }

  applySceneBlueprint(input: CocosApplyBlueprintInput = {}): CocosBridgeResult {
    const operationId = createOperationId("blueprint");
    const blueprintPath = normalizeRelativePath(input.blueprintPath ?? defaultBlueprintPath);
    const scenePath = normalizeScenePath(input.scenePath ?? defaultCocosScenePath);
    const reportPath = `agents/cocos-automation/scene-ops/${operationId}.json`;
    const evidence: CocosBridgeEvidence[] = [];
    try {
      const blueprintAbsolutePath = resolveInsideProject(this.projectRoot, blueprintPath);
      if (!existsSync(blueprintAbsolutePath) || !statSync(blueprintAbsolutePath).isFile()) {
        throw new Error(`SceneBlueprint 不存在：${blueprintPath}`);
      }
      const blueprintDocument = readJsonFile(blueprintAbsolutePath);
      const adapted = Object.prototype.hasOwnProperty.call(blueprintDocument, "kind")
        ? blueprintDocument
        : adaptLegacySceneBlueprint(blueprintDocument);
      const normalized = parseSceneBlueprint(adapted);
      const entryScene = requireEntryScene(normalized);
      assertBridgeMaterializationSupported(normalized, entryScene);
      const scriptComponents = discoverScriptComponents(this.projectRoot);
      validateBridgeComponents(normalized, scriptComponents);
      const resolution = inferSceneResolution(entryScene);
      const scriptPath = "assets/scripts/btp/BtpRuntimeBootstrap.ts";
      const scriptUuid = deterministicUuid(`${scriptPath}:btp-cocos-bridge`);
      const sceneUuid = deterministicUuid(`${scenePath}:${normalized.blueprintId}:${normalized.revision}:${entryScene.sceneId}`);
      const descriptorPath = "assets/resources/btp/scene-blueprint.json";
      const scriptMetaPath = `${scriptPath}.meta`;
      const sceneMetaPath = `${scenePath}.meta`;

      assertWritableProjectTargets(this.projectRoot, [
        descriptorPath,
        scriptPath,
        scriptMetaPath,
        scenePath,
        sceneMetaPath,
        reportPath
      ]);

      evidence.push(this.writeJson(descriptorPath, normalized));
      evidence.push(this.writeText(scriptPath, renderRuntimeBootstrap(scriptComponents)));
      evidence.push(this.writeJson(scriptMetaPath, typescriptMeta(scriptUuid)));
      evidence.push(this.writeJson(scenePath, createBootstrapScene({ sceneName: entryScene.name, resolution }, scriptUuid, sceneUuid)));
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
        schemaVersion: normalized.schemaVersion,
        blueprintId: normalized.blueprintId,
        entrySceneId: normalized.entrySceneId,
        nodeCount: entryScene.nodes.length
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
          schemaVersion: normalized.schemaVersion,
          blueprintId: normalized.blueprintId,
          entrySceneId: normalized.entrySceneId,
          nodeCount: entryScene.nodes.length
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
      // Fail closed before Creator starts: the build may consume only bytes
      // proven by the latest successful import of the canonical manifest.
      const importReceipt = requireCurrentCocosImportReceipt(this.projectRoot, defaultManifestPath);
      // Embed the identity of the actual QA contract at build time. Gameplay
      // and QA authors run independently; neither should guess or hard-code a
      // hash of another role's future output.
      const playtestBinding = readPlaytestRuntimeBinding(this.projectRoot);
      const scene = findBuildScene(this.projectRoot);
      if (!scene) {
        throw new Error("工程没有可构建的 .scene 及 .scene.meta。请先调用 cocos_apply_blueprint。");
      }
      const outputAbsolute = resolveInsideProject(this.projectRoot, outputDir);
      const logAbsolute = resolveInsideProject(this.projectRoot, logPath);
      assertWritableProjectTargets(this.projectRoot, [logPath, reportPath, operationReportPath,
        ...(playtestBinding ? [playtestRuntimeBindingPath] : [])]);
      if (playtestBinding) evidence.push(this.writeJson(playtestRuntimeBindingPath, playtestBinding));
      ensureDirectoryInsideProject(this.projectRoot, outputDir);
      ensureDirectoryInsideProject(this.projectRoot, relative(this.projectRoot, dirname(logAbsolute)));
      resolvePathWithinRoot(this.projectRoot, relative(this.projectRoot, outputAbsolute), {
        allowMissing: false,
        expectedKind: "directory",
        label: "Cocos 构建输出目录"
      });
      resolvePathWithinRoot(this.projectRoot, logPath, {
        allowMissing: true,
        expectedKind: "file",
        label: "Cocos 构建日志"
      });

      const configPath = input.configPath?.trim() || this.config.buildConfigPath;
      const buildOptions = configPath
        ? buildOptionsFromConfig(this.projectRoot, configPath, logAbsolute)
        : buildOptionsInline(platform, debug, outputDir, scene.uuid, logAbsolute);
      const args = ["--project", this.projectRoot, "--build", buildOptions];
      const processResult = withIsolatedCreatorMetadata(this.projectRoot, () => spawnSync(this.config.executablePath, args, {
        cwd: this.projectRoot,
        encoding: "utf8",
        timeout: this.config.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: minimalCreatorEnvironment(process.env)
      }));
      const processOutput = `${processResult.stdout ?? ""}\n${processResult.stderr ?? ""}`.trim();
      const existingLog = existsSync(logAbsolute) && statSync(logAbsolute).isFile() ? readFileSync(logAbsolute, "utf8") : "";
      writeFileSync(logAbsolute, `${existingLog}${existingLog && processOutput ? "\n" : ""}${processOutput}\n`, "utf8");
      evidence.push(fileEvidence(this.projectRoot, logPath));

      const exitSucceeded = processResult.status === 0 || processResult.status === 36;
      const newlyWrittenOutputFiles = listProjectFiles(this.projectRoot, outputDir, (path, stats) =>
        stats.isFile() && !path.endsWith("/.gitkeep") && !path.endsWith("/build-report.json") && stats.mtimeMs >= startedAtMs - 2_000
      );
      const ok = !processResult.error && exitSucceeded && newlyWrittenOutputFiles.length > 0;
      const failureReason = processResult.error?.message
        ?? (!exitSucceeded ? `Creator 退出码 ${processResult.status ?? "unknown"}` : newlyWrittenOutputFiles.length === 0 ? "Creator 未生成新的构建文件" : "unknown");
      const outputFiles = listProjectFiles(this.projectRoot, outputDir, (path, stats) =>
        stats.isFile() && !path.endsWith("/.gitkeep") && !path.endsWith("/build-report.json")
      );
      const outputManifest = ok ? createDirectoryManifest(this.projectRoot, outputDir, outputFiles) : undefined;
      const reportDocument = {
        buildId: operationId,
        operationId,
        operationType: "build",
        status: ok ? "success" : "failed",
        platform,
        debug,
        executablePath: this.config.executablePath,
        creatorVersion: this.config.version,
        ...(playtestBinding ? { playtestBinding } : {}),
        projectPath: this.projectRoot,
        scenePath: scene.path,
        sceneUuid: scene.uuid,
        outputPath: outputDir,
        logsPath: logPath,
        command: { executable: this.config.executablePath, args },
        exitCode: processResult.status,
        signal: processResult.signal,
        outputFiles,
        importReceipt,
        ...(outputManifest ? { outputManifest } : {}),
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
    ensureDirectoryInsideProject(this.projectRoot, dirname(relativePath));
    const absolutePath = resolveInsideProject(this.projectRoot, relativePath);
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

function prepareManifestAssets(projectRoot: string, assets: ManifestAsset[]): PreparedManifestAsset[] {
  const prepared: PreparedManifestAsset[] = [];
  const issues: string[] = [];
  const missing: AssetImportMissingEntry[] = [];
  const ids = new Map<string, number>();
  const destinations = new Map<string, { assetId: string; index: number }>();

  assets.forEach((asset, index) => {
    const id = asset.id.trim();
    const displayIndex = index + 1;
    if (!id) {
      issues.push(`资产清单第 ${displayIndex} 项缺少非空 id。`);
    } else {
      const previousIndex = ids.get(id);
      if (previousIndex !== undefined) {
        issues.push(`资产 id '${id}' 重复（第 ${previousIndex + 1}、${displayIndex} 项）。`);
      } else {
        ids.set(id, index);
      }
    }

    let runtimePath: string;
    try {
      runtimePath = normalizeRelativePath(asset.runtimePath);
    } catch (error) {
      issues.push(`资产 '${id || `#${displayIndex}`}' 的 runtimePath 无效：${errorMessage(error)}`);
      return;
    }

    let sourceAbsolutePath: string;
    try {
      sourceAbsolutePath = resolveInsideProject(projectRoot, runtimePath);
    } catch (error) {
      issues.push(`资产 '${id || `#${displayIndex}`}' 的 runtimePath 无效：${errorMessage(error)}`);
      return;
    }

    if (!existsSync(sourceAbsolutePath)) {
      missing.push({ id, runtimePath, reason: "file_not_found" });
      issues.push(`runtime 资产不存在：${runtimePath}`);
      return;
    }
    if (!statSync(sourceAbsolutePath).isFile()) {
      missing.push({ id, runtimePath, reason: "not_a_file" });
      issues.push(`runtime 资产不是普通文件：${runtimePath}`);
      return;
    }
    try {
      assertRuntimeAsset(sourceAbsolutePath, runtimePath);
    } catch (error) {
      issues.push(errorMessage(error));
      return;
    }

    const extension = extname(runtimePath).toLowerCase();
    const safeId = safeAssetId(id || basename(runtimePath, extension));
    const destinationPath = `assets/resources/btp-art/${safeId}${extension}`;
    let destinationAbsolutePath: string;
    try {
      destinationAbsolutePath = resolveInsideProject(projectRoot, destinationPath);
    } catch (error) {
      issues.push(`资产 '${id || `#${displayIndex}`}' 的目标路径无效：${errorMessage(error)}`);
      return;
    }
    if (existsSync(destinationAbsolutePath) && !statSync(destinationAbsolutePath).isFile()) {
      issues.push(`资产 '${id || `#${displayIndex}`}' 的目标路径不是普通文件：${destinationPath}`);
      return;
    }
    const destinationKey = destinationPath.toLowerCase();
    const existingDestination = destinations.get(destinationKey);
    if (existingDestination) {
      issues.push(
        `资产 '${id || `#${displayIndex}`}' 与 '${existingDestination.assetId}' 产生重复目标路径 ${destinationPath}（第 ${existingDestination.index + 1}、${displayIndex} 项）。`
      );
      return;
    }
    destinations.set(destinationKey, { assetId: id || `#${displayIndex}`, index });
    prepared.push({
      ...asset,
      id,
      runtimePath,
      sourceAbsolutePath,
      destinationPath,
      resourcePath: `btp-art/${safeId}`
    });
  });

  if (issues.length > 0) {
    throw new AssetImportValidationError(
      `资产清单预检失败；未写入任何 runtime 资产：${issues.join("；")}`,
      issues,
      missing
    );
  }
  return prepared;
}

function materializeAssetImport(input: {
  projectRoot: string;
  operationId: string;
  manifestPath: string;
  manifestEvidence: CocosFileByteEvidence;
  reportPath: string;
  receiptPath: string;
  mapPath: string;
  assets: PreparedManifestAsset[];
}): {
  imported: CocosImportedAssetReceipt[];
  assetMap: Record<string, string>;
  importReceipt: CocosBuildImportReceiptBinding;
  evidence: CocosBridgeEvidence[];
} {
  const stagingRoot = mkdtempSync(join(tmpdir(), "btp-cocos-import-"));
  try {
    const assetMap: Record<string, string> = {};
    const outputs: AssetImportOutput[] = [];
    const imported: CocosImportedAssetReceipt[] = [];
    for (const [index, asset] of input.assets.entries()) {
      const stagedPath = join(stagingRoot, `asset-${index}${extname(asset.destinationPath)}`);
      copyFileSync(asset.sourceAbsolutePath, stagedPath);
      const stagedBody = readFileSync(stagedPath);
      const source = fileEvidence(input.projectRoot, asset.runtimePath);
      const stagedHash = createHash("sha256").update(stagedBody).digest("hex");
      if (source.hash !== stagedHash || source.sizeBytes !== stagedBody.byteLength) {
        throw new Error(`Cocos 导入暂存期间源资产发生变化：${asset.runtimePath}`);
      }
      outputs.push({ destinationPath: asset.destinationPath, stagedPath });
      assetMap[asset.id] = asset.resourcePath;
      imported.push({
        assetId: asset.id,
        source,
        destination: {
          path: asset.destinationPath,
          hash: stagedHash,
          sizeBytes: stagedBody.byteLength
        },
        resourcePath: asset.resourcePath
      });
    }

    const mapDocument = {
      generatedBy: "Be The Producer Cocos Engine Bridge",
      manifestPath: input.manifestPath,
      importOperationId: input.operationId,
      importReceiptPath: input.receiptPath,
      assets: assetMap
    };
    outputs.push({ destinationPath: input.mapPath, content: `${JSON.stringify(mapDocument, null, 2)}\n` });

    const receiptDocument: CocosAssetImportReceipt = {
      schemaVersion: 1,
      kind: "cocos_asset_import_receipt",
      operationId: input.operationId,
      operationType: "import_assets",
      status: "completed",
      createdAt: new Date().toISOString(),
      manifest: input.manifestEvidence,
      imported,
      importedDigest: digestImportedAssets(imported),
      importMode: "copied_to_assets_resources",
    };
    const reportContent = `${JSON.stringify(receiptDocument, null, 2)}\n`;
    // Both paths carry the same signed-by-bytes receipt. The stable path is the
    // only receipt a later build accepts; the operation path remains audit history.
    outputs.push({ destinationPath: input.receiptPath, content: reportContent });
    outputs.push({ destinationPath: input.reportPath, content: reportContent });

    // Validation and staging are complete before the first project file is touched.
    const destinations = outputs.map((output, index) => {
      const absolutePath = resolveInsideProject(input.projectRoot, output.destinationPath);
      if (existsSync(absolutePath) && !statSync(absolutePath).isFile()) {
        throw new Error(`Cocos 导入目标不是普通文件：${output.destinationPath}`);
      }
      const backupPath = existsSync(absolutePath) ? join(stagingRoot, `backup-${index}`) : undefined;
      if (backupPath) {
        copyFileSync(absolutePath, backupPath);
      }
      return { output, absolutePath, backupPath };
    });

    const touched: typeof destinations = [];
    try {
      for (const destination of destinations) {
        ensureDirectoryInsideProject(input.projectRoot, dirname(destination.output.destinationPath));
        const revalidated = resolveInsideProject(input.projectRoot, destination.output.destinationPath);
        if (revalidated !== destination.absolutePath) {
          throw new Error(`Cocos 导入目标在写入前发生变化：${destination.output.destinationPath}`);
        }
        touched.push(destination);
        if (destination.output.stagedPath) {
          copyFileSync(destination.output.stagedPath, destination.absolutePath);
        } else {
          writeFileSync(destination.absolutePath, destination.output.content ?? "", "utf8");
        }
      }
      assertFileEvidenceMatches(input.projectRoot, input.manifestEvidence, "资产清单在导入提交期间发生变化");
      for (const entry of imported) {
        assertFileEvidenceMatches(input.projectRoot, entry.source, `runtime 源资产在导入提交期间发生变化：${entry.source.path}`);
        assertFileEvidenceMatches(input.projectRoot, entry.destination, `Cocos 导入目标未物化为相同字节：${entry.destination.path}`);
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const destination of touched.reverse()) {
        try {
          if (destination.backupPath) {
            copyFileSync(destination.backupPath, destination.absolutePath);
          } else {
            rmSync(destination.absolutePath, { force: true });
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${destination.output.destinationPath}: ${errorMessage(rollbackError)}`);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`${errorMessage(error)}；回滚失败：${rollbackErrors.join("；")}`);
      }
      throw error;
    }

    const receiptEvidence = fileEvidence(input.projectRoot, input.receiptPath);
    const importReceipt: CocosBuildImportReceiptBinding = {
      receipt: receiptEvidence,
      operationId: receiptDocument.operationId,
      manifest: receiptDocument.manifest,
      importedAssetCount: receiptDocument.imported.length,
      importedDigest: receiptDocument.importedDigest
    };
    return {
      imported,
      assetMap,
      importReceipt,
      evidence: outputs.map((output) => fileEvidence(input.projectRoot, output.destinationPath))
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

/**
 * Revalidate the receipt frozen into a build report against the stable current
 * receipt and all live workspace bytes. This is also used by the artifact gate
 * so a later import or destination mutation invalidates an older build.
 */
export function verifyCocosBuildImportReceipt(
  projectRoot: string,
  value: unknown,
  manifestPath = defaultManifestPath
): boolean {
  try {
    const expected = parseBuildImportReceiptBinding(value);
    const current = requireCurrentCocosImportReceipt(projectRoot, manifestPath);
    return (
      sameFileEvidence(expected.receipt, current.receipt) &&
      expected.operationId === current.operationId &&
      sameFileEvidence(expected.manifest, current.manifest) &&
      expected.importedAssetCount === current.importedAssetCount &&
      expected.importedDigest === current.importedDigest
    );
  } catch {
    return false;
  }
}

function requireCurrentCocosImportReceipt(
  projectRoot: string,
  manifestPath: string
): CocosBuildImportReceiptBinding {
  const normalizedManifestPath = normalizeRelativePath(manifestPath);
  const receiptAbsolutePath = resolveInsideProject(projectRoot, currentCocosImportReceiptPath);
  if (!existsSync(receiptAbsolutePath) || !statSync(receiptAbsolutePath).isFile()) {
    throw new Error(
      `缺少当前 Cocos 资产导入收据 ${currentCocosImportReceiptPath}；请先调用 cocos_import_assets。`
    );
  }
  const receiptEvidence = fileEvidence(projectRoot, currentCocosImportReceiptPath);
  const receipt = parseCocosAssetImportReceipt(readJsonFile(receiptAbsolutePath));
  if (receipt.manifest.path !== normalizedManifestPath) {
    throw new Error(
      `当前 Cocos 导入收据绑定 ${receipt.manifest.path}，而构建要求 ${normalizedManifestPath}；请重新调用 cocos_import_assets。`
    );
  }
  assertFileEvidenceMatches(projectRoot, receipt.manifest, "当前 asset manifest 与 Cocos 导入收据不一致；请重新导入");

  const manifest = parseAssetManifest(readJsonFile(resolveInsideProject(projectRoot, normalizedManifestPath)));
  const declaredAssets: ManifestAsset[] = manifest.runtimeAssets.map((asset) => ({
    id: asset.id,
    runtimePath: asset.runtimePath
  }));
  const prepared = prepareManifestAssets(projectRoot, declaredAssets);
  if (prepared.length !== receipt.imported.length) {
    throw new Error(
      `当前 asset manifest 声明 ${prepared.length} 个 runtime 资产，但导入收据只有 ${receipt.imported.length} 个；请重新导入。`
    );
  }
  for (const [index, asset] of prepared.entries()) {
    const imported = receipt.imported[index];
    if (
      !imported ||
      imported.assetId !== asset.id ||
      imported.source.path !== asset.runtimePath ||
      imported.destination.path !== asset.destinationPath ||
      imported.resourcePath !== asset.resourcePath
    ) {
      throw new Error(`Cocos 导入收据第 ${index + 1} 项与当前 asset manifest 的规范映射不一致；请重新导入。`);
    }
    if (
      imported.source.hash !== imported.destination.hash ||
      imported.source.sizeBytes !== imported.destination.sizeBytes
    ) {
      throw new Error(`Cocos 导入收据未证明源和目标为相同字节：${asset.runtimePath}`);
    }
    assertFileEvidenceMatches(projectRoot, imported.source, `runtime 源资产已变化：${imported.source.path}；请重新导入`);
    assertFileEvidenceMatches(projectRoot, imported.destination, `Cocos 导入目标已变化：${imported.destination.path}；请重新导入`);
  }
  const importedDigest = digestImportedAssets(receipt.imported);
  if (receipt.importedDigest !== importedDigest) {
    throw new Error("Cocos 导入收据 importedDigest 无效；请重新导入。");
  }
  return {
    receipt: receiptEvidence,
    operationId: receipt.operationId,
    manifest: receipt.manifest,
    importedAssetCount: receipt.imported.length,
    importedDigest
  };
}

function parseCocosAssetImportReceipt(value: unknown): CocosAssetImportReceipt {
  if (!isRecord(value)) throw new Error("Cocos 导入收据根节点必须是对象。");
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "cocos_asset_import_receipt" ||
    value.operationType !== "import_assets" ||
    value.status !== "completed" ||
    value.importMode !== "copied_to_assets_resources" ||
    typeof value.operationId !== "string" ||
    !value.operationId.trim() ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.importedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.importedDigest) ||
    !Array.isArray(value.imported) ||
    value.imported.length === 0
  ) {
    throw new Error("Cocos 导入收据缺少规范字段。");
  }
  const manifest = parseCocosFileEvidence(value.manifest, "manifest");
  const imported = value.imported.map((entry, index) => parseImportedAssetReceipt(entry, index));
  return {
    schemaVersion: 1,
    kind: "cocos_asset_import_receipt",
    operationId: value.operationId,
    operationType: "import_assets",
    status: "completed",
    createdAt: value.createdAt,
    manifest,
    imported,
    importedDigest: value.importedDigest,
    importMode: "copied_to_assets_resources"
  };
}

function parseImportedAssetReceipt(value: unknown, index: number): CocosImportedAssetReceipt {
  if (
    !isRecord(value) ||
    typeof value.assetId !== "string" ||
    !value.assetId.trim() ||
    typeof value.resourcePath !== "string" ||
    !value.resourcePath.trim()
  ) {
    throw new Error(`Cocos 导入收据 imported[${index}] 无效。`);
  }
  return {
    assetId: value.assetId,
    source: parseCocosFileEvidence(value.source, `imported[${index}].source`),
    destination: parseCocosFileEvidence(value.destination, `imported[${index}].destination`),
    resourcePath: value.resourcePath
  };
}

function parseBuildImportReceiptBinding(value: unknown): CocosBuildImportReceiptBinding {
  if (
    !isRecord(value) ||
    typeof value.operationId !== "string" ||
    !value.operationId.trim() ||
    typeof value.importedAssetCount !== "number" ||
    !Number.isSafeInteger(value.importedAssetCount) ||
    value.importedAssetCount < 1 ||
    typeof value.importedDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.importedDigest)
  ) {
    throw new Error("Cocos build 缺少规范 import receipt binding。");
  }
  return {
    receipt: parseCocosFileEvidence(value.receipt, "receipt"),
    operationId: value.operationId,
    manifest: parseCocosFileEvidence(value.manifest, "manifest"),
    importedAssetCount: value.importedAssetCount,
    importedDigest: value.importedDigest
  };
}

function parseCocosFileEvidence(value: unknown, label: string): CocosFileByteEvidence {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !value.path.trim() ||
    normalizeRelativePath(value.path) !== value.path ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1
  ) {
    throw new Error(`Cocos ${label} 字节证据无效。`);
  }
  return { path: value.path, hash: value.hash, sizeBytes: value.sizeBytes };
}

function assertFileEvidenceMatches(projectRoot: string, expected: CocosFileByteEvidence, message: string): void {
  const absolutePath = resolveInsideProject(projectRoot, expected.path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`${message}（文件不存在：${expected.path}）`);
  }
  const actual = fileEvidence(projectRoot, expected.path);
  if (!sameFileEvidence(expected, actual)) {
    throw new Error(
      `${message}（expected hash=${expected.hash}, size=${expected.sizeBytes}; actual hash=${actual.hash}, size=${actual.sizeBytes}）`
    );
  }
}

function sameFileEvidence(left: CocosFileByteEvidence, right: CocosFileByteEvidence): boolean {
  return left.path === right.path && left.hash === right.hash && left.sizeBytes === right.sizeBytes;
}

function digestImportedAssets(imported: CocosImportedAssetReceipt[]): string {
  const canonical = imported.map((entry) => ({
    assetId: entry.assetId,
    source: entry.source,
    destination: entry.destination,
    resourcePath: entry.resourcePath
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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

function requireEntryScene(blueprint: SceneBlueprint): SceneDefinition {
  const scene = blueprint.scenes.find((candidate) => candidate.sceneId === blueprint.entrySceneId);
  if (!scene) {
    throw new Error(`SceneBlueprint entrySceneId 无法解析：${blueprint.entrySceneId}`);
  }
  return scene;
}

function assertBridgeMaterializationSupported(blueprint: SceneBlueprint, entryScene: SceneDefinition): void {
  const unsupported: string[] = [];
  for (const node of entryScene.nodes) {
    if (node.prefabId !== undefined) {
      unsupported.push(
        `entry scene '${entryScene.sceneId}' node '${node.nodeId}' uses prefabId '${node.prefabId}', but Prefab instantiation is not implemented`,
      );
    }
    for (const component of node.components) {
      for (const reference of component.references) {
        const location = `${entryScene.sceneId}/${node.nodeId}/${component.componentId}.${reference.property}`;
        if (reference.kind === "prefab") {
          unsupported.push(
            `entry scene reference '${location}' targets Prefab '${reference.prefabId}', but Prefab loading/binding is not implemented`,
          );
        } else if (reference.sceneId !== entryScene.sceneId) {
          unsupported.push(
            `entry scene reference '${location}' crosses into scene '${reference.sceneId}', but only the entry scene is materialized`,
          );
        }
      }
    }
  }
  if (blueprint.scenes.length !== 1) {
    unsupported.push(
      `blueprint declares ${blueprint.scenes.length} scenes; this bridge currently materializes exactly one entry scene`,
    );
  }
  if (blueprint.prefabs.length > 0) {
    unsupported.push(
      `blueprint declares ${blueprint.prefabs.length} Prefab definition(s); Prefab import and instantiation are not implemented`,
    );
  }
  if (unsupported.length > 0) {
    throw new Error(
      `SceneBlueprint 超出当前 Cocos Bridge 的可忠实物化边界，已 fail-closed：${unsupported.join("；")}。请先展开为单一 entry scene 的普通节点，或等待多场景/Prefab renderer。`,
    );
  }
}

function inferSceneResolution(scene: SceneDefinition): { width: number; height: number } {
  const candidates = scene.nodes
    .map((node) => node.transform.size)
    .filter((size): size is [number, number] => Boolean(size && size[0] > 0 && size[1] > 0))
    .sort((left, right) => right[0] * right[1] - left[0] * left[1]);
  return { width: candidates[0]?.[0] ?? 750, height: candidates[0]?.[1] ?? 1334 };
}

function validateBridgeComponents(blueprint: SceneBlueprint, discovered: ScriptComponent[]): void {
  const available = new Set(discovered.map((component) => component.className));
  const builtIn = new Set(["Label", "Sprite", "Button", "AudioSource", "Camera", "UITransform"]);
  for (const scene of blueprint.scenes) {
    for (const node of scene.nodes) {
      for (const component of node.components) {
        const normalizedType = component.type.replace(/^cc\./, "");
        if (!builtIn.has(normalizedType) && !available.has(component.type)) {
          throw new Error(`SceneBlueprint 组件未在 assets/scripts 中发现：${scene.sceneId}/${node.nodeId}/${component.type}`);
        }
      }
    }
  }
}

function renderRuntimeBootstrap(components: ScriptComponent[]): string {
  const imports = components.map((component, index) => component.defaultExport
    ? `import BtpComponent${index} from ${JSON.stringify(component.importPath)};`
    : `import { ${component.exportName} as BtpComponent${index} } from ${JSON.stringify(component.importPath)};`).join("\n");
  const registry = components.map((component, index) => `  ${JSON.stringify(component.className)}: BtpComponent${index},`).join("\n");
  return `import {
  _decorator,
  AudioSource,
  Button,
  Camera,
  Color,
  Component,
  Graphics,
  JsonAsset,
  Label,
  Node,
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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface BlueprintReference {
  property: string;
  kind: 'node' | 'component';
  sceneId: string;
  nodeId: string;
  componentId?: string;
}

interface BlueprintBinding {
  property: string;
  source: {
    type: 'input_action' | 'runtime_signal' | 'game_state';
    ref: string;
  };
}

interface BlueprintComponent {
  componentId: string;
  type: string;
  properties: Record<string, JsonValue>;
  bindings: BlueprintBinding[];
  references: BlueprintReference[];
}

interface BlueprintNode {
  nodeId: string;
  testId: string;
  name: string;
  kind: 'container' | 'sprite' | 'label' | 'button' | 'camera' | 'audio' | 'custom';
  parentNodeId?: string;
  transform: {
    position: [number, number];
    rotation: number;
    scale: [number, number];
    size?: [number, number];
  };
  components: BlueprintComponent[];
}

interface BlueprintScene {
  sceneId: string;
  nodes: BlueprintNode[];
}

interface RuntimeBlueprint {
  entrySceneId: string;
  scenes: BlueprintScene[];
}

const componentRegistry: Record<string, new () => Component> = {
${registry}
};

const builtInRegistry: Record<string, new () => Component> = {
  AudioSource,
  Button,
  Camera,
  Label,
  Sprite,
  UITransform,
};

@ccclass('BtpRuntimeBootstrap')
export class BtpRuntimeBootstrap extends Component {
  private readonly nodes = new Map<string, Node>();
  private readonly attached = new Map<string, Component>();
  private pendingBindings: Array<{ sceneId: string; spec: BlueprintComponent; component: Component }> = [];

  start(): void {
    resources.load('btp/scene-blueprint', JsonAsset, (error, asset) => {
      if (error || !asset) {
        console.error('[BTP Bridge] scene blueprint load failed', error);
        return;
      }
      const blueprint = asset.json as RuntimeBlueprint;
      const scene = blueprint.scenes.find((candidate) => candidate.sceneId === blueprint.entrySceneId);
      if (!scene) {
        console.error('[BTP Bridge] entry scene missing', blueprint.entrySceneId);
        return;
      }
      const resolution = this.inferResolution(scene.nodes);
      view.setDesignResolutionSize(resolution[0], resolution[1], ResolutionPolicy.SHOW_ALL);
      this.nodes.clear();
      this.attached.clear();
      this.pendingBindings.length = 0;
      const pending = [...scene.nodes];
      while (pending.length > 0) {
        const before = pending.length;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const spec = pending[index];
          const parent = spec.parentNodeId ? this.nodes.get(this.nodeKey(scene.sceneId, spec.parentNodeId)) : this.node;
          if (!parent) continue;
          this.materializeNode(scene.sceneId, spec, parent);
          pending.splice(index, 1);
        }
        if (pending.length === before) {
          console.error('[BTP Bridge] unresolved node parents', pending.map((candidate) => candidate.nodeId));
          return;
        }
      }
      // Dependency traversal order must not become draw order. In Cocos UI,
      // later siblings render above earlier ones; reverse traversal previously
      // placed the background on top of every interactive panel.
      const nextSiblingIndex = new Map<string, number>();
      for (const spec of scene.nodes) {
        const parentKey = spec.parentNodeId ?? '__scene_root';
        const siblingIndex = nextSiblingIndex.get(parentKey) ?? 0;
        this.nodes.get(this.nodeKey(scene.sceneId, spec.nodeId))?.setSiblingIndex(siblingIndex);
        nextSiblingIndex.set(parentKey, siblingIndex + 1);
      }
      this.applyRuntimeProperties();
      console.info('[BTP Bridge] scene blueprint materialized', {
        rootChildren: this.node.children.length,
        componentBindings: this.pendingBindings.length,
      });
    });
  }

  private materializeNode(sceneId: string, spec: BlueprintNode, parent: Node): Node {
    const node = new Node(spec.name);
    parent.addChild(node);
    node.layer = parent.layer;
    const [x, y] = spec.transform.position;
    node.setPosition(new Vec3(x, y, 0));
    node.setRotationFromEuler(0, 0, spec.transform.rotation);
    node.setScale(new Vec3(spec.transform.scale[0], spec.transform.scale[1], 1));
    const [width, height] = spec.transform.size ?? [100, 100];
    node.addComponent(UITransform).setContentSize(width, height);
    this.nodes.set(this.nodeKey(sceneId, spec.nodeId), node);
    this.setNodeMetadata(node, spec.testId, spec.kind);
    for (const componentSpec of spec.components) this.attachComponent(sceneId, spec.nodeId, node, componentSpec, width, height);
    return node;
  }

  private attachComponent(
    sceneId: string,
    nodeId: string,
    node: Node,
    spec: BlueprintComponent,
    width: number,
    height: number
  ): void {
    const normalizedType = spec.type.replace(/^cc\./, '');
    const ComponentType = builtInRegistry[normalizedType] ?? componentRegistry[spec.type];
    if (!ComponentType) {
      console.error('[BTP Bridge] component is not registered', spec.type);
      return;
    }
    const component = normalizedType === 'UITransform'
      ? node.getComponent(UITransform) ?? node.addComponent(UITransform)
      : node.getComponent(ComponentType) ?? node.addComponent(ComponentType);
    if (component instanceof Sprite) {
      component.sizeMode = Sprite.SizeMode.CUSTOM;
      this.configureSprite(node, component, spec.properties, width, height);
    }
    this.attached.set(this.componentKey(sceneId, nodeId, spec.componentId), component);
    this.pendingBindings.push({ sceneId, spec, component });
  }

  private configureSprite(node: Node, sprite: Sprite, properties: Record<string, JsonValue>, width: number, height: number): void {
    const assetKey = typeof properties.assetKey === 'string' ? properties.assetKey : undefined;
    const fallbackColor = typeof properties.fallbackColor === 'string' ? properties.fallbackColor : undefined;
    const fallback = this.createFallback(node, width, height, fallbackColor);
    if (!assetKey) return;
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

  private createFallback(node: Node, width: number, height: number, color: string | undefined): Node {
    const fallback = new Node('__btp_fallback');
    node.addChild(fallback);
    fallback.layer = node.layer;
    fallback.addComponent(UITransform).setContentSize(width, height);
    const graphics = fallback.addComponent(Graphics);
    graphics.fillColor = this.parseColor(color, new Color(170, 170, 170, 220));
    graphics.roundRect(-width / 2, -height / 2, width, height, Math.min(18, width / 4, height / 4));
    graphics.fill();
    return fallback;
  }

  private applyRuntimeProperties(): void {
    for (const binding of this.pendingBindings) {
      const target = binding.component as Component & Record<string, unknown>;
      for (const [property, value] of Object.entries(binding.spec.properties)) {
        if (property === 'assetKey' || property === 'fallbackColor') continue;
        this.applyComponentProperty(target, property, value);
      }
      for (const propertyBinding of binding.spec.bindings) {
        target[propertyBinding.property] = propertyBinding.source.ref;
      }
      for (const reference of binding.spec.references) {
        target[reference.property] = this.resolveReference(binding.sceneId, reference);
      }
    }
  }

  private applyComponentProperty(target: Component & Record<string, unknown>, property: string, value: JsonValue): void {
    if (target instanceof Sprite && property === 'sizeMode' && typeof value === 'string') {
      const modes: Record<string, number> = { custom: Sprite.SizeMode.CUSTOM, trimmed: Sprite.SizeMode.TRIMMED, raw: Sprite.SizeMode.RAW };
      const mode = modes[value.toLowerCase()];
      if (mode === undefined) throw new Error('[BTP Bridge] invalid Sprite.sizeMode: ' + value);
      target.sizeMode = mode;
      return;
    }
    if (property === 'color' && typeof value === 'string') {
      target[property] = this.parseColor(value, new Color(255, 255, 255, 255));
      return;
    }
    target[property] = value;
  }

  private resolveReference(currentSceneId: string, reference: BlueprintReference): Node | Component {
    if (reference.sceneId !== currentSceneId) {
      throw new Error('[BTP Bridge] cross-scene reference reached the single-scene runtime: ' + reference.sceneId);
    }
    if (reference.kind === 'node') {
      const node = this.nodes.get(this.nodeKey(currentSceneId, reference.nodeId));
      if (!node) throw new Error('[BTP Bridge] node reference was not materialized: ' + reference.nodeId);
      return node;
    }
    if (!reference.componentId) {
      throw new Error('[BTP Bridge] component reference is missing componentId: ' + reference.nodeId);
    }
    const component = this.attached.get(this.componentKey(currentSceneId, reference.nodeId, reference.componentId));
    if (!component) {
      throw new Error('[BTP Bridge] component reference was not materialized: ' + reference.nodeId + '/' + reference.componentId);
    }
    return component;
  }

  private inferResolution(nodes: BlueprintNode[]): [number, number] {
    return nodes
      .map((candidate) => candidate.transform.size)
      .filter((size): size is [number, number] => Boolean(size && size[0] > 0 && size[1] > 0))
      .sort((left, right) => right[0] * right[1] - left[0] * left[1])[0] ?? [750, 1334];
  }

  private nodeKey(sceneId: string, nodeId: string): string {
    return sceneId + '/' + nodeId;
  }

  private componentKey(sceneId: string, nodeId: string, componentId: string): string {
    return sceneId + '/' + nodeId + '/' + componentId;
  }

  private setNodeMetadata(node: Node, testId: string, kind: BlueprintNode['kind']): void {
    const metadataNode = node as Node & { __btpTestId?: string; __btpKind?: BlueprintNode['kind'] };
    metadataNode.__btpTestId = testId;
    metadataNode.__btpKind = kind;
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
  const absoluteConfig = resolveInsideProject(projectRoot, configPath);
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

function createDirectoryManifest(
  projectRoot: string,
  rootPath: string,
  files: string[]
): ArtifactDirectoryManifest {
  const entries = files
    .map((path) => fileEvidence(projectRoot, path))
    .map(({ path, hash, sizeBytes }) => ({ path, hash, sizeBytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    rootPath: normalizeRelativePath(rootPath).replace(/\/+$/, ""),
    files: entries,
    digest: createHash("sha256").update(canonicalManifestBytes(entries)).digest("hex")
  };
}

function canonicalManifestBytes(entries: Array<{ path: string; hash: string; sizeBytes: number }>): string {
  return entries.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.hash}\n`).join("");
}

/**
 * Child processes only receive operating-system essentials. Project/model/API
 * secrets (BTP_*, *_TOKEN, *_KEY, *_SECRET, credentials) are intentionally not
 * inherited by Creator or project-controlled build hooks.
 */
export function minimalCreatorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "USERPROFILE", "SystemRoot", "WINDIR"]) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  environment.CI = "1";
  return environment;
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
      if (entry.isSymbolicLink()) {
        throw new Error(`Cocos 项目枚举拒绝符号链接：${join(directory, entry.name)}`);
      }
      if ([".git", ".be-the-producer", "node_modules", "library", "temp"].includes(entry.name)) {
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
  return resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    label: "Cocos 项目路径"
  }).absolutePath;
}

function normalizeRelativePath(path: string): string {
  return normalizeRelativePathWithinRoot(path, { label: "Cocos 项目路径" });
}

function ensureDirectoryInsideProject(projectRoot: string, path: string): string {
  const relativePath = path === "." ? "." : normalizeRelativePath(path);
  let resolved = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    allowRoot: true,
    expectedKind: "directory",
    label: "Cocos 项目目录"
  });
  mkdirSync(resolved.absolutePath, { recursive: true });
  resolved = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: false,
    allowRoot: true,
    expectedKind: "directory",
    label: "Cocos 项目目录"
  });
  return resolved.absolutePath;
}

function assertWritableProjectTargets(projectRoot: string, paths: string[]): void {
  for (const path of paths) {
    resolvePathWithinRoot(projectRoot, normalizeRelativePath(path), {
      allowMissing: true,
      expectedKind: "file",
      label: "Cocos 写入目标"
    });
  }
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

function nestedString(value: Record<string, unknown>, path: string[]): string {
  let current: unknown = value;
  for (const segment of path) {
    current = isRecord(current) ? current[segment] : undefined;
  }
  return stringValue(current);
}

function safeAssetId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "asset";
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof ContractValidationError) {
    return `${error.message}：${error.issues.slice(0, 12).map((issue) => `${issue.path} ${issue.message}`).join("；")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
