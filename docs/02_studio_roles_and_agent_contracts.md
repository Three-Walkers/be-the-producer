# 02. 工作室角色与 Agent 契约

## 1. 角色契约原则

每个 Agent 是产品角色，不是模型实例。角色包含职责、权限、工具、工作空间、记忆范围和交接规则。模型能力通过 Model Gateway 注入，Agent 本身不持有 API key。

角色契约包含：

- `agent_id`：稳定唯一标识。
- `display_name`：群聊展示名。
- `role_scope`：职责边界。
- `inputs`：可消费的信息和产物。
- `outputs`：必须生成的产物。
- `tools`：可调用工具。
- `workspace`：角色工作空间路径。
- `memory_scopes`：可读写记忆范围。
- `forbidden_actions`：禁止行为。
- `handoff_targets`：交接对象。

## 2. Agent 配置结构

```yaml
agent_id: game_designer
display_name: Game Designer Agent
room_memberships:
  - studio-main
  - design-room
model_profile:
  capability: reasoning
  cost_tier: standard
  max_context_policy: project_pack
workspace: agents/design/
memory_scopes:
  read:
    - project
    - decision
    - producer_preference
    - artifact
  write:
    - role
    - decision_draft
    - artifact
tools:
  - read_artifact
  - write_artifact
  - create_decision_request
  - create_task
  - update_task
forbidden_actions:
  - modify_server_secret
  - deploy_release
  - edit_cocos_scene_directly
```

## 3. 核心角色

| Agent | 职责 | 工作空间 |
| --- | --- | --- |
| Studio Orchestrator | 状态机、路由、任务拆解、阶段门禁、跨角色协调。 | `shared/milestones/` |
| Producer Agent | 范围、排期、风险、评审组织、制作人决策记录。 | `agents/producer/` |
| Game Designer Agent | 核心循环、机制、数值、关卡、GDD。 | `agents/design/` |
| Art Director Agent | Art Bible、视觉风格、资产规格、UI 视觉方向。 | `agents/art/` |
| Asset Production Agent | 资产生成、清洗、规格化、打包、manifest。 | `agents/art/processed-assets/` |
| Cocos Tech Lead Agent | Cocos 架构、模块边界、资源加载、性能预算。 | `agents/engineering/` |
| Gameplay Programmer Agent | TypeScript 玩法代码、UI 逻辑、系统实现。 | Cocos 工程源码目录 |
| Cocos Automation Agent | 通过引擎桥操作 Cocos，导入资产、建场景、构建。 | `agents/cocos-automation/` |
| Game Evaluator / QA Agent | 试玩、截图、录屏、Bug、发布门禁、Benchmark。 | `agents/qa/` |
| WeChat Platform Agent | 微信小游戏包体、分包、预览、上传准备、平台检查。 | `shared/build-artifacts/` |
| DevOps Agent | 服务器部署、日志、回滚、生产健康检查。 | `agents/devops/` |
| LiveOps / Analytics Agent | 埋点、数据分析、后续迭代 backlog。 | `shared/release-notes/` |

## 4. Studio Orchestrator

职责：

- 创建项目和房间。
- 维护三阶段状态机。
- 根据消息和任务上下文触发 Agent。
- 创建阶段门禁。
- 汇总角色进度。
- 阻止未审批的跨阶段推进。

输入：

- 制作人消息。
- Agent 产物。
- 任务状态。
- QA 和构建结果。

输出：

- 阶段状态。
- 任务图。
- 决策请求。
- 进度汇总。

禁止行为：

- 直接生成游戏内容。
- 替制作人做产品方向决策。
- 读取明文密钥。

## 5. Producer Agent

职责：

- 将制作人意图转为生产范围。
- 管理 backlog、风险、里程碑和评审计划。
- 组织阶段评审。
- 记录制作人决策。

输出：

- `backlog.md`
- `sprint-plan.md`
- `risk-log.md`
- `decision-log.md`
- 评审议程和阶段总结。

禁止行为：

- 绕过制作人审批扩大范围。
- 直接改玩法、代码或美术资产。

## 6. Game Designer Agent

基础来源：

- `Donchitos/Claude-Code-Game-Studios/.claude/agents/game-designer.md`

本系统适配：

- 面向微信小游戏和 Cocos。
- 以制作人决策为最终依据。
- 所有机制文档写入 `agents/design/gdd/`。
- 所有数值进入外部数据规格，不硬编码。

职责：

- 开局澄清。
- 核心循环设计。
- 机制规格。
- 关卡和成长设计。
- 数值和平衡规格。
- GDD baseline 和变更记录。

禁止行为：

- 不写工程代码。
- 不做最终美术方向决策。
- 不批准范围变更。

## 7. Art Director Agent

基础来源：

- `Donchitos/Claude-Code-Game-Studios/.claude/agents/art-director.md`

本系统适配：

- 面向 2D 微信小游戏资产。
- Art Bible 是视觉事实源。
- 美术产物必须进入资产清单和工作空间。

职责：

- 定义视觉风格。
- 维护 Art Bible。
- 定义资产规格和命名规范。
- 审阅 UI 可读性和视觉层级。
- 对美术资产给出 gate verdict。

禁止行为：

- 不写玩法代码。
- 不直接改 Cocos 场景。
- 不绕过 Asset Production 生成最终资产。

## 8. Asset Production Agent

职责：

- 调用图像、视频或 sprite 工具。
- 执行透明背景、切帧、对齐、压缩、命名、打包。
- 生成 `asset-manifest.json`。
- 保留 raw、processed 和 runtime 三类资产。

工具：

- `ai-game-art-pipeline-skill`
- `agent-sprite-forge`
- 图像生成适配器。
- 本地后处理脚本。

禁止行为：

- 不决定美术方向。
- 不使用未经批准的 IP 风格。
- 不把 provider API key 写入资产目录。

## 9. Engineering 角色

Cocos Tech Lead Agent 负责架构：

- Cocos 项目结构。
- SceneBlueprint。
- 资源加载。
- 模块边界。
- 性能预算。

Gameplay Programmer Agent 负责实现：

- TypeScript 组件。
- 游戏状态机。
- 输入和 UI 逻辑。
- 数据驱动玩法。
- 与 Cocos Automation 的集成。

Cocos Automation Agent 负责执行：

- 通过 Cocos Bridge 操作编辑器。
- 应用 SceneBlueprint。
- 导入资产。
- 生成构建。
- 保存操作日志。

## 10. QA、发布和运维角色

Game Evaluator / QA Agent：

- 运行试玩。
- 记录截图和录屏。
- 生成 Bug 报告。
- 执行 Cocos MiniGame Bench。
- 给出发布门禁结论。

WeChat Platform Agent：

- 检查微信小游戏构建配置。
- 检查包体和资源加载。
- 准备预览和上传材料。

DevOps Agent：

- 通过 Secret Vault 获取临时操作能力。
- 执行部署。
- 保存脱敏日志。
- 创建回滚方案。

LiveOps / Analytics Agent：

- 定义埋点。
- 分析上线反馈。
- 生成迭代 backlog。

## 11. 角色与模型解耦

Agent 不绑定固定模型。Agent 通过 `model_profile` 向 Model Gateway 申请能力：

| 能力 | 典型角色 |
| --- | --- |
| `reasoning` | Orchestrator, Producer, Designer |
| `coding` | Gameplay Programmer, Cocos Tech Lead |
| `vision` | QA, Art Director |
| `image_generation` | Asset Production |
| `video_generation` | Asset Production |
| `evaluation` | QA, LiveOps |

Model Gateway 根据权限、预算、可用性和任务类型选择模型。

## 12. Agent 响应制作人进度询问

Agent 响应条件：

- 被 @mention。
- 问题涉及自己的任务、产物、阻塞、阶段门禁。
- 当前房间是该 Agent 的主房间。
- Orchestrator 要求角色汇报。

回复内容结构：

```json
{
  "agent_id": "art_director",
  "message_type": "progress_update",
  "related_task_ids": ["task_123"],
  "summary": "Art Bible baseline 已完成，等待制作人确认色板。",
  "blockers": ["缺少参考图确认"],
  "artifacts": ["agents/art/art-bible.md"],
  "next_actions": ["根据确认结果生成资产规格"]
}
```
