# 08. 策划 Agent 与 GDD 流水线

## 1. Agent 基础

策划 Agent 以 `Claude-Code-Game-Studios/game-designer` 为基础。该 Agent 已具备核心循环、系统设计、数值平衡、MDA、Self-Determination Theory、Flow、GDD 章节标准和“制作人决策优先”的协作协议。

本系统对其进行以下适配：

- 平台固定为微信小游戏。
- 引擎固定为 Cocos Creator。
- 产物写入 `agents/design/`。
- 设计变更进入 Decision Memory。
- 所有数值设计必须可外部配置。
- 不直接写工程代码。

## 2. GDD 产物结构

```text
agents/design/
  workspace-summary.md
  gdd/
    00_overview.md
    01_core_loop.md
    02_mechanics.md
    03_progression.md
    04_levels.md
    05_balance.md
    06_ui_flow.md
    07_content_scope.md
    08_acceptance_criteria.md
  core-loop.md
  level-specs/
  balance-specs/
  change-requests/
```

## 3. 开局澄清

策划 Agent 在 Stage 1 主导澄清：

| 问题 | 目的 |
| --- | --- |
| 玩家 30 秒内做什么？ | 定义 moment-to-moment loop。 |
| 单局多长？ | 定义微信小游戏节奏。 |
| 玩家为什么再来一局？ | 定义 session hook。 |
| 失败条件是什么？ | 定义风险和张力。 |
| 奖励是什么？ | 定义反馈和成长。 |
| 目标情绪是什么？ | 定义 MDA 中的 Aesthetics。 |
| 哪些元素不能出现？ | 记录制作人禁区。 |

澄清问题必须和美术 Agent 的视觉澄清共享上下文，避免玩法和视觉方向冲突。

## 4. 核心循环规格

核心循环文档必须包含：

```markdown
# Core Loop

## Player Fantasy
## 30-Second Micro Loop
## Session Loop
## Progression Loop
## Win Condition
## Fail Condition
## Feedback
## Tuning Knobs
## Acceptance Criteria
```

示例字段：

```json
{
  "micro_loop": "观察敌人路线 -> 点击防守点 -> 获得即时反馈 -> 分数增长",
  "session_loop": "60 秒内尽量阻止敌人通过，结算分数和奖励",
  "win_condition": "时间结束且生命值大于 0",
  "fail_condition": "生命值降为 0",
  "tuning_knobs": ["enemy_spawn_rate", "enemy_speed", "tap_damage", "life_count"]
}
```

## 5. 机制规格

每个机制文档必须包含 8 个部分：

1. Overview。
2. Player Fantasy。
3. Detailed Rules。
4. Formulas。
5. Edge Cases。
6. Dependencies。
7. Tuning Knobs。
8. Acceptance Criteria。

机制文档示例：

```markdown
# Mechanic: Enemy Spawn

## Overview
敌人按波次从入口生成，沿固定路径移动。

## Detailed Rules
- 每波包含 N 个敌人。
- 敌人间隔由 `spawn_interval_ms` 控制。
- 生命值归零时敌人消失并加分。

## Formulas
enemy_hp = base_hp + wave_index * hp_growth

## Tuning Knobs
- base_hp
- hp_growth
- spawn_interval_ms
- enemy_speed
```

## 6. 数值和平衡

数值规格写入：

```text
agents/design/balance-specs/
  enemy_balance.md
  score_balance.md
  progression_curve.md
```

规则：

- 数值是 hypothesis，直到 QA playtest 验证。
- 所有数值必须有合理范围。
- 所有数值必须能映射到外部配置，例如 JSON。
- 不允许写“感觉差不多”作为默认依据。

示例：

```json
{
  "enemy_speed": {
    "default": 120,
    "min": 80,
    "max": 180,
    "unit": "px_per_second",
    "category": "feel",
    "rationale": "保证移动端点击反应时间大于 500ms。"
  }
}
```

## 7. 世界观和玩家幻想

微信小游戏可轻量叙事，但必须有统一语气：

- 题材。
- 角色身份。
- 场景语气。
- UI 文案风格。
- 奖励命名。
- 失败反馈。

世界观文档和 Art Bible 互相引用。策划定义“玩家为什么在做这件事”，美术定义“这件事看起来像什么”。

## 8. 关卡与内容范围

关卡规格：

```json
{
  "level_id": "level_001",
  "duration_seconds": 60,
  "enemy_waves": 5,
  "difficulty": "easy",
  "target_score": 800,
  "new_mechanics": ["basic_enemy"],
  "art_requirements": ["forest_path_background", "basic_enemy_sprite"]
}
```

内容范围必须控制第一可玩目标，避免 Stage 1 过度膨胀。

## 9. GDD 到任务拆解

GDD approved 后，Orchestrator 生成任务：

- 美术资产规格任务。
- Cocos 场景蓝图任务。
- 玩法代码任务。
- QA 测试计划任务。
- 微信构建准备任务。

任务关联到 GDD artifact：

```json
{
  "source_artifact": "agents/design/gdd/01_core_loop.md",
  "generated_tasks": [
    "task_art_asset_spec",
    "task_core_loop_code",
    "task_qa_core_loop"
  ]
}
```

## 10. 变更处理

制作人修改玩法时：

- 原 GDD section 不直接覆盖。
- 新增 change request。
- 被替换内容标记 `superseded`。
- 相关代码、资产、QA 任务重新评估。
- QA 回归范围自动更新。

## 11. 策划 Agent 禁止行为

- 不写 TypeScript 实现。
- 不直接生成最终美术资产。
- 不选择模型 API key。
- 不绕过制作人审批。
- 不改服务器和部署配置。

## 12. 验收标准

策划产物合格标准：

- GDD 可被程序和美术执行。
- 核心循环有明确胜负条件。
- 每个机制有输入、输出、边界、调参项。
- 数值有范围和依据。
- 所有关键方向有制作人决策记录。
- QA 可根据 GDD 写测试计划。
