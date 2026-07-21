# 12. QA 评估与 Cocos MiniGame Bench

## 1. QA 定位

QA Agent 代表游戏作品评估流程，不只是跑单元测试。它评估构建能否运行、玩法是否符合 GDD、视觉是否可读、资产是否符合 Art Bible、微信小游戏是否具备发布准备条件。

## 2. Cocos MiniGame Bench

Cocos MiniGame Bench 是内部评估基准，覆盖：

- 工件完整性。
- Cocos 构建健康度。
- 运行时可玩性。
- 玩法正确性。
- 视觉可用性。
- 美术一致性。
- 制作人意图对齐。
- 微信小游戏就绪性。
- 性能。
- 安全和运维。

## 3. 评分结构

```json
{
  "bench_id": "bench_...",
  "build_id": "build_...",
  "scores": {
    "artifact_completeness": 0.95,
    "build_health": 1.0,
    "runtime_playability": 0.9,
    "gameplay_correctness": 0.85,
    "visual_usability": 0.8,
    "art_consistency": 0.88,
    "intent_alignment": 0.9,
    "wechat_readiness": 0.86,
    "performance": 0.78,
    "security_ops": 0.92
  },
  "verdict": "pass_with_minor_issues"
}
```

## 4. 评估维度

| 维度 | 检查内容 | 证据 |
| --- | --- | --- |
| Artifact Completeness | GDD、Art Bible、资产清单、构建、报告是否齐全。 | Artifact Registry |
| Build Health | Cocos 构建是否成功，日志是否无 critical error。 | Build logs |
| Runtime Playability | 能否启动、开始、游玩、失败、重开。 | 试玩脚本、录屏 |
| Gameplay Correctness | 玩法和 GDD 是否一致。 | GDD 对照表 |
| Visual Usability | 画面可读、按钮可点、反馈清楚。 | 截图、视觉检查 |
| Art Consistency | 资产符合 Art Bible。 | asset_review |
| Intent Alignment | 成品符合制作人意图和决策。 | Decision Memory |
| WeChat Readiness | 包体、加载、适配、权限符合平台要求。 | package report |
| Performance | FPS、内存、加载时间、卡顿。 | performance log |
| Security and Ops | 密钥、日志、回滚、部署记录安全。 | audit log |

## 5. QA 工作区

```text
agents/qa/
  workspace-summary.md
  test-plans/
  playtest-reports/
  screenshots/
  recordings/
  bug-reports/
  release-gate-reports/
```

## 6. 测试计划

测试计划结构：

```markdown
# QA Test Plan

## Build Under Test
## Source GDD
## Source Art Bible
## Smoke Tests
## Gameplay Tests
## Visual Tests
## WeChat Platform Tests
## Performance Tests
## Security / Ops Tests
## Exit Criteria
```

## 7. 自动试玩

QA 结论必须来自服务端 `run_playtest` 工具，不能由模型阅读代码后推断，也不能由模型手写报告冒充执行结果。工具负责构建 Cocos Web 版本、启动本地静态服务器、使用 Chrome 驱动真实画布，并将运行状态、截图、控制台日志和机器可读结论登记到 Artifact Ledger。

自动试玩步骤：

1. 使用 Cocos Creator CLI 构建独立的 `web-desktop` QA 包。
2. 启动一次性本地静态服务器和无头 Chrome。
3. 等待 Cocos 场景加载并捕获初始状态截图。
4. 在真实 canvas 上执行点击或触摸输入，确认 `IDLE -> PLAYING`。
5. 加速调度器并持续执行玩家输入，直到进入 `GAME_OVER` 或 `WIN`。
6. 校验终局动态数字与运行时计数一致，不允许 `N`、`M`、`_`、`TODO` 等占位内容。
7. 校验终局结果面板唯一、开始提示退出、文字不溢出、组件不遮挡、活动 UI 不越出设计视口。
8. 校验“再来一次”具有真实 Cocos `Button` 组件，并点击确认回到 `IDLE` 或 `PLAYING`。
9. 保存初始、运行、终局、重开截图，运行时快照、控制台日志、机器结果和 Markdown 报告。

首个可玩硬性检查集：

```text
launch
start_flow
terminal_flow
hud_runtime_values
dynamic_values
text_fit
terminal_panel_state
terminal_exclusivity
label_overlap
viewport_fit
restart_control
restart_flow
console_errors
```

任一检查缺失或未通过，试玩结论都不能成为 `pass`。

试玩结果：

```json
{
  "playtest_id": "playtest_...",
  "build_id": "build_...",
  "steps": [
    {
      "action": "tap",
      "target": "enemy_001",
      "expected": "enemy_hp_decreases",
      "actual": "enemy_hp_decreases",
      "status": "passed"
    }
  ],
  "screenshots": ["agents/qa/screenshots/playtest_001_start.png"],
  "recording": "agents/qa/recordings/playtest_001.mp4"
}
```

## 8. Bug 报告

```json
{
  "bug_id": "bug_...",
  "project_id": "game_...",
  "build_id": "build_...",
  "severity": "major",
  "title": "失败后无法重新开始",
  "steps_to_reproduce": [
    "启动游戏",
    "等待生命值归零",
    "点击重新开始"
  ],
  "expected": "游戏状态重置并开始新局",
  "actual": "按钮无响应",
  "evidence": [
    "agents/qa/recordings/restart_bug.mp4"
  ],
  "assigned_agent_id": "gameplay_programmer",
  "status": "open"
}
```

## 9. 发布门禁

发布门禁结论：

```text
pass
pass_with_minor_issues
blocked
waived_by_producer
```

blocked 条件：

- 无法启动。
- 核心循环不可玩。
- 关键玩法和 GDD 不一致。
- 存在 critical 崩溃。
- 包体或平台检查不通过。
- 明文 secret 出现在日志或构建中。

任务状态和阶段状态不能由 QA Agent 的自然语言声明驱动。QA 任务进入 `review`、首个可玩门禁通过、发布门禁通过均要求：

- 主报告存在 `BTP_PLAYTEST_RESULT` 机器标记。
- 报告 provenance 为服务端 `run_playtest`，模型使用 `write_artifact` 伪造同名报告无效。
- verdict 为 `pass`。
- blocker、critical、major 缺陷数为零。
- 所有硬性检查为 `passed`。
- 每个截图、日志和快照均存在，并在 Artifact Ledger 中具有 hash、size 和工具操作证据。

## 10. QA 与其他 Agent 的交接

| 问题类型 | 交接对象 |
| --- | --- |
| 玩法错误 | Gameplay Programmer |
| GDD 不清晰 | Game Designer |
| 美术可读性问题 | Art Director |
| 资产格式问题 | Asset Production |
| 场景或构建问题 | Cocos Automation |
| 微信平台问题 | WeChat Platform |
| 部署和日志问题 | DevOps |

## 11. 失败回流与回归测试

真实试玩失败后，调度器按缺陷责任自动创建修复任务：

| 缺陷类别 | 默认责任角色 |
| --- | --- |
| 玩法状态、动态数字、重开逻辑 | Gameplay Programmer |
| Cocos 场景、组件绑定、UI 层级 | Cocos Tech Lead |
| 视觉可读性和美术规范 | Art Director |
| 构建、浏览器或运行环境 | Cocos Automation |

回流规则：

- 无论 `run_playtest` 由 Agent Loop、Claude CLI Harness、Cocos Bridge API 还是人工触发，Harness 都必须在 `.be-the-producer/qa-playtest-receipts/` 写入受保护执行收据。
- 服务端在项目检查点和重启恢复时验证报告标记、operation ID、文件 hash 与 size；未通过验证的收据不会进入 Artifact Ledger，也不会驱动任务状态。
- `agents/qa/playtest-reports/` 与 `agents/qa/playtest-runs/` 是 Harness 托管目录，只允许 `run_playtest` 写入；模型的 `write_artifact`、`append_document` 或 CLI 文件写入均不能覆盖机器证据。
- 当前阶段的 QA 任务即使已经显示 `review/done`，只要有效收据缺失或当前文件 hash 与 Ledger 不一致，服务端就会撤销评审状态并强制重新试玩。
- 每个 operation ID 只允许摄取一次。重复检查点或服务重启不得重复创建修复任务、重复发消息或累计同一缺陷。
- QA 任务立即进入 `blocked`，并绑定失败 playtest operation ID。
- 每个 blocker、critical、major 缺陷生成独立修复任务和证据引用。
- QA 房间显示结构化失败通知；程序房间或美术房间显示带 `@责任角色`、修复任务 ID、缺陷证据路径的交接消息。
- 修复 Agent 必须通过工具修改 `assets/`、`settings/` 或对应工程文件；只写一份“已修复”说明不能关闭任务。
- 所有修复任务的真实工程变更通过 Artifact Ledger 验证后，QA 才重新排队。
- QA 必须重新构建并重复完整状态链，不能复用上一次截图或报告。
- 新一轮 verdict 仍为 `fail` 时继续回流；只有 `pass` 才允许进入评审或阶段门禁。

当 Bug 修复后：

- QA 重新执行复现步骤。
- 更新 bug 状态。
- 保存修复后截图或录屏。
- 写入 QA Memory。
- 更新 release gate。

## 12. QA 报告结构

```markdown
# Playtest Report

## Build
## Summary
## Bench Scores
## Passed Checks
## Failed Checks
## Bugs
## Screenshots
## Recordings
## Release Gate Verdict
## Required Fixes
## Producer Decision Needed
```

## 13. Benchmark 参考来源

内部 benchmark 吸收以下方向：

- OpenGame 的动态运行和可玩性验证。
- PlayCoder 的试玩反馈闭环。
- GameCraft-Bench 的完整工件和多模态评估思路。
- GameDevBench 的游戏开发任务评估维度。

这些参考不直接作为发布门禁，发布门禁以 Cocos MiniGame Bench 为准。
