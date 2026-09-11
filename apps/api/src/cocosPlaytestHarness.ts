import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { CocosEngineBridge, type CocosBridgeEvidence } from "./cocosEngineBridge.js";
import type { CocosEngineConfig } from "./cocosEngineSettings.js";
import { loadPlaytestContract, type LoadedPlaytestContract } from "./playtestContractLoader.js";
import { runPlaytestContract, type PlaytestContractRunResult } from "./playtestContractRunner.js";
import {
  renderPlaytestMarker,
  type PlaytestCheckResult,
  type PlaytestDefect,
  type PlaytestReportEvidence,
  type PlaytestVerdict
} from "./playtestEvidence.js";
import { writeQaPlaytestReceipt } from "./qaPlaytestReceipt.js";
import { BrowserRuntimeAdapter } from "./runtimeAdapterBrowser.js";
import { BTP_PLAYTEST_PROTOCOL_VERSION } from "./runtimeAdapter.js";
import type { ArtifactInputProvenance } from "@game-pipeline/shared-schemas";
import { normalizeRelativePathWithinRoot, resolvePathWithinRoot } from "./pathSafety.js";

export interface CocosPlaytestInput {
  previewUrl?: string;
  skipBuild?: boolean;
  maxDurationSec?: number;
  viewport?: { width: number; height: number };
  reportPath?: string;
  playtestContractPath?: string;
  adapterMode?: "auto" | "contract" | "legacy_yarn_v1";
  taskInputEvidence?: ArtifactInputProvenance[];
}

export interface CocosPlaytestResult extends PlaytestReportEvidence {
  ok: boolean;
  summary: string;
  reportPath: string;
  evidence: CocosBridgeEvidence[];
}

interface RuntimeLabel {
  path: string;
  parentPath: string;
  text: string;
  fontSize: number;
  overflow: number;
  active: boolean;
  box?: { x: number; y: number; width: number; height: number };
  parentBox?: { x: number; y: number; width: number; height: number };
}

interface RuntimeUiNode {
  path: string;
  active: boolean;
  componentNames: string[];
  box?: { x: number; y: number; width: number; height: number };
}

interface RuntimeSnapshot {
  state?: string;
  remainingTime?: number;
  interceptionCount?: number;
  labels: RuntimeLabel[];
  uiNodes: RuntimeUiNode[];
  buttonCandidates: Array<{ path: string; active: boolean; hasButton: boolean; box?: { x: number; y: number; width: number; height: number } }>;
  designSize: { width: number; height: number };
}

const defaultViewport = { width: 390, height: 844 };
const defaultReportPath = "agents/qa/playtest-reports/report-001.md";

export class CocosPlaytestHarness {
  constructor(
    private readonly projectRoot: string,
    private readonly config: CocosEngineConfig
  ) {}

  async run(input: CocosPlaytestInput = {}): Promise<CocosPlaytestResult> {
    const operationId = `playtest_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const reportPath = input.reportPath?.trim() || defaultReportPath;
    const runRoot = `agents/qa/playtest-runs/${operationId}`;
    const startedAt = Date.now();
    const evidencePaths: string[] = [];
    const checks: PlaytestCheckResult[] = [];
    const defects: PlaytestDefect[] = [];
    const consoleLines: string[] = [];
    const buildEvidence: CocosBridgeEvidence[] = [];
    let page: Page | undefined;
    let launchPhase = "contract_load";
    let previewUrl = input.previewUrl?.trim();
    let outputDir: string | undefined;
    let browser: Browser | undefined;
    let staticServer: Server | undefined;
    let buildOperationId: string | undefined;
    let initial: RuntimeSnapshot | undefined;
    let playing: RuntimeSnapshot | undefined;
    let terminal: RuntimeSnapshot | undefined;
    let restarted: RuntimeSnapshot | undefined;
    let loadedContract: LoadedPlaytestContract | undefined;

    if (input.adapterMode !== "legacy_yarn_v1" && (!input.taskInputEvidence || input.taskInputEvidence.length === 0)) {
      throw new Error("生产 Playtest 必须携带由 Orchestrator 冻结的当前 task input receipt；仅 legacy_yarn_v1 fixture 可省略。");
    }

    try {
      loadedContract = input.adapterMode === "legacy_yarn_v1"
        ? undefined
        : loadPlaytestContract(this.projectRoot, input.playtestContractPath);
      if (input.adapterMode === "contract" && !loadedContract) {
        throw new Error("已要求 contract 模式，但项目没有 PlaytestContract。");
      }
      if (!input.skipBuild) {
        launchPhase = "web_build";
        outputDir = `shared/build-artifacts/playtest/${operationId}`;
        const build = new CocosEngineBridge(this.projectRoot, this.config).build({
          platform: "web-desktop",
          debug: true,
          outputDir
        });
        buildOperationId = build.operationId;
        // The nested build is part of this trusted service invocation, even
        // when the subsequent browser/adapter check fails. Preserve its exact
        // bytes for the outer transaction; do not grant QA general writes.
        buildEvidence.push(...build.evidence.filter((item) => !item.path.startsWith("assets/")));
        const outputFiles = Array.isArray(build.details?.outputFiles) ? build.details.outputFiles : [];
        buildEvidence.push(...outputFiles.filter((path): path is string => typeof path === "string")
          .map((path) => fileEvidence(this.projectRoot, path)));
        if (!build.ok) {
          throw new Error(`QA Web 构建失败：${build.error ?? build.summary}`);
        }
        const served = await startStaticServer(resolve(this.projectRoot, outputDir));
        staticServer = served.server;
        previewUrl = served.url;
      }
      if (!previewUrl) {
        throw new Error("没有可供试玩的 Web URL。请先完成 Cocos Web 构建或传入 previewUrl。");
      }

      launchPhase = "browser_launch";
      browser = await chromium.launch({
        headless: true,
        executablePath: discoverChromeExecutable()
      });
      page = await browser.newPage({ viewport: input.viewport ?? defaultViewport });
      page.on("console", (message) => {
        consoleLines.push(`[${message.type()}] ${message.text()}`);
      });
      page.on("pageerror", (error) => {
        consoleLines.push(`[pageerror] ${error.message}`);
      });

      launchPhase = "scene_load";
      await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(() => {
        const cocos = (globalThis as unknown as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        return Boolean(cocos?.director?.getScene?.());
      }, undefined, { timeout: 30_000 });
      await page.waitForTimeout(1_000);

      if (loadedContract) {
        launchPhase = "runtime_adapter";
        return await this.runContractMode({
          page,
          loadedContract,
          operationId,
          reportPath,
          runRoot,
          startedAt,
          ...(buildOperationId ? { buildOperationId } : {}),
          evidencePaths,
          checks,
          defects,
          consoleLines,
          buildEvidence,
          taskInputEvidence: input.taskInputEvidence ?? []
        });
      }

      // Explicit legacy adapter for pre-contract yarn defence projects. Any
      // present contract always takes the path above; handshake errors never
      // fall through to this compatibility implementation.
      initial = await captureRuntimeSnapshot(page);
      evidencePaths.push(await captureScreenshot(page, this.projectRoot, `${runRoot}/01-initial.png`));
      addCheck(checks, "launch", "游戏可启动", "passed", `Cocos 场景已加载，初始状态为 ${initial.state ?? "unknown"}。`);

      const canvas = page.locator("canvas").first();
      await canvas.click({ position: { x: Math.max(1, (await canvas.boundingBox())?.width ? ((await canvas.boundingBox())?.width ?? 2) / 2 : 1), y: Math.max(1, (await canvas.boundingBox())?.height ? ((await canvas.boundingBox())?.height ?? 2) / 2 : 1) } });
      const started = await waitForRuntimeState(page, (state) => Boolean(state && state !== "IDLE"), 8_000);
      playing = await captureRuntimeSnapshot(page);
      evidencePaths.push(await captureScreenshot(page, this.projectRoot, `${runRoot}/02-playing.png`));
      if (started) {
        addCheck(checks, "start_flow", "开始交互进入游戏", "passed", `点击画布后状态进入 ${playing.state ?? "unknown"}。`);
      } else {
        addCheck(checks, "start_flow", "开始交互进入游戏", "failed", "点击主画布后仍未离开 IDLE。", defects, defect({
          operationId,
          category: "interaction",
          severity: "blocker",
          title: "游戏无法通过玩家输入开始",
          details: "自动化点击主画布后 8 秒内未进入运行状态。",
          ownerAgentId: "gameplay_programmer",
          evidencePaths: [`${runRoot}/01-initial.png`, `${runRoot}/02-playing.png`]
        }));
      }

      if (started) {
        await setRuntimeTimeScale(page, 4);
        const terminalReached = await exerciseUntilTerminal(page, (input.maxDurationSec ?? 30) * 1_000);
        terminal = await captureRuntimeSnapshot(page);
        evidencePaths.push(await captureScreenshot(page, this.projectRoot, `${runRoot}/03-terminal.png`));
        if (terminalReached) {
          addCheck(checks, "terminal_flow", "运行到胜负终局", "passed", `实际运行到 ${terminal.state ?? "terminal"}。`);
        } else {
          addCheck(checks, "terminal_flow", "运行到胜负终局", "failed", `在 ${input.maxDurationSec ?? 30} 秒测试窗口内未进入 GAME_OVER/WIN。`, defects, defect({
            operationId,
            category: "coverage",
            severity: "blocker",
            title: "无法覆盖完整胜负流程",
            details: "受控玩家输入和 4 倍运行时加速后仍未进入终局，不能判定可玩性通过。",
            ownerAgentId: "gameplay_programmer",
            evidencePaths: [`${runRoot}/02-playing.png`, `${runRoot}/03-terminal.png`]
          }));
        }
      }

      if (terminal && ["GAME_OVER", "WIN"].includes(terminal.state ?? "")) {
        inspectHudRuntime(operationId, terminal, runRoot, checks, defects);
        inspectTerminalUi(operationId, terminal, initial, runRoot, checks, defects);
        const restartButton = terminal.buttonCandidates.find((candidate) => candidate.active && /retry|again|restart/i.test(candidate.path));
        if (!restartButton?.hasButton) {
          addCheck(checks, "restart_control", "终局重开按钮可交互", "failed", "终局面板没有可点击的 Cocos Button 组件。", defects, defect({
            operationId,
            category: "interaction",
            severity: "critical",
            title: "再来一次按钮未绑定可点击组件",
            details: "终局面板存在重开视觉节点，但没有 Button 组件，无法证明玩家可以重开。",
            ownerAgentId: "cocos_tech_lead",
            evidencePaths: [`${runRoot}/03-terminal.png`]
          }));
        } else if (restartButton.box) {
          addCheck(checks, "restart_control", "终局重开按钮可交互", "passed", `找到可点击组件：${restartButton.path}。`);
          await clickRuntimeBox(page, restartButton.box, terminal.designSize);
          const didRestart = await waitForRuntimeState(page, (state) => state === "IDLE" || state === "PLAYING", 5_000);
          restarted = await captureRuntimeSnapshot(page);
          evidencePaths.push(await captureScreenshot(page, this.projectRoot, `${runRoot}/04-restarted.png`));
          addCheck(
            checks,
            "restart_flow",
            "终局后可重新开始",
            didRestart ? "passed" : "failed",
            didRestart ? `点击重开后状态为 ${restarted.state ?? "unknown"}。` : `点击重开后状态仍为 ${restarted.state ?? "unknown"}。`,
            defects,
            didRestart ? undefined : defect({
              operationId,
              category: "interaction",
              severity: "critical",
              title: "终局后无法重新开始",
              details: "点击再来一次后 5 秒内没有回到 IDLE/PLAYING。",
              ownerAgentId: "gameplay_programmer",
              evidencePaths: [`${runRoot}/03-terminal.png`, `${runRoot}/04-restarted.png`]
            })
          );
        } else {
          addCheck(checks, "restart_control", "终局重开按钮可交互", "failed", "重开按钮缺少可点击包围盒，无法进行真实点击。", defects, defect({
            operationId,
            category: "ui_layout",
            severity: "critical",
            title: "再来一次按钮没有有效点击区域",
            details: `节点 ${restartButton.path} 存在 Button，但 UITransform 无有效包围盒。`,
            ownerAgentId: "cocos_tech_lead",
            evidencePaths: [`${runRoot}/03-terminal.png`]
          }));
        }
      }

      const snapshotsPath = writeJsonEvidence(this.projectRoot, `${runRoot}/runtime-snapshots.json`, { initial, playing, terminal, restarted });
      evidencePaths.push(snapshotsPath);

      const consolePath = writeTextEvidence(this.projectRoot, `${runRoot}/console.log`, `${consoleLines.join("\n")}\n`);
      evidencePaths.push(consolePath);
      const consoleErrors = consoleLines.filter((line) => /^\[(?:error|pageerror)\]/.test(line));
      addCheck(
        checks,
        "console_errors",
        "运行时无控制台错误",
        consoleErrors.length === 0 ? "passed" : "failed",
        consoleErrors.length === 0 ? "未捕获 console.error 或 pageerror。" : `捕获 ${consoleErrors.length} 条运行时错误。`,
        defects,
        consoleErrors.length === 0 ? undefined : defect({
          operationId,
          category: "console",
          severity: "critical",
          title: "试玩期间出现运行时错误",
          details: consoleErrors.slice(0, 5).join("；"),
          ownerAgentId: "gameplay_programmer",
          evidencePaths: [consolePath]
        })
      );

      const verdict: PlaytestVerdict = defects.some((item) => ["blocker", "critical", "major"].includes(item.severity)) ? "fail" : "pass";
      const completedAt = new Date().toISOString();
      const machineResult: PlaytestReportEvidence = {
        operationId,
        verdict,
        completedAt,
        ...(buildOperationId ? { buildOperationId } : {}),
        checks,
        defects,
        evidencePaths,
        runtime: {
          ...(initial?.state ? { initialState: initial.state } : {}),
          ...(playing?.state ? { playingState: playing.state } : {}),
          ...(terminal?.state ? { terminalState: terminal.state } : {}),
          ...(restarted?.state ? { restartedState: restarted.state } : {}),
          consoleErrorCount: consoleErrors.length,
          durationMs: Date.now() - startedAt
        }
      };
      const resultPath = writeJsonEvidence(this.projectRoot, `${runRoot}/result.json`, machineResult);
      evidencePaths.push(resultPath);
      machineResult.evidencePaths = evidencePaths;
      writeTextEvidence(this.projectRoot, reportPath, renderMarkdownReport(machineResult));

      const evidence = [...buildEvidence, ...[reportPath, ...evidencePaths].map((path) => fileEvidence(this.projectRoot, path))];
      const result: CocosPlaytestResult = {
        ...machineResult,
        ok: true,
        summary: verdict === "pass" ? "真实 Cocos 试玩通过全部硬性检查。" : `真实 Cocos 试玩未通过，发现 ${defects.length} 个缺陷。`,
        reportPath,
        evidence
      };
      writeQaPlaytestReceipt(this.projectRoot, reportPath, machineResult, evidence, input.taskInputEvidence ?? []);
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const details = error instanceof Error ? error.message : String(error);
      const consoleErrors = consoleLines.filter((line) => /^\[(?:error|pageerror)\]/.test(line));
      const consolePath = writeTextEvidence(this.projectRoot, `${runRoot}/console.log`, `${consoleLines.join("\n")}\n`);
      evidencePaths.push(consolePath);
      evidencePaths.push(writeJsonEvidence(this.projectRoot, `${runRoot}/launch.json`, {
        phase: launchPhase, platform: input.skipBuild ? "external_preview" : "web-desktop",
        outputPath: outputDir, previewUrl, buildOperationId,
        sceneLoaded: launchPhase === "runtime_adapter", error: details, consoleErrors
      }));
      if (page) {
        const screenshotPath = `${runRoot}/blocked-page.png`;
        try {
          ensureDirectoryInsideProject(this.projectRoot, runRoot);
          await page.screenshot({ path: resolveInsideProject(this.projectRoot, screenshotPath), timeout: 5_000 });
          evidencePaths.push(screenshotPath);
        } catch { /* Browser startup may itself have failed; keep the logs. */ }
      }
      const failureDetails = `阶段=${launchPhase}；实际目标=${input.skipBuild ? previewUrl : `web-desktop:${outputDir ?? "未构建"}`}；${details}` +
        (consoleErrors.length ? `；运行时错误：${consoleErrors.slice(0, 5).join("；")}` : "；未捕获控制台错误，不代表游戏没有缺陷。");
      const blockedDefect = defect({
        operationId,
        category: "runtime",
        severity: "blocker",
        title: launchPhase === "runtime_adapter" ? "游戏场景已加载但运行时适配器未就绪" : "试玩基础设施无法执行",
        details: failureDetails,
        ownerAgentId: launchPhase === "runtime_adapter" ? "gameplay_programmer" : "cocos_automation",
        evidencePaths: [...evidencePaths]
      });
      defects.push(blockedDefect);
      checks.push({ checkId: "playtest_infrastructure", label: "试玩基础设施可用", status: "blocked", details });
      const blockedContract = loadedContract
        ? {
            schemaVersion: "1.0.0" as const,
            playtestId: loadedContract.contract.playtestId,
            revision: loadedContract.contract.revision,
            path: loadedContract.path,
            hash: loadedContract.hash,
            sizeBytes: loadedContract.sizeBytes,
            runtimeProtocol: BTP_PLAYTEST_PROTOCOL_VERSION,
            adapterMode: "runtime_adapter" as const,
            hashVerified: false
          }
        : undefined;
      const machineResult: PlaytestReportEvidence = {
        ...(blockedContract ? { schemaVersion: 2 as const } : {}),
        operationId,
        verdict: "blocked",
        completedAt,
        ...(buildOperationId ? { buildOperationId } : {}),
        checks,
        defects,
        evidencePaths,
        ...(blockedContract ? { contract: blockedContract, scenarios: [] } : {}),
        runtime: { consoleErrorCount: consoleErrors.length, durationMs: Date.now() - startedAt }
      };
      evidencePaths.push(writeJsonEvidence(this.projectRoot, `${runRoot}/result.json`, machineResult));
      writeTextEvidence(this.projectRoot, reportPath, renderMarkdownReport(machineResult));
      const evidence = [...buildEvidence, ...[reportPath, ...evidencePaths].map((path) => fileEvidence(this.projectRoot, path))];
      const result: CocosPlaytestResult = {
        ...machineResult,
        ok: false,
        summary: `Cocos 试玩未能执行：${failureDetails}`,
        reportPath,
        evidence
      };
      writeQaPlaytestReceipt(this.projectRoot, reportPath, machineResult, evidence, input.taskInputEvidence ?? []);
      return result;
    } finally {
      await browser?.close().catch(() => undefined);
      if (staticServer) {
        await new Promise<void>((resolveClose) => staticServer?.close(() => resolveClose()));
      }
    }
  }

  private async runContractMode(input: {
    page: Page;
    loadedContract: LoadedPlaytestContract;
    operationId: string;
    reportPath: string;
    runRoot: string;
    startedAt: number;
    buildOperationId?: string;
    evidencePaths: string[];
    checks: PlaytestCheckResult[];
    defects: PlaytestDefect[];
    consoleLines: string[];
    buildEvidence: CocosBridgeEvidence[];
    taskInputEvidence: ArtifactInputProvenance[];
  }): Promise<CocosPlaytestResult> {
    const adapter = await BrowserRuntimeAdapter.connect(input.page);
    addCheck(input.checks, "launch", "场景与测试接口已加载", "passed", "已发现 Cocos 场景和 Playtest Runtime Adapter；游戏是否可交互由后续契约场景验证。");

    let run: PlaytestContractRunResult;
    try {
      run = await runPlaytestContract({
        contract: input.loadedContract.contract,
        contractHash: input.loadedContract.hash,
        adapter,
        observer: {
          onScenarioCompleted: async ({ scenario, scenarioIndex }) => {
            if (!scenario.requiredArtifacts.includes("screenshot")) return [];
            const path = `${input.runRoot}/${String(scenarioIndex + 1).padStart(2, "0")}-${safeEvidenceName(scenario.scenarioId)}.png`;
            input.evidencePaths.push(await captureScreenshot(input.page, this.projectRoot, path));
            return [path];
          }
        }
      });
      addCheck(
        input.checks,
        "adapter_handshake",
        "运行时适配器与 PlaytestContract 握手",
        "passed",
        `协议 ${run.handshake.protocolVersion}，${run.handshake.playtestId}@${run.handshake.revision}；契约 hash 已校验。`
      );
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(`PlaytestContract 或 Runtime Adapter 握手失败，禁止回退 legacy：${details}`);
    }

    for (const scenario of run.scenarios) {
      addCheck(
        input.checks,
        `scenario:${scenario.scenarioId}`,
        `契约场景：${scenario.title}`,
        scenario.passed ? "passed" : "failed",
        scenario.details,
        input.defects,
        scenario.passed || !scenario.required ? undefined : defect({
          operationId: input.operationId,
          category: "coverage",
          severity: "blocker",
          title: `必需试玩场景未通过：${scenario.title}`,
          details: scenario.details,
          ownerAgentId: "gameplay_programmer",
          evidencePaths: scenario.evidencePaths
        })
      );
      for (const step of scenario.steps) {
        addCheck(
          input.checks,
          `step:${scenario.scenarioId}:${step.stepId}`,
          `契约步骤：${scenario.title} / ${step.stepId}`,
          step.passed ? "passed" : "failed",
          step.details,
          input.defects,
          step.passed || !scenario.required || !step.required ? undefined : defect({
            operationId: input.operationId,
            category: "interaction",
            severity: "critical",
            title: `必需试玩步骤未通过：${step.stepId}`,
            details: step.details,
            ownerAgentId: "gameplay_programmer",
            evidencePaths: scenario.evidencePaths
          })
        );
      }
    }
    for (const gate of run.qualityGates) {
      addCheck(
        input.checks,
        `quality_gate:${gate.gateId}`,
        `契约质量门禁：${gate.gateId}`,
        gate.passed ? "passed" : "failed",
        gate.details,
        input.defects,
        gate.passed ? undefined : defect({
          operationId: input.operationId,
          category: "dynamic_value",
          severity: "major",
          title: `契约质量门禁未通过：${gate.gateId}`,
          details: gate.details,
          ownerAgentId: "gameplay_programmer",
          evidencePaths: []
        })
      );
    }
    const runtimeTracePath = writeJsonEvidence(this.projectRoot, `${input.runRoot}/runtime-trace.json`, run.snapshots);
    input.evidencePaths.push(runtimeTracePath);
    const consolePath = writeTextEvidence(this.projectRoot, `${input.runRoot}/console.log`, `${input.consoleLines.join("\n")}\n`);
    input.evidencePaths.push(consolePath);
    const metricsPath = writeJsonEvidence(this.projectRoot, `${input.runRoot}/metrics.json`, {
      samples: run.snapshots.map((snapshot) => ({
        sequence: snapshot.sequence,
        timestampMs: snapshot.timestampMs,
        state: snapshot.state,
        signals: snapshot.signals
      }))
    });
    input.evidencePaths.push(metricsPath);
    for (const [scenarioIndex, scenario] of run.scenarios.entries()) {
      const contractScenario = input.loadedContract.contract.scenarios[scenarioIndex];
      if (!contractScenario) continue;
      const artifactPaths: Partial<Record<(typeof contractScenario.requiredArtifacts)[number], string>> = {
        runtime_trace: runtimeTracePath,
        console_log: consolePath,
        metrics: metricsPath
      };
      for (const artifactKind of contractScenario.requiredArtifacts) {
        const path = artifactKind === "screenshot"
          ? scenario.evidencePaths.find((candidate) => candidate.toLowerCase().endsWith(".png"))
          : artifactKind === "video"
            ? scenario.evidencePaths.find((candidate) => /\.(?:mp4|webm)$/i.test(candidate))
            : artifactPaths[artifactKind];
        if (path && !scenario.evidencePaths.includes(path)) scenario.evidencePaths.push(path);
        const passed = Boolean(path);
        if (!passed && scenario.required) {
          scenario.passed = false;
          scenario.details = `${scenario.details} 缺少契约要求的 ${artifactKind} 证据。`;
        }
        addCheck(
          input.checks,
          `artifact:${scenario.scenarioId}:${artifactKind}`,
          `契约证据：${scenario.title} / ${artifactKind}`,
          passed ? "passed" : "failed",
          passed ? `已生成机器证据：${path}` : `Harness 尚未生成契约要求的 ${artifactKind} 证据。`,
          input.defects,
          passed || !scenario.required ? undefined : defect({
            operationId: input.operationId,
            category: "coverage",
            severity: "major",
            title: `缺少契约要求的试玩证据：${artifactKind}`,
            details: `${scenario.title} 要求 ${artifactKind}，本轮未生成。`,
            ownerAgentId: "cocos_automation",
            evidencePaths: scenario.evidencePaths
          })
        );
      }
    }
    const contractPassed = run.scenarios.every((scenario) => !scenario.required || scenario.passed) &&
      run.qualityGates.every((gate) => gate.passed);
    addCheck(
      input.checks,
      "contract_conformance",
      "PlaytestContract 全部必需项通过",
      contractPassed ? "passed" : "failed",
      contractPassed ? "全部 required 场景、步骤、证据及质量门禁通过。" : "至少一个 required 场景、步骤、证据或质量门禁失败。"
    );
    const consoleErrors = input.consoleLines.filter((line) => /^\[(?:error|pageerror)\]/.test(line));
    addCheck(
      input.checks,
      "console_errors",
      "运行时无控制台错误",
      consoleErrors.length === 0 ? "passed" : "failed",
      consoleErrors.length === 0 ? "未捕获 console.error 或 pageerror。" : `捕获 ${consoleErrors.length} 条运行时错误。`,
      input.defects,
      consoleErrors.length === 0 ? undefined : defect({
        operationId: input.operationId,
        category: "console",
        severity: "critical",
        title: "试玩期间出现运行时错误",
        details: consoleErrors.slice(0, 5).join("；"),
        ownerAgentId: "gameplay_programmer",
        evidencePaths: [consolePath]
      })
    );

    const seriousDefects = input.defects.some((item) => ["blocker", "critical", "major"].includes(item.severity));
    const verdict: PlaytestVerdict = contractPassed && !seriousDefects && consoleErrors.length === 0 ? "pass" : "fail";
    const completedAt = new Date().toISOString();
    const firstScenario = run.scenarios[0];
    const lastScenario = run.scenarios.at(-1);
    const machineResult: PlaytestReportEvidence = {
      schemaVersion: 2,
      operationId: input.operationId,
      verdict,
      completedAt,
      ...(input.buildOperationId ? { buildOperationId: input.buildOperationId } : {}),
      checks: input.checks,
      defects: input.defects,
      evidencePaths: input.evidencePaths,
      contract: {
        schemaVersion: "1.0.0",
        playtestId: input.loadedContract.contract.playtestId,
        revision: input.loadedContract.contract.revision,
        path: input.loadedContract.path,
        hash: input.loadedContract.hash,
        sizeBytes: input.loadedContract.sizeBytes,
        runtimeProtocol: BTP_PLAYTEST_PROTOCOL_VERSION,
        adapterMode: "runtime_adapter",
        ...(run.handshake.contractHash ? { runtimeContractHash: run.handshake.contractHash } : {}),
        hashVerified: run.hashVerified
      },
      scenarios: run.scenarios.map((scenario) => ({
        scenarioId: scenario.scenarioId,
        title: scenario.title,
        required: scenario.required,
        passed: scenario.passed,
        initialState: scenario.initialState,
        finalState: scenario.finalState,
        requiredStepIds: scenario.steps.filter((step) => step.required).map((step) => step.stepId),
        passedStepIds: scenario.steps.filter((step) => step.passed).map((step) => step.stepId),
        evidencePaths: scenario.evidencePaths,
        details: scenario.details
      })),
      runtime: {
        ...(firstScenario ? { initialState: firstScenario.initialState } : {}),
        ...(lastScenario ? { terminalState: lastScenario.finalState } : {}),
        consoleErrorCount: consoleErrors.length,
        durationMs: Date.now() - input.startedAt
      }
    };
    const resultPath = writeJsonEvidence(this.projectRoot, `${input.runRoot}/result.json`, machineResult);
    input.evidencePaths.push(resultPath);
    machineResult.evidencePaths = input.evidencePaths;
    writeTextEvidence(this.projectRoot, input.reportPath, renderMarkdownReport(machineResult));
    const evidencePaths = [...new Set([input.reportPath, ...input.evidencePaths])];
    const evidence = [...input.buildEvidence, ...evidencePaths.map((path) => fileEvidence(this.projectRoot, path))];
    const result: CocosPlaytestResult = {
      ...machineResult,
      ok: true,
      summary: verdict === "pass"
        ? `PlaytestContract ${input.loadedContract.contract.playtestId}@${input.loadedContract.contract.revision} 全部必需项通过。`
        : `PlaytestContract 试玩未通过，发现 ${input.defects.length} 个缺陷。`,
      reportPath: input.reportPath,
      evidence
    };
    try {
      writeQaPlaytestReceipt(this.projectRoot, input.reportPath, machineResult, evidence, input.taskInputEvidence);
    } catch (error) {
      machineResult.verdict = "blocked";
      result.verdict = "blocked";
      result.ok = false;
      result.summary = `PlaytestContract 证据在收据提交前发生变化：${error instanceof Error ? error.message : String(error)}`;
      writeTextEvidence(this.projectRoot, input.reportPath, renderMarkdownReport(machineResult));
      result.evidence = [...new Set([input.reportPath, ...input.evidencePaths])].map((path) => fileEvidence(this.projectRoot, path));
    }
    return result;
  }
}

async function captureRuntimeSnapshot(page: Page): Promise<RuntimeSnapshot> {
  return page.evaluate(() => {
    type CocosComponent = Record<string, unknown> & { constructor?: { name?: string } };
    type CocosNode = {
      name: string;
      activeInHierarchy: boolean;
      children?: CocosNode[];
      components?: CocosComponent[];
    };
    const cocos = (globalThis as unknown as {
      cc: {
        director: { getScene: () => CocosNode };
        view: { getDesignResolutionSize: () => { width: number; height: number } };
      };
    }).cc;
    const labels: RuntimeLabel[] = [];
    const uiNodes: RuntimeUiNode[] = [];
    const buttonCandidates: RuntimeSnapshot["buttonCandidates"] = [];
    let state: string | undefined;
    let remainingTime: number | undefined;
    let interceptionCount: number | undefined;
    const boxFor = (component: CocosComponent): RuntimeLabel["box"] => {
      const transform = component as CocosComponent & { getBoundingBoxToWorld?: () => { x: number; y: number; width: number; height: number } };
      try {
        const box = transform.getBoundingBoxToWorld?.();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined;
      } catch {
        return undefined;
      }
    };
    const walk = (node: CocosNode, parentPath: string, parentBox?: RuntimeLabel["parentBox"]): void => {
      const path = `${parentPath}/${node.name}`;
      const components = node.components ?? [];
      const transform = components.find((component) => component.constructor?.name === "UITransform");
      const label = components.find((component) => component.constructor?.name === "Label");
      const controller = components.find((component) => component.constructor?.name === "GameController");
      if (label) {
        const labelBox = transform ? boxFor(transform) : undefined;
        labels.push({
          path,
          parentPath,
          text: String(label.string ?? ""),
          fontSize: Number(label.fontSize ?? 0),
          overflow: Number(label.overflow ?? 0),
          active: node.activeInHierarchy,
          ...(labelBox ? { box: labelBox } : {}),
          ...(parentBox ? { parentBox } : {})
        });
      }
      if (controller) {
        state = typeof controller._state === "string" ? controller._state : state;
        remainingTime = typeof controller._remainingTime === "number" ? controller._remainingTime : remainingTime;
        interceptionCount = typeof controller._interceptionCount === "number" ? controller._interceptionCount : interceptionCount;
      }
      const nodeBox = transform ? boxFor(transform) : undefined;
      if (transform) {
        uiNodes.push({
          path,
          active: node.activeInHierarchy,
          componentNames: components.map((component) => component.constructor?.name ?? "Unknown"),
          ...(nodeBox ? { box: nodeBox } : {})
        });
      }
      if (/retry|again|restart/i.test(node.name)) {
        const buttonBox = nodeBox;
        buttonCandidates.push({
          path,
          active: node.activeInHierarchy,
          hasButton: components.some((component) => component.constructor?.name === "Button"),
          ...(buttonBox ? { box: buttonBox } : {})
        });
      }
      for (const child of node.children ?? []) {
        walk(child, path, nodeBox);
      }
    };
    walk(cocos.director.getScene(), "");
    const size = cocos.view.getDesignResolutionSize();
    return {
      ...(state ? { state } : {}),
      ...(remainingTime !== undefined ? { remainingTime } : {}),
      ...(interceptionCount !== undefined ? { interceptionCount } : {}),
      labels,
      uiNodes,
      buttonCandidates,
      designSize: { width: size.width, height: size.height }
    };
  });
}

async function exerciseUntilTerminal(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const canvas = page.locator("canvas").first();
  while (Date.now() < deadline) {
    const snapshot = await captureRuntimeSnapshot(page);
    if (["GAME_OVER", "WIN"].includes(snapshot.state ?? "")) {
      return true;
    }
    const box = await canvas.boundingBox();
    if (box) {
      const y = box.y + box.height * 0.72;
      await page.mouse.move(box.x + box.width * 0.35, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.65, y, { steps: 5 });
      await page.mouse.up();
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForRuntimeState(page: Page, predicate: (state: string | undefined) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await captureRuntimeSnapshot(page);
    if (predicate(snapshot.state)) {
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function setRuntimeTimeScale(page: Page, value: number): Promise<void> {
  await page.evaluate((scale) => {
    const cocos = (globalThis as unknown as { cc?: { director?: { getScheduler?: () => { setTimeScale?: (value: number) => void } } } }).cc;
    cocos?.director?.getScheduler?.().setTimeScale?.(scale);
  }, value);
}

function inspectTerminalUi(
  operationId: string,
  snapshot: RuntimeSnapshot,
  initialSnapshot: RuntimeSnapshot | undefined,
  runRoot: string,
  checks: PlaytestCheckResult[],
  defects: PlaytestDefect[]
): void {
  const activeLabels = snapshot.labels.filter((label) => label.active && label.text.trim());
  const placeholderLabels = activeLabels.filter((label) => /\b(?:N|M)\b|(?:^|[：:\s])[_＿]+(?:$|\s)|\b(?:TODO|TBD)\b|\{[^}]+\}/i.test(label.text));
  const inconsistentStatistics = activeLabels.filter((label) => {
    const numbers = [...label.text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
    if (/拦截|得分|分数|score/i.test(label.text) && snapshot.interceptionCount !== undefined) {
      return numbers.length === 0 || numbers[0] !== snapshot.interceptionCount;
    }
    if (/存活|用时|耗时|秒|time/i.test(label.text) && snapshot.remainingTime !== undefined && initialSnapshot?.remainingTime !== undefined) {
      const elapsed = Math.max(0, Math.round(initialSnapshot.remainingTime - snapshot.remainingTime));
      return numbers.length === 0 || !numbers.some((value) => Math.abs(value - elapsed) <= 2);
    }
    return false;
  });
  const dynamicValueFailures = [...new Map([...placeholderLabels, ...inconsistentStatistics].map((label) => [label.path, label])).values()];
  addCheck(
    checks,
    "dynamic_values",
    "终局动态数字已真实渲染",
    dynamicValueFailures.length === 0 ? "passed" : "failed",
    dynamicValueFailures.length === 0
      ? "未发现模板占位符，且终局统计与运行时计数一致。"
      : `终局统计未物化或与运行时不一致：${dynamicValueFailures.map((label) => `${label.path}=${label.text}`).join("；")}`,
    defects,
    dynamicValueFailures.length === 0 ? undefined : defect({
      operationId,
      category: "dynamic_value",
      severity: "critical",
      title: "终局统计仍显示占位符",
      details: dynamicValueFailures.map((label) => `${label.path}: ${label.text}`).join("；"),
      ownerAgentId: "gameplay_programmer",
      evidencePaths: [`${runRoot}/03-terminal.png`]
    })
  );

  const activeUiNodes = snapshot.uiNodes.filter((node) => node.active);
  const activeTerminalPanels = activeUiNodes.filter((node) => /\/(?:GameOverPanel|WinPanel)$/.test(node.path));
  addCheck(
    checks,
    "terminal_panel_state",
    "终局只显示一个结果面板",
    activeTerminalPanels.length === 1 ? "passed" : "failed",
    activeTerminalPanels.length === 1
      ? `活动终局面板为 ${activeTerminalPanels[0]?.path}。`
      : `应有且仅有一个活动终局面板，实际为 ${activeTerminalPanels.map((node) => node.path).join("、") || "无"}。`,
    defects,
    activeTerminalPanels.length === 1 ? undefined : defect({
      operationId,
      category: "ui_layout",
      severity: "critical",
      title: "终局面板状态错误",
      details: `终局状态 ${snapshot.state ?? "unknown"} 下活动结果面板数量为 ${activeTerminalPanels.length}。`,
      ownerAgentId: "cocos_tech_lead",
      evidencePaths: [`${runRoot}/03-terminal.png`]
    })
  );

  const overflow = activeLabels.filter((label) => {
    if (!label.box || !label.parentBox) return false;
    const tolerance = 4;
    return label.box.x < label.parentBox.x - tolerance ||
      label.box.y < label.parentBox.y - tolerance ||
      label.box.x + label.box.width > label.parentBox.x + label.parentBox.width + tolerance ||
      label.box.y + label.box.height > label.parentBox.y + label.parentBox.height + tolerance;
  });
  addCheck(
    checks,
    "text_fit",
    "终局文字不溢出控件",
    overflow.length === 0 ? "passed" : "failed",
    overflow.length === 0 ? "活动终局文字均在组件宽度内。" : `疑似溢出：${overflow.map((label) => label.path).join("、")}`,
    defects,
    overflow.length === 0 ? undefined : defect({
      operationId,
      category: "ui_layout",
      severity: "major",
      title: "终局文字超出组件范围",
      details: overflow.map((label) => `${label.path} (${label.text})`).join("；"),
      ownerAgentId: "cocos_tech_lead",
      evidencePaths: [`${runRoot}/03-terminal.png`]
    })
  );

  const leakedStartHints = activeLabels.filter((label) =>
    !/GameOverPanel|WinPanel/.test(label.path) && /开始|点击.*(?:开始|游戏)|轻触.*(?:开始|游戏)/.test(label.text.trim())
  );
  const leakedStartNodes = activeUiNodes.filter((node) =>
    !/GameOverPanel|WinPanel/.test(node.path) && /\/(?:Start|StartButton|StartHint|TapToStart)(?:\/|$)/i.test(node.path)
  );
  const leakedStartDetails = [
    ...leakedStartHints.map((label) => `${label.path}=${label.text}`),
    ...leakedStartNodes.map((node) => node.path)
  ];
  addCheck(
    checks,
    "terminal_exclusivity",
    "终局界面不残留开始提示",
    leakedStartDetails.length === 0 ? "passed" : "failed",
    leakedStartDetails.length === 0 ? "终局状态没有同时显示开始提示或开始控件。" : `终局仍显示：${leakedStartDetails.join("；")}`,
    defects,
    leakedStartDetails.length === 0 ? undefined : defect({
      operationId,
      category: "ui_layout",
      severity: "major",
      title: "终局按钮与开始提示同时显示",
      details: leakedStartDetails.join("；"),
      ownerAgentId: "cocos_tech_lead",
      evidencePaths: [`${runRoot}/03-terminal.png`]
    })
  );

  const clippedNodes = activeUiNodes.filter((node) => {
    if (!node.box || node.box.width <= 0 || node.box.height <= 0) return false;
    const tolerance = 4;
    return node.box.x < -tolerance || node.box.y < -tolerance ||
      node.box.x + node.box.width > snapshot.designSize.width + tolerance ||
      node.box.y + node.box.height > snapshot.designSize.height + tolerance;
  });
  addCheck(
    checks,
    "viewport_fit",
    "活动 UI 位于设计视口内",
    clippedNodes.length === 0 ? "passed" : "failed",
    clippedNodes.length === 0 ? "未检测到活动 UI 超出设计分辨率。" : `超出视口：${clippedNodes.map((node) => node.path).join("、")}`,
    defects,
    clippedNodes.length === 0 ? undefined : defect({
      operationId,
      category: "ui_layout",
      severity: "major",
      title: "活动 UI 超出屏幕范围",
      details: clippedNodes.map((node) => node.path).join("；"),
      ownerAgentId: "cocos_tech_lead",
      evidencePaths: [`${runRoot}/03-terminal.png`]
    })
  );

  const overlaps: string[] = [];
  for (let leftIndex = 0; leftIndex < activeLabels.length; leftIndex += 1) {
    const left = activeLabels[leftIndex];
    if (!left?.box) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < activeLabels.length; rightIndex += 1) {
      const right = activeLabels[rightIndex];
      if (!right?.box || left.path.startsWith(`${right.path}/`) || right.path.startsWith(`${left.path}/`)) continue;
      const intersectionWidth = Math.max(0, Math.min(left.box.x + left.box.width, right.box.x + right.box.width) - Math.max(left.box.x, right.box.x));
      const intersectionHeight = Math.max(0, Math.min(left.box.y + left.box.height, right.box.y + right.box.height) - Math.max(left.box.y, right.box.y));
      const intersection = intersectionWidth * intersectionHeight;
      const minimumArea = Math.min(left.box.width * left.box.height, right.box.width * right.box.height);
      if (minimumArea > 0 && intersection / minimumArea >= 0.15) {
        overlaps.push(`${left.path} ↔ ${right.path}`);
      }
    }
  }
  addCheck(
    checks,
    "label_overlap",
    "终局文字与按钮无重叠",
    overlaps.length === 0 ? "passed" : "failed",
    overlaps.length === 0 ? "未检测到显著文字包围盒重叠。" : `检测到 ${overlaps.length} 组重叠：${overlaps.join("；")}`,
    defects,
    overlaps.length === 0 ? undefined : defect({
      operationId,
      category: "ui_layout",
      severity: "major",
      title: "终局 UI 组件相互遮挡",
      details: overlaps.join("；"),
      ownerAgentId: "cocos_tech_lead",
      evidencePaths: [`${runRoot}/03-terminal.png`]
    })
  );
}

function inspectHudRuntime(
  operationId: string,
  snapshot: RuntimeSnapshot,
  runRoot: string,
  checks: PlaytestCheckResult[],
  defects: PlaytestDefect[]
): void {
  const activeHudLabels = snapshot.labels.filter((label) =>
    label.active && label.text.trim() && !/GameOverPanel|WinPanel/.test(label.path)
  );
  const mismatches: string[] = [];
  if (snapshot.remainingTime !== undefined) {
    const timer = activeHudLabels.find((label) => /^\d{1,3}:\d{2}$/.test(label.text.trim()));
    if (!timer) {
      mismatches.push(`未找到与 remainingTime=${snapshot.remainingTime.toFixed(2)} 对应的活动计时标签`);
    } else {
      const [minutes = 0, seconds = 0] = timer.text.trim().split(":").map(Number);
      const renderedSeconds = minutes * 60 + seconds;
      if (Math.abs(renderedSeconds - Math.ceil(snapshot.remainingTime)) > 1) {
        mismatches.push(`${timer.path}=${timer.text}，运行时 remainingTime=${snapshot.remainingTime.toFixed(2)}`);
      }
    }
  }
  if (snapshot.interceptionCount !== undefined) {
    const counter = activeHudLabels.find((label) => /拦截|得分|分数|score/i.test(label.text));
    const numbers = counter ? [...counter.text.matchAll(/\d+/g)].map((match) => Number(match[0])) : [];
    if (!counter || !numbers.includes(snapshot.interceptionCount)) {
      mismatches.push(counter
        ? `${counter.path}=${counter.text}，运行时 interceptionCount=${snapshot.interceptionCount}`
        : `未找到与 interceptionCount=${snapshot.interceptionCount} 对应的活动计数标签`);
    }
  }
  addCheck(
    checks,
    "hud_runtime_values",
    "HUD 数字与运行时状态一致",
    mismatches.length === 0 ? "passed" : "failed",
    mismatches.length === 0 ? "计时和计数标签与 GameController 运行时值一致。" : mismatches.join("；"),
    defects,
    mismatches.length === 0 ? undefined : defect({
      operationId,
      category: "dynamic_value",
      severity: "critical",
      title: "HUD 显示与运行时状态不一致",
      details: mismatches.join("；"),
      ownerAgentId: "gameplay_programmer",
      evidencePaths: [`${runRoot}/03-terminal.png`, `${runRoot}/runtime-snapshots.json`]
    })
  );
}

function addCheck(
  checks: PlaytestCheckResult[],
  checkId: string,
  label: string,
  status: PlaytestCheckResult["status"],
  details: string,
  defects: PlaytestDefect[] = [],
  failure?: PlaytestDefect
): void {
  checks.push({ checkId, label, status, details });
  if (failure) defects.push(failure);
}

function defect(input: Omit<PlaytestDefect, "defectId"> & { operationId: string }): PlaytestDefect {
  const fingerprint = createHash("sha1").update(`${input.category}:${input.title}:${input.details}`).digest("hex").slice(0, 10);
  return {
    defectId: `bug_${input.operationId}_${fingerprint}`,
    severity: input.severity,
    category: input.category,
    title: input.title,
    details: input.details,
    ownerAgentId: input.ownerAgentId,
    evidencePaths: input.evidencePaths
  };
}

async function clickRuntimeBox(page: Page, box: { x: number; y: number; width: number; height: number }, design: { width: number; height: number }): Promise<void> {
  const canvas = page.locator("canvas").first();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("找不到 Cocos canvas 包围盒。");
  const x = canvasBox.x + ((box.x + box.width / 2) / design.width) * canvasBox.width;
  const y = canvasBox.y + (1 - (box.y + box.height / 2) / design.height) * canvasBox.height;
  await page.mouse.click(x, y);
}

async function captureScreenshot(page: Page, projectRoot: string, path: string): Promise<string> {
  ensureDirectoryInsideProject(projectRoot, dirname(path));
  const absolutePath = resolveInsideProject(projectRoot, path);
  await page.locator("canvas").first().screenshot({ path: absolutePath });
  return path;
}

function renderMarkdownReport(result: PlaytestReportEvidence): string {
  const checkRows = result.checks.map((check) => `| ${check.label} | ${check.status} | ${check.details.replaceAll("|", "\\|")} |`).join("\n");
  const defects = result.defects.length > 0
    ? result.defects.map((item) => `- **${item.severity} / ${item.category}** ${item.title}：${item.details}（责任角色：${item.ownerAgentId}）`).join("\n")
    : "- 无阻断性缺陷。";
  const evidence = result.evidencePaths.map((path) => `- \`${path}\``).join("\n") || "- 无";
  const contract = result.contract
    ? [
        "## PlaytestContract",
        "",
        `- 契约：\`${result.contract.playtestId}@${result.contract.revision}\``,
        `- 路径：\`${result.contract.path}\``,
        `- SHA-256：\`${result.contract.hash}\``,
        `- 运行时协议：\`${result.contract.runtimeProtocol}\``,
        `- 适配器：\`${result.contract.adapterMode}\``,
        `- hash 握手：${result.contract.hashVerified ? "已验证" : "未验证"}`,
        ""
      ]
    : [];
  const scenarios = result.scenarios
    ? [
        "## 契约场景",
        "",
        ...result.scenarios.map((scenario) =>
          `- **${scenario.passed ? "PASS" : "FAIL"}** \`${scenario.scenarioId}\`：${scenario.initialState} -> ${scenario.finalState}；${scenario.details}`
        ),
        ""
      ]
    : [];
  return [
    "# Cocos 首个可玩自动试玩报告",
    "",
    `- 运行 ID：\`${result.operationId}\``,
    `- 结论：**${result.verdict.toUpperCase()}**`,
    `- 完成时间：${result.completedAt}`,
    `- 状态路径：${[result.runtime.initialState, result.runtime.playingState, result.runtime.terminalState, result.runtime.restartedState].filter(Boolean).join(" -> ") || "未建立"}`,
    "",
    ...contract,
    ...scenarios,
    "## 硬性检查",
    "",
    "| 检查 | 状态 | 证据说明 |",
    "| --- | --- | --- |",
    checkRows,
    "",
    "## 缺陷",
    "",
    defects,
    "",
    "## 可复核证据",
    "",
    evidence,
    "",
    renderPlaytestMarker(result),
    ""
  ].join("\n");
}

function safeEvidenceName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "scenario";
}

async function startStaticServer(root: string): Promise<{ server: Server; url: string }> {
  const index = resolvePathWithinRoot(root, "index.html", {
    allowMissing: true,
    expectedKind: "file",
    label: "QA 静态文件"
  });
  if (!index.exists) {
    throw new Error(`QA Web 构建缺少 index.html：${root}`);
  }
  const server = createServer((request, response) => {
    let target: string;
    let targetExists = false;
    try {
      const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
      const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const safeTarget = resolvePathWithinRoot(root, requested, {
        allowMissing: true,
        expectedKind: "file",
        label: "QA 静态文件"
      });
      target = safeTarget.absolutePath;
      targetExists = safeTarget.exists;
    } catch {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!targetExists) {
      response.writeHead(404).end("Not Found");
      return;
    }
    response.setHeader("Content-Type", mimeType(target));
    createReadStream(target).pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得 QA 静态服务器端口。");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function discoverChromeExecutable(): string {
  const candidates = [
    process.env.BTP_PLAYTEST_CHROME?.trim(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    process.platform === "win32" ? join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe") : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter((path): path is string => Boolean(path));
  const executable = candidates.find((path) => existsSync(path) && statSync(path).isFile());
  if (!executable) {
    throw new Error("未发现可用于 Cocos 试玩的 Chrome/Chromium。可通过 BTP_PLAYTEST_CHROME 指定路径。");
  }
  return executable;
}

function writeTextEvidence(projectRoot: string, path: string, content: string): string {
  ensureDirectoryInsideProject(projectRoot, dirname(path));
  const absolutePath = resolveInsideProject(projectRoot, path);
  writeFileSync(absolutePath, content, "utf8");
  return path;
}

function writeJsonEvidence(projectRoot: string, path: string, value: unknown): string {
  return writeTextEvidence(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`);
}

function fileEvidence(projectRoot: string, path: string): CocosBridgeEvidence {
  const absolutePath = resolveInsideProject(projectRoot, path);
  const body = readFileSync(absolutePath);
  return { path, hash: createHash("sha256").update(body).digest("hex"), sizeBytes: body.byteLength };
}

function resolveInsideProject(projectRoot: string, path: string): string {
  const relativePath = normalizeRelativePathWithinRoot(path, { label: "试玩证据路径" });
  return resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    label: "试玩证据路径"
  }).absolutePath;
}

function ensureDirectoryInsideProject(projectRoot: string, path: string): string {
  const relativePath = path === "." ? "." : normalizeRelativePathWithinRoot(path, { label: "试玩证据目录" });
  let resolved = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: true,
    allowRoot: true,
    expectedKind: "directory",
    label: "试玩证据目录"
  });
  mkdirSync(resolved.absolutePath, { recursive: true });
  resolved = resolvePathWithinRoot(projectRoot, relativePath, {
    allowMissing: false,
    allowRoot: true,
    expectedKind: "directory",
    label: "试玩证据目录"
  });
  return resolved.absolutePath;
}

function mimeType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bin": "application/octet-stream"
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
