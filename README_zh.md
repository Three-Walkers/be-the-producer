# Be The Producer

[English](./README.md) | **简体中文**

Be The Producer 的愿景是简化游戏制作过程，让每一个有游戏点子的人都可以成为游戏制作人。这个点子可以未经验证，可以不完整，也可以只是一个模糊的方向。

产品把早期想法转化为透明的游戏生产流程。制作人不需要一开始就拥有完整策划案、完整开发团队或专业游戏制作经验。制作人提供最初的灵感，在关键节点审视作品、做出产品决策，并像真实项目制作人一样引导 AI 游戏工作室把点子推进成可玩的游戏。

Be The Producer 是一个面向“AI 虚拟游戏工作室”的正式产品系统和实现工作区。它的目标是：用户只需要输入一个游戏 idea/ideal，并提供受控的服务器访问权限，系统就能组织策划、美术、程序、测试、发布、运维等多个角色 Agent，端到端交付一个产品级微信小游戏，并支持持续迭代。

初始产品范围聚焦轻量级微信小游戏，游戏引擎使用 Cocos Creator，不覆盖大型游戏、PC 游戏或主机游戏。

## 产品目标

最终用户体验如下：

1. 制作人输入一个游戏 idea，即使这个想法一开始还比较模糊也可以。
2. 系统打开一个多 Agent 游戏工作室群聊空间，由策划和美术先参与开局讨论，帮助制作人把想法澄清成可执行方案。
3. 各个 Agent 生成并维护游戏设计、美术规范、任务计划、源码、资产、测试报告、构建记录、部署记录和迭代计划。
4. 在关键节点，制作人审视游戏作品并给出意见。
5. 各个游戏开发 Agent 根据制作人的意见调整玩法、资产、代码、测试和发布计划。
6. 系统最终交付一个可玩的微信小游戏，并保留后续持续运营和版本迭代能力。

制作人不是一个只在开头输入需求、最后等待结果的旁观者。制作人像真实游戏项目里的制作人一样，拥有随时询问进度、审批节点、否决方案、提出修改意见的权限，并且这些意见会进入项目记录和任务流。

## 核心原则

游戏开发过程必须是可见、可追溯、角色职责清晰的。

这个系统不是一个黑盒聊天机器人，也不是一次性生成一堆代码的工具。它以小型游戏工作室的方式运行：每个角色都有明确职责、独立工作空间、标准产物和责任留痕。

## 输入与输出

### 输入

- 制作人提供的游戏 idea/ideal。
- 可选参考信息，例如品类、题材、美术风格、对标游戏、目标玩家、商业化假设、平台约束。
- 服务器或云服务访问权限，必须通过受控密钥机制保存。
- 制作人在各个里程碑节点给出的审阅意见。

### 输出

- 游戏设计文档 GDD。
- 版本化 GameContract、SceneBlueprint 和 PlaytestContract。
- 美术风格文档 Art Bible 和资产生产计划。
- 可运行的 2D 资产、UI 资产、动画、音效引用和资产清单。
- Cocos Creator 工程。
- TypeScript 玩法实现。
- 微信小游戏构建产物。
- QA 试玩报告、问题报告、截图、录屏和发布门禁报告。
- 部署方案、部署记录、回滚方案和后续 LiveOps 迭代 backlog。
- 结构化生产记忆，覆盖项目状态、制作人决策、角色进度、产物、QA 结果、发布记录和可复用游戏开发知识。

## 多 Agent 游戏工作室模型

产品采用角色化多 Agent 工作室模型。每个 Agent 都拥有清晰的职责边界。

| Agent | 主要职责 | 典型产物 |
| --- | --- | --- |
| Studio Orchestrator | 控制工作流状态、消息路由、任务拆解、阶段门禁和跨 Agent 协作。 | 阶段计划、任务图、决策请求、项目状态。 |
| Producer Agent | 把制作人的意图转化为范围、排期、风险和里程碑评审。 | 生产计划、backlog、风险日志、评审议程、决策日志。 |
| Game Designer Agent | 设计核心循环、规则、成长、关卡、数值和平衡。 | GDD、GameContract、关卡规格、数值规格。 |
| Design Quality Reviewer | 按服务端固定的移动游戏设计 rubric 独立审查 GDD 与 GameContract。 | 绑定版本/hash 的策划质量收据和可执行修改要求。 |
| Art Director Agent | 定义美术风格、UI 方向、可读性规则、色板、动画语气和资产质量标准。 | Art Bible、真实位图方向板、UI 视觉规范。 |
| Asset Production Agent | 生产、清洗、规格化、打包和版本化游戏资产。 | 精灵图、UI 资产、sprite sheet、动画序列、asset manifest。 |
| Visual Quality Reviewer | 独立读取真实图片像素，审查视觉方向、可读性、技术质量和 IP 风险。 | 绑定版本/hash 的视觉质量收据和像素证据。 |
| Cocos Tech Lead Agent | 负责 Cocos 架构、场景结构、Prefab 策略、资源加载、性能预算和技术规范。 | 技术方案、SceneBlueprint、模块计划、性能检查清单。 |
| Gameplay Programmer Agent | 实现游戏系统、UI 逻辑、玩法规则、数据加载和集成代码。 | TypeScript 代码、Cocos 组件、实现说明、代码变更日志。 |
| Cocos Automation Agent | 通过引擎桥或 MCP 工具操作 Cocos。 | 场景操作记录、Prefab 更新记录、资源导入记录、构建日志、编辑器快照。 |
| Game Evaluator / QA Agent | 负责游戏作品评估，不只是执行单元测试。 | PlaytestContract、试玩证据、Bug 报告、发布门禁评估。 |
| WeChat Platform Agent | 负责微信小游戏打包、平台约束、预览、上传和平台适配。 | 微信构建配置、预览包、上传报告、包体体积报告。 |
| DevOps Agent | 负责服务器部署、环境配置、日志、回滚和生产就绪性。 | 部署方案、发布记录、回滚方案、服务器健康报告。 |
| LiveOps / Analytics Agent | 负责上线后的数据观察和持续迭代计划。 | 埋点方案、事件结构、迭代 backlog、调优方案。 |

## Human-in-the-Loop 制作流程

制作人必须参与关键节点。系统显式请求制作人决策，不默默替制作人做影响产品方向的决定。

需要制作人参与的典型节点：

- 游戏概念确认。
- 核心玩法和范围审批。
- 美术方向审批。
- 首个可玩版本审阅。
- 内容和难度审阅。
- QA 发布门禁审阅。
- 生产环境部署审批。
- 上线后迭代优先级审阅。

制作人的意见是项目的一等数据。每一个被接受或拒绝的决策都保存时间、发起人、影响产物和后续任务。

## 游戏工作室群聊空间

协作空间是一个游戏工作室群聊，并且具备按角色自动路由的能力。

房间结构：

| 房间 | 用途 |
| --- | --- |
| `#studio-main` | 制作人主房间、里程碑状态、决策请求和跨角色总结。 |
| `#design-room` | 玩法规则、GDD、关卡、成长、数值和平衡讨论。 |
| `#art-room` | 美术方向、资产清单、生产进度和资产评审。 |
| `#engineering-room` | Cocos 架构、玩法代码、场景集成和构建问题。 |
| `#qa-room` | 试玩、Bug、复现步骤、录屏、截图和发布门禁。 |
| `#release-room` | 微信构建、服务器部署、回滚、日志和生产就绪性。 |

当制作人在某个房间提问时，每个 Agent 自动判断这个问题是否与自己的职责相关。相关 Agent 必须回复；无关 Agent 默认保持静默，除非 Orchestrator 要求汇总。

### 消息类型

消息具有结构化类型，方便系统做路由、索引、审计和可视化。

- `plan_submission`：方案提交。
- `decision_request`：请求制作人决策。
- `decision_record`：决策记录。
- `progress_update`：进度更新。
- `deliverable`：产物提交。
- `review`：评审意见。
- `change_request`：变更请求。
- `asset_review`：资产评审。
- `bug_report`：Bug 报告。
- `qa_failure`：测试失败。
- `playtest_summary`：试玩总结。
- `build_failure`：构建失败。
- `release_gate`：发布门禁。
- `deployment_record`：部署记录。
- `blocker`：阻塞问题。
- `handoff`：角色间交接。

## 三阶段游戏生产流水线

```mermaid
flowchart LR
    A["阶段 1：立项、机制和世界观讨论"] --> B["制作人评审门禁"]
    B --> C["阶段 2：开发落地和可玩版本实现"]
    C --> D["首个可玩版本 / QA 门禁"]
    D --> E["阶段 3：上线、运维和持续迭代"]
    E --> F["LiveOps 反馈循环"]
    F --> C
```

### 阶段 1：立项、机制和世界观讨论

这个阶段解决制作人 idea 一开始不清晰的问题。制作人可以只给一个模糊方向，系统需要通过对话把方向变成可执行的游戏方案。

主要参与角色：

- Game Designer Agent。
- Design Quality Reviewer。
- Producer Agent。
- Art Director Agent。
- Visual Quality Reviewer。
- Studio Orchestrator。

主要任务：

- 澄清目标平台和单局时长。
- 定义品类、核心循环、胜利条件和失败条件。
- 定义玩家幻想、题材、世界观和整体语气。
- 创建初版 GDD。
- 创建 GameContract、Art Bible 和真实位图方向板。
- 按固定 rubric 执行独立策划与视觉审查。
- 定义首个可玩版本范围。
- 在进入开发前请求制作人审批。

退出标准：

- 核心循环已审批。
- 项目范围已审批。
- GDD 与 GameContract 具有当前且通过的策划质量收据。
- Art Bible 与方向板具有当前且通过的视觉质量收据。
- 初始 backlog 和里程碑计划已生成。

### 阶段 2：开发落地和可玩版本实现

这个阶段把审批后的方案变成可玩的 Cocos 微信小游戏。美术先启动，程序和 QA 同步穿插进行。

主要参与角色：

- Art Director Agent。
- Asset Production Agent。
- Visual Quality Reviewer。
- Cocos Tech Lead Agent。
- Gameplay Programmer Agent。
- Cocos Automation Agent。
- Game Evaluator / QA Agent。
- Producer Agent。

主要任务：

- 通过受控图片模型生产真实位图运行资产。
- 使用视觉模型检查联系表和 manifest 中每一个 runtime PNG。
- 将资产导入 Cocos。
- 实现玩法逻辑和 UI。
- 通过受控 Cocos 引擎桥创建场景和 Prefab。
- 执行自动化冒烟检查。
- 执行试玩评估。
- 修复玩法、视觉和集成问题。
- 准备首个可玩版本给制作人审阅。

退出标准：

- 核心循环可玩。
- 没有关键运行时错误。
- 美术资产已集成、可追溯，并由当前通过的视觉质量收据覆盖。
- QA 报告已完成。
- 制作人接受首个可玩版本，或提交明确变更请求。

### 阶段 3：上线、运维和持续迭代

这个阶段负责生产环境交付，并为后续优化保留持续迭代能力。

主要参与角色：

- Producer Agent。
- Game Designer Agent。
- Gameplay Programmer Agent。
- Game Evaluator / QA Agent。
- WeChat Platform Agent。
- DevOps Agent。
- LiveOps / Analytics Agent。

主要任务：

- 构建微信小游戏包。
- 检查包体、加载方式、资源策略等微信平台约束。
- 在需要时部署后端或静态资源。
- 保存发布说明和回滚方案。
- 执行生产就绪门禁。
- 发布或准备上传包。
- 上线后收集数据和反馈。
- 将反馈转化为后续版本迭代 backlog。

退出标准：

- 发布构建产物已生成。
- 部署记录已完成。
- 回滚方案存在。
- 发布门禁报告通过，或由制作人显式豁免。
- LiveOps 迭代 backlog 已生成。

## 角色工作空间

每个 Agent 都有自己的工作空间。这样制作人和维护者可以白盒地观察完整游戏开发过程。

项目目录：

```text
/studio/projects/{game_id}/
  shared/
    memory/
      project-memory.jsonl
      producer-preferences.md
      knowledge-base/
      vector-index-metadata.json
    decisions/
    milestones/
    workflow/
      workflow.json
      events.json
    build-artifacts/
    release-notes/

  agents/
    producer/
      workspace-summary.md
      backlog.md
      sprint-plan.md
      risk-log.md
      decision-log.md

    design/
      workspace-summary.md
      gdd/
      core-loop.md
      level-specs/
      balance-specs/
      change-requests/

    art/
      workspace-summary.md
      art-bible.md
      asset-specs/
      raw-assets/
      processed-assets/
      sprite-sheets/
      asset-manifest.json
      review-notes.md

    engineering/
      workspace-summary.md
      tech-spec.md
      cocos-scene-blueprints/
      implementation-notes/
      code-change-log.md

    cocos-automation/
      workspace-summary.md
      scene-ops/
      prefab-ops/
      editor-snapshots/
      cocos-build-logs/

    qa/
      workspace-summary.md
      test-plans/
      playtest-reports/
      screenshots/
      recordings/
      bug-reports/
      release-gate-reports/

    devops/
      workspace-summary.md
      deploy-plans/
      server-logs-redacted/
      rollback-plans/
      deployment-reports/
```

## 生产记忆系统

记忆系统是面向游戏项目的生产记忆层。它不是泛用聊天记忆，也不是 Agent 人格记忆。它保存端到端游戏交付和持续迭代所需的事实、决策、责任、产物和经验。

记忆范围：

| 记忆范围 | 内容 | 产品作用 |
| --- | --- | --- |
| Project Memory | 项目目标、已审批范围、当前阶段、里程碑状态、全局阻塞、当前发布目标。 | 让所有 Agent 共享同一个项目事实源。 |
| Role Memory | Agent 职责、分配任务、工作空间摘要、交接记录、阻塞项、已交付产物。 | 支持制作人随时询问进度，并获得对应角色的明确回答。 |
| Decision Memory | 制作人审批、否决、豁免、变更请求、受影响产物、后续任务。 | 防止 Agent 重新启用已否决方案或覆盖已审批方向。 |
| Artifact Memory | GDD、Art Bible、资产清单、场景蓝图、代码变更、构建产物、部署记录。 | 将每个产物关联到负责人、任务、阶段和决策历史。 |
| QA Memory | 测试计划、试玩报告、截图、录屏、Bug 报告、发布门禁、验证状态。 | 将 QA 变成持续的游戏作品评估历史，而不是一次性测试输出。 |
| Release and LiveOps Memory | 发布说明、部署状态、回滚记录、埋点方案、迭代 backlog、调优历史。 | 保证产品具备持续运维和持续更新能力。 |
| Producer Preference Memory | 制作人明确表达的偏好、风格约束、否决模式、审批习惯、评审意见。 | 在多轮会话和多次迭代中保留制作人的创作方向。 |
| Knowledge Memory | 从已完成工作中沉淀的 Cocos、微信小游戏、美术、QA、部署经验。 | 将项目经验转化为可复用的生产知识。 |

记忆状态：

- `draft`
- `active`
- `superseded`
- `rejected`
- `archived`

只有确认后的项目事实进入 durable memory。草案内容保持 `draft`；制作人否决的内容标记为 `rejected`；被替换的决策标记为 `superseded`。Agent 按状态和来源检索记忆，不把所有历史聊天都当成事实。

记忆记录结构：

```json
{
  "memory_id": "mem_...",
  "project_id": "game_...",
  "stage_id": "stage_1",
  "scope": "project",
  "owner_agent": "game_designer",
  "type": "decision",
  "status": "active",
  "content": "已审批的核心循环是 60 秒一局的点击防守玩法。",
  "source_event_id": "evt_...",
  "source_artifact": "shared/decisions/decision-004.md",
  "created_at": "2026-07-15T00:00:00Z",
  "updated_at": "2026-07-15T00:00:00Z"
}
```

Agent 上下文注入使用结构化记忆包：

- 项目简报。
- 当前阶段快照。
- 当前有效制作人决策。
- 角色工作空间摘要。
- 未完成任务和阻塞项。
- 相关产物。
- 最近审计事件。
- 发布或 QA 门禁状态。

向量检索是覆盖产物、决策、报告和知识条目的辅助检索层。结构化记录始终是事实源。原始凭据、密码、token、私钥和服务器访问密钥不进入记忆系统，只进入 Secret Vault。

## 白盒留痕与可追溯性

所有关键行为都写入 append-only 审计日志。

审计事件结构：

```json
{
  "event_id": "evt_...",
  "timestamp": "2026-07-15T00:00:00Z",
  "project_id": "game_...",
  "stage_id": "stage_2",
  "agent_id": "qa_agent",
  "task_id": "task_...",
  "action_type": "playtest_summary",
  "input_artifacts": ["gdd/core-loop.md", "builds/wechat/dev"],
  "output_artifacts": ["agents/qa/playtest-reports/report-001.md"],
  "tool_calls": ["browser_playtest", "screenshot_capture"],
  "git_commit_or_patch": "abc1234",
  "decision_refs": ["decision-004"],
  "status": "completed",
  "failure_reason": null
}
```

可追溯性要求：

- 美术资产必须保存在美术工作空间，并记录来源、生成版本、处理版本和 manifest 条目。
- QA 必须保存测试计划、试玩结果、截图、录屏和 Bug 报告。
- 程序改动必须关联任务、commit 或 patch。
- 部署动作必须保存日志，并对敏感信息脱敏。
- 制作人决策必须关联受影响的产物和任务。

## Cocos 与微信小游戏集成

引擎层不是散落的生成文件，而是 Agent 和 Cocos Creator 之间的受控桥接层。

引擎集成契约：

- 目标引擎使用 Cocos Creator 3.8 LTS。
- 玩法实现语言使用 TypeScript。
- 场景和 Prefab 通过结构化中间文件表达，例如 `SceneBlueprint.json`。
- Cocos Automation Agent 通过引擎桥或 MCP Server 应用场景蓝图。
- 复杂的 `.scene` 和 `.prefab` 序列化文件通过受控工具更新。
- 微信小游戏包通过命令行自动化构建。
- Cocos 自动化工作空间保存构建日志和编辑器操作日志。

引擎桥能力：

- 打开或校验 Cocos 项目。
- 导入并索引资产。
- 查询场景树。
- 应用场景蓝图。
- 创建或更新 Prefab。
- 生成并编译脚本。
- 执行 Cocos 构建。
- 导出微信小游戏包。
- 捕获编辑器或运行时快照。

## 评估体系与发布门禁

测试 Agent 代表的是游戏作品评估流程，不只是跑单元测试。

内部评估基准是 `Cocos MiniGame Bench`，因为目前没有一个成熟公开 benchmark 能完整覆盖 Cocos Creator、微信小游戏、多 Agent 生产、美术资产、玩法体验和部署交付。

评估维度：

| 维度 | 衡量内容 |
| --- | --- |
| Artifact Completeness | 游戏、美术、QA、发布相关产物是否齐全。 |
| Build Health | Cocos 和微信小游戏构建是否稳定成功。 |
| Runtime Playability | 游戏是否能启动、游玩、重开和完成核心流程。 |
| Gameplay Correctness | 实现是否符合已审批 GDD。 |
| Visual Usability | 画面是否清晰、反馈是否明确、交互是否可读。 |
| Art Consistency | 资产是否符合 Art Bible。 |
| Intent Alignment | 成品是否符合制作人 idea 和历史决策。 |
| WeChat Readiness | 包体、资源加载和平台约束是否可接受。 |
| Performance | FPS、内存、加载时间、包体大小和运行稳定性。 |
| Security and Ops | 密钥处理、部署日志、回滚方案和生产可观测性。 |

项目跟踪的 benchmark：

- GameDevBench。
- GameCraft-Bench。
- OpenGame。
- PlayCoder。

## 安全模型

为了端到端交付，服务器访问权限在项目开始时收集，但原始凭据不暴露给所有 Agent。

安全规则：

- 凭据进入 Secret Vault。
- Agent 通过受控工具请求操作，而不是直接读取明文密钥。
- DevOps 和发布工具只获得最小必要权限。
- 日志必须对密码、token、私钥和必要的服务器地址做脱敏。
- 每一次密钥写入或部署动作都必须进入审计日志。

## 系统架构

```mermaid
flowchart TB
    U["制作人"] --> CHAT["游戏工作室群聊"]
    CHAT --> ROUTER["按角色自动路由"]
    ROUTER --> ORCH["Studio Orchestrator"]
    ORCH --> TASKS["任务系统 / Mission Hub"]
    ORCH --> MEMORY["生产记忆系统"]
    ORCH --> AUDIT["Append-Only 审计日志"]
    ORCH --> AGENTS["专业游戏开发 Agents"]
    AGENTS --> WORKSPACE["角色工作空间"]
    AGENTS --> COCOS["Cocos 引擎桥"]
    AGENTS --> QA["游戏评估系统"]
    AGENTS --> RELEASE["微信 / DevOps 发布工具"]
    COCOS --> BUILD["可玩构建产物"]
    QA --> REPORTS["QA 报告"]
    RELEASE --> PROD["生产环境"]
    PROD --> LIVEOPS["数据分析和迭代 Backlog"]
    LIVEOPS --> MEMORY
    LIVEOPS --> CHAT
```

## 产品能力模块

Game Pipeline Agents 的目标产品由一组相互连接的能力模块组成：

| 模块 | 职责 |
| --- | --- |
| Studio Chat | 制作人房间、按角色路由、Agent 回复、结构化消息类型和跨房间交接。 |
| Agent Registry | 游戏开发角色、能力、权限、路由规则、可用性和工作空间归属。 |
| Workflow Orchestrator | 三阶段生产状态机、阶段门禁、任务创建、里程碑流转和制作人审批控制。 |
| Task and Mission Hub | Backlog、负责人、状态、阻塞、验收标准、关联产物和里程碑可视化。 |
| Production Memory System | 项目事实、角色进度、制作人决策、产物历史、QA 历史、发布记忆和可复用知识。 |
| Role Workspaces | 制作人、策划、美术、程序、Cocos 自动化、QA、DevOps 的可见工作区。 |
| Artifact Registry | GDD、Art Bible、资产、manifest、场景蓝图、代码变更、构建、报告和部署记录。 |
| Cocos Engine Bridge | Cocos 工程校验、资产导入、场景树检查、蓝图应用、Prefab 更新、脚本生成和构建。 |
| Asset Pipeline | 美术方向、资产生产、清洗、sprite sheet、动画序列、资产清单和运行时打包。 |
| QA and Evaluation Harness | 构建验证、运行时可玩性、视觉 QA、试玩自动化、Bug 复现和发布门禁评分。 |
| WeChat Release Pipeline | 微信小游戏打包、预览、上传准备、包体检查、资源策略和平台就绪性。 |
| DevOps and LiveOps | 受 Secret 控制的部署、回滚、日志、埋点方案、迭代 backlog 和生产调优。 |
| Audit and Observability | Append-only 事件、工具调用 trace、消息记录、产物血缘、成本和运行时遥测、脱敏运维日志。 |

整体架构使用 Clowder 一类多 Agent 聊天室系统里的房间、Agent Registry、消息路由、Invocation Queue、Task Store、MCP Callback、Workspace Explorer、生产记忆和 Append-Only Audit Log 作为协作基础。游戏领域层补充三阶段生产流程、游戏开发角色、美术资产流水线、Cocos 自动化、试玩评估和微信小游戏发布门禁。

## 当前状态

当前仓库处于本地纵向 MVP 阶段。版本化 GameContract、SceneBlueprint、PlaytestContract、Asset Manifest v2 和 ArtifactQualityReview 已落地严格校验与证据绑定门禁。策划/美术作者与独立质量审查员已经分离，服务端固定 rubric 可防止审查员自行降低阈值；美术链路已通过受控 DashScope 图片模型创作真实 PNG，再由独立视觉模型读取实际像素，记录 provider、request、prompt hash、seed、尺寸、语义审查及图片 hash 证据。PNG alpha policy 会按真实像素解码校验，Cocos build 也会绑定当前导入收据和源/目标资产字节。Cocos Bridge 已改为声明式通用渲染，QA 已能按契约执行多场景、公开事实断言和证据绑定。Workflow Aggregate 已把评审、制作人决策、变更、豁免、回滚和 LiveOps 迭代变成可重放的一等领域记录。工具执行已绑定 Agent、当前任务、产物身份和路径；Claude MCP 房间会话只读。Artifact Ledger 会冻结输入版本/hash，构建产物使用完整文件 manifest，旧构建、旧 QA、过期质量审查、外部篡改和符号链接越界都会在消费前失效。自动化 fixture 证明核心层不再依赖单一样例，但还没有三套真实 Cocos 游戏端到端交付。生产数据库与分布式队列/租约、项目媒体预算、隔离构建 worker、真实微信发布、高质量自动抠图/边缘后处理、Prefab 真实物化及生产 LiveOps 闭环仍在建设中，因此尚不能视为完整产品系统。
