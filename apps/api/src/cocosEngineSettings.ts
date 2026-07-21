import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CocosEngineConfig {
  executablePath: string;
  version: string;
  platform: "wechatgame";
  buildConfigPath: string;
  timeoutMs: number;
  updatedAt?: string;
}

export interface PublicCocosEngineConfig extends CocosEngineConfig {
  configured: boolean;
  executableExists: boolean;
  autoDetected: boolean;
}

export interface SaveCocosEngineConfigInput {
  executablePath?: string;
  version?: string;
  platform?: "wechatgame";
  buildConfigPath?: string;
  timeoutMs?: number;
}

export interface CocosEngineTestResult {
  ok: boolean;
  executablePath: string;
  version: string;
  latencyMs: number;
  testedAt: string;
  message: string;
  exitCode?: number | null;
  output?: string;
}

const defaultConfig: CocosEngineConfig = {
  executablePath: "",
  version: "3.8.x",
  platform: "wechatgame",
  buildConfigPath: "",
  timeoutMs: 20 * 60 * 1000
};

export class CocosEngineSettingsStore {
  private readonly configPath: string;

  constructor(settingsRoot = defaultSettingsRoot()) {
    this.configPath = join(settingsRoot, "cocos-engine.json");
  }

  getPublic(): PublicCocosEngineConfig {
    const config = this.load();
    const detected = discoverCocosCreatorExecutable();
    const executablePath = config.executablePath || detected || "";
    return {
      ...config,
      executablePath,
      configured: Boolean(config.executablePath),
      executableExists: Boolean(executablePath && isExecutableFile(executablePath)),
      autoDetected: !config.executablePath && Boolean(detected)
    };
  }

  getResolvedConfig(environment: NodeJS.ProcessEnv = process.env): CocosEngineConfig {
    const config = this.load();
    const executablePath = environment.BTP_COCOS_EXECUTABLE?.trim() || config.executablePath || discoverCocosCreatorExecutable() || "";
    const timeoutFromEnvironment = Number(environment.BTP_COCOS_TIMEOUT_MS);
    return {
      ...config,
      executablePath,
      version: environment.BTP_COCOS_VERSION?.trim() || config.version,
      platform: environment.BTP_COCOS_PLATFORM === "wechatgame" ? "wechatgame" : config.platform,
      buildConfigPath: environment.BTP_COCOS_BUILD_CONFIG?.trim() || config.buildConfigPath,
      timeoutMs: Number.isFinite(timeoutFromEnvironment) && timeoutFromEnvironment >= 10_000 ? timeoutFromEnvironment : config.timeoutMs
    };
  }

  save(input: SaveCocosEngineConfigInput): PublicCocosEngineConfig {
    const current = this.load();
    const next: CocosEngineConfig = {
      executablePath: input.executablePath === undefined ? current.executablePath : normalizePath(input.executablePath),
      version: input.version === undefined ? current.version : normalizeVersion(input.version),
      platform: input.platform === undefined ? current.platform : normalizePlatform(input.platform),
      buildConfigPath: input.buildConfigPath === undefined ? current.buildConfigPath : input.buildConfigPath.trim(),
      timeoutMs: input.timeoutMs === undefined ? current.timeoutMs : normalizeTimeout(input.timeoutMs),
      updatedAt: new Date().toISOString()
    };
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    writeFileSync(this.configPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return this.getPublic();
  }

  autodetect(): PublicCocosEngineConfig {
    const executablePath = discoverCocosCreatorExecutable();
    if (!executablePath) {
      throw new Error("未在本机常见安装目录发现 Cocos Creator。请安装 Creator 3.8 LTS，或手动填写可执行文件路径。");
    }
    return this.save({ executablePath, version: inferVersionFromPath(executablePath) || "3.8.x" });
  }

  test(): Promise<CocosEngineTestResult> {
    return testCocosEngineExecutable(this.getResolvedConfig());
  }

  private load(): CocosEngineConfig {
    if (!existsSync(this.configPath)) {
      return { ...defaultConfig };
    }
    try {
      const saved = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<CocosEngineConfig>;
      return {
        executablePath: typeof saved.executablePath === "string" ? saved.executablePath : "",
        version: typeof saved.version === "string" && saved.version.trim() ? saved.version.trim() : defaultConfig.version,
        platform: saved.platform === "wechatgame" ? saved.platform : defaultConfig.platform,
        buildConfigPath: typeof saved.buildConfigPath === "string" ? saved.buildConfigPath : "",
        timeoutMs: typeof saved.timeoutMs === "number" ? normalizeTimeout(saved.timeoutMs) : defaultConfig.timeoutMs,
        ...(typeof saved.updatedAt === "string" ? { updatedAt: saved.updatedAt } : {})
      };
    } catch {
      return { ...defaultConfig };
    }
  }
}

export const cocosEngineSettingsStore = new CocosEngineSettingsStore();

export async function testCocosEngineExecutable(config: CocosEngineConfig): Promise<CocosEngineTestResult> {
  const testedAt = new Date().toISOString();
  const startedAt = Date.now();
  if (!config.executablePath) {
    return Promise.resolve({
      ok: false,
      executablePath: "",
      version: config.version,
      latencyMs: 0,
      testedAt,
      message: "Cocos Creator 未配置。请自动检测或填写 Creator 可执行文件路径。"
    });
  }
  if (!isExecutableFile(config.executablePath)) {
    return Promise.resolve({
      ok: false,
      executablePath: config.executablePath,
      version: config.version,
      latencyMs: Date.now() - startedAt,
      testedAt,
      message: `Cocos Creator 可执行文件不存在或不可执行：${config.executablePath}`
    });
  }
  return new Promise((resolveResult) => {
    const detached = process.platform !== "win32";
    const child = spawn(config.executablePath, ["--version"], {
      env: process.env,
      detached,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let probeStoppedAfterLaunch = false;
    const finish = (result: CocosEngineTestResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(probeTimer);
      clearTimeout(hardTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveResult(result);
    };
    const terminateProcessTree = (): void => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-4_000);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once("error", (error) => {
      finish({
        ok: false,
        executablePath: config.executablePath,
        version: config.version,
        latencyMs: Date.now() - startedAt,
        testedAt,
        message: `Cocos Creator 无法启动：${error.message}`
      });
    });
    child.once("exit", (code, signal) => {
      const output = `${stdout}\n${stderr}`.trim().slice(-2_000);
      const version = extractVersion(output) || inferVersionFromPath(config.executablePath) || config.version;
      const ok = probeStoppedAfterLaunch || code === 0 || code === 36;
      finish({
        ok,
        executablePath: config.executablePath,
        version,
        latencyMs: Date.now() - startedAt,
        testedAt,
        message: ok
          ? probeStoppedAfterLaunch
            ? `Cocos Creator ${version} 已成功启动；探测进程已主动终止，正式构建时将保持运行。`
            : `Cocos Creator ${version} 可用。`
          : `Cocos Creator 连通性检测失败：${signal ? `进程被 ${signal} 终止` : `退出码 ${code ?? "unknown"}`}`,
        exitCode: code,
        ...(output ? { output } : {})
      });
    });
    const probeTimer = setTimeout(() => {
      probeStoppedAfterLaunch = true;
      terminateProcessTree();
    }, 2_500);
    const hardTimer = setTimeout(() => {
      terminateProcessTree();
      finish({
        ok: false,
        executablePath: config.executablePath,
        version: inferVersionFromPath(config.executablePath) || config.version,
        latencyMs: Date.now() - startedAt,
        testedAt,
        message: "Cocos Creator 探测进程无法在超时后终止。"
      });
    }, 8_000);
  });
}

export function discoverCocosCreatorExecutable(): string | undefined {
  const explicit = process.env.BTP_COCOS_EXECUTABLE?.trim();
  if (explicit && isExecutableFile(explicit)) {
    return resolve(explicit);
  }

  const directCandidates = [
    "/Applications/CocosCreator.app/Contents/MacOS/CocosCreator",
    "/Applications/Cocos/Creator/CocosCreator.app/Contents/MacOS/CocosCreator",
    join(homeDirectory(), "Applications", "CocosCreator.app", "Contents", "MacOS", "CocosCreator"),
    "/usr/local/bin/CocosCreator",
    "/usr/local/bin/cocos-creator",
    "/usr/bin/CocosCreator"
  ];
  for (const candidate of directCandidates) {
    if (isExecutableFile(candidate)) {
      return resolve(candidate);
    }
  }

  const versionRoots = [
    "/Applications/CocosCreator/Creator",
    "/Applications/Cocos/Creator",
    join(homeDirectory(), "Applications", "CocosCreator", "Creator"),
    join(homeDirectory(), "Applications", "Cocos", "Creator")
  ];
  const discovered = versionRoots.flatMap((root) => discoverVersionedExecutables(root));
  return discovered.sort((left, right) => compareCreatorPaths(right, left))[0];
}

function discoverVersionedExecutables(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const base = join(root, entry.name);
      return [
        join(base, "CocosCreator.app", "Contents", "MacOS", "CocosCreator"),
        join(base, "Creator.app", "Contents", "MacOS", "CocosCreator"),
        join(base, "CocosCreator")
      ].filter(isExecutableFile);
    });
}

function isExecutableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function defaultSettingsRoot(): string {
  return process.env.GAME_PIPELINE_SETTINGS_ROOT ?? join(process.env.INIT_CWD ?? process.cwd(), ".local", "settings");
}

function homeDirectory(): string {
  return process.env.HOME ?? "";
}

function normalizePath(value: string): string {
  const path = value.trim();
  return path ? resolve(path.replace(/^~(?=\/)/, homeDirectory())) : "";
}

function normalizeVersion(value: string): string {
  return value.trim() || defaultConfig.version;
}

function normalizePlatform(value: string): "wechatgame" {
  if (value !== "wechatgame") {
    throw new Error(`当前 Cocos Bridge 只支持 wechatgame，收到：${value}`);
  }
  return value;
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value)) {
    return defaultConfig.timeoutMs;
  }
  return Math.max(10_000, Math.min(60 * 60 * 1000, Math.round(value)));
}

function inferVersionFromPath(path: string): string {
  return path.match(/(?:Creator\/|CocosCreator\/)(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? "";
}

function extractVersion(output: string): string {
  return output.match(/\b(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)\b/)?.[1] ?? "";
}

function compareCreatorPaths(left: string, right: string): number {
  return inferVersionFromPath(left).localeCompare(inferVersionFromPath(right), undefined, { numeric: true });
}
