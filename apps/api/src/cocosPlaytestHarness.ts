import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { CocosEngineBridge, type CocosBridgeEvidence } from "./cocosEngineBridge.js";
import type { CocosEngineConfig } from "./cocosEngineSettings.js";
import {
  renderPlaytestMarker,
  type PlaytestCheckResult,
  type PlaytestDefect,
  type PlaytestReportEvidence,
  type PlaytestVerdict
} from "./playtestEvidence.js";
import { writeQaPlaytestReceipt } from "./qaPlaytestReceipt.js";

export interface CocosPlaytestInput {
  previewUrl?: string;
  skipBuild?: boolean;
  maxDurationSec?: number;
  viewport?: { width: number; height: number };
  reportPath?: string;
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
    let browser: Browser | undefined;
    let staticServer: Server | undefined;
    let buildOperationId: string | undefined;
    let initial: RuntimeSnapshot | undefined;
    let playing: RuntimeSnapshot | undefined;
    let terminal: RuntimeSnapshot | undefined;
    let restarted: RuntimeSnapshot | undefined;

    try {
      let previewUrl = input.previewUrl?.trim();
      if (!input.skipBuild) {
        const outputDir = `shared/build-artifacts/playtest/${operationId}`;
        const build = new CocosEngineBridge(this.projectRoot, this.config).build({
          platform: "web-desktop",
          debug: true,
          outputDir
        });
        buildOperationId = build.operationId;
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

      browser = await chromium.launch({
        headless: true,
        executablePath: discoverChromeExecutable()
      });
      const page = await browser.newPage({ viewport: input.viewport ?? defaultViewport });
      page.on("console", (message) => {
        consoleLines.push(`[${message.type()}] ${message.text()}`);
      });
      page.on("pageerror", (error) => {
        consoleLines.push(`[pageerror] ${error.message}`);
      });

      await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(() => {
        const cocos = (globalThis as unknown as { cc?: { director?: { getScene?: () => unknown } } }).cc;
        return Boolean(cocos?.director?.getScene?.());
      }, undefined, { timeout: 30_000 });
      await page.waitForTimeout(1_000);

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

      const evidence = [reportPath, ...evidencePaths].map((path) => fileEvidence(this.projectRoot, path));
      const result: CocosPlaytestResult = {
        ...machineResult,
        ok: true,
        summary: verdict === "pass" ? "真实 Cocos 试玩通过全部硬性检查。" : `真实 Cocos 试玩未通过，发现 ${defects.length} 个缺陷。`,
        reportPath,
        evidence
      };
      writeQaPlaytestReceipt(this.projectRoot, reportPath, machineResult, evidence);
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const details = error instanceof Error ? error.message : String(error);
      const blockedDefect = defect({
        operationId,
        category: "runtime",
        severity: "blocker",
        title: "试玩基础设施无法执行",
        details,
        ownerAgentId: "cocos_automation",
        evidencePaths: []
      });
      defects.push(blockedDefect);
      checks.push({ checkId: "playtest_infrastructure", label: "试玩基础设施可用", status: "blocked", details });
      const machineResult: PlaytestReportEvidence = {
        operationId,
        verdict: "blocked",
        completedAt,
        ...(buildOperationId ? { buildOperationId } : {}),
        checks,
        defects,
        evidencePaths,
        runtime: { consoleErrorCount: 0, durationMs: Date.now() - startedAt }
      };
      writeTextEvidence(this.projectRoot, reportPath, renderMarkdownReport(machineResult));
      const evidence = [fileEvidence(this.projectRoot, reportPath)];
      const result: CocosPlaytestResult = {
        ...machineResult,
        ok: false,
        summary: `Cocos 试玩未能执行：${details}`,
        reportPath,
        evidence
      };
      writeQaPlaytestReceipt(this.projectRoot, reportPath, machineResult, evidence);
      return result;
    } finally {
      await browser?.close().catch(() => undefined);
      if (staticServer) {
        await new Promise<void>((resolveClose) => staticServer?.close(() => resolveClose()));
      }
    }
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
  const absolutePath = resolveInsideProject(projectRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  await page.locator("canvas").first().screenshot({ path: absolutePath });
  return path;
}

function renderMarkdownReport(result: PlaytestReportEvidence): string {
  const checkRows = result.checks.map((check) => `| ${check.label} | ${check.status} | ${check.details.replaceAll("|", "\\|")} |`).join("\n");
  const defects = result.defects.length > 0
    ? result.defects.map((item) => `- **${item.severity} / ${item.category}** ${item.title}：${item.details}（责任角色：${item.ownerAgentId}）`).join("\n")
    : "- 无阻断性缺陷。";
  const evidence = result.evidencePaths.map((path) => `- \`${path}\``).join("\n") || "- 无";
  return [
    "# Cocos 首个可玩自动试玩报告",
    "",
    `- 运行 ID：\`${result.operationId}\``,
    `- 结论：**${result.verdict.toUpperCase()}**`,
    `- 完成时间：${result.completedAt}`,
    `- 状态路径：${[result.runtime.initialState, result.runtime.playingState, result.runtime.terminalState, result.runtime.restartedState].filter(Boolean).join(" -> ") || "未建立"}`,
    "",
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

async function startStaticServer(root: string): Promise<{ server: Server; url: string }> {
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`QA Web 构建缺少 index.html：${root}`);
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const requested = pathname === "/" ? "/index.html" : pathname;
    const target = resolve(root, `.${normalize(requested)}`);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
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
  const absolutePath = resolveInsideProject(projectRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
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
  const root = resolve(projectRoot);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`试玩证据路径越界：${path}`);
  }
  return target;
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
