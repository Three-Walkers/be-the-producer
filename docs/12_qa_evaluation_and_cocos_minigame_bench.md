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

自动试玩步骤：

1. 启动构建。
2. 捕获首屏截图。
3. 模拟点击或触摸输入。
4. 验证核心循环状态变化。
5. 验证分数、生命、胜负条件。
6. 录制关键片段。
7. 保存控制台日志。

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

## 11. 回归测试

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
