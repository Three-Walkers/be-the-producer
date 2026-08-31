# Game Pipeline Agents 开发文档目录

文档状态：开发文档索引

本文档是 Game Pipeline Agents 开发文档入口，负责索引完整章节、说明阅读顺序和标注每个文档的职责边界。

## 文档目标

开发文档覆盖完整产品系统，包括多 Agent 游戏工作室、制作人参与流程、角色分工、生产记忆、Cocos 引擎桥、美术资产流水线、QA 评估、微信小游戏发布、DevOps 运维、Model Gateway 和白盒审计。

## 文档组织方式

| 章节 | 文档 | 内容 |
| --- | --- | --- |
| 01 | [产品范围与用户旅程](./01_product_scope_and_user_journey.md) | 产品定位、输入输出、制作人旅程、阶段视图。 |
| 02 | [工作室角色与 Agent 契约](./02_studio_roles_and_agent_contracts.md) | 角色职责、权限、工作空间、模型能力解耦。 |
| 03 | [多 Agent 群聊与消息路由](./03_multi_agent_chat_and_routing.md) | 房间、消息 schema、路由、并行/串行、进度询问。 |
| 04 | [工作流编排与阶段门禁](./04_workflow_orchestration_and_phase_gates.md) | 三阶段状态机、门禁、审批、变更和回退。 |
| 05 | [生产记忆系统](./05_production_memory_system.md) | Project/Role/Decision/Artifact/QA/Release/Preference/Knowledge Memory。 |
| 06 | [任务、产物与角色工作空间模型](./06_task_artifact_and_workspace_model.md) | 大任务、子任务、Task、Decision、Artifact、Workspace、生命周期和一致性。 |
| 07 | [Model Gateway 与 API Key 安全](./07_model_gateway_and_api_key_security.md) | 模型调用、Secret Vault、BYOK、预算、脱敏和审计。 |
| 08 | [策划 Agent 与 GDD 流水线](./08_design_agent_and_gdd_pipeline.md) | 策划 Agent、开局澄清、GDD、机制、数值和任务拆解。 |
| 09 | [美术 Agent 与资产流水线](./09_art_agent_and_asset_pipeline.md) | Art Bible、资产规格、资产生产、manifest、Cocos 交接。 |
| 10 | [Cocos 引擎桥](./10_cocos_engine_bridge.md) | SceneBlueprint、资源导入、场景、Prefab、脚本、构建。 |
| 11 | [微信小游戏发布流水线](./11_wechat_minigame_release_pipeline.md) | 微信构建、包体检查、预览、上传准备、发布记录。 |
| 12 | [QA 评估与 Cocos MiniGame Bench](./12_qa_evaluation_and_cocos_minigame_bench.md) | QA 维度、自动试玩、Bug、发布门禁和 benchmark。 |
| 13 | [DevOps、LiveOps 与持续迭代](./13_devops_liveops_and_iteration_loop.md) | Secret、部署、日志、健康检查、回滚、埋点和迭代。 |
| 14 | [数据模型、存储与事件结构](./14_data_model_storage_and_event_schema.md) | PostgreSQL 表、schema、存储分层和事件命名。 |
| 15 | [可观测性、审计与可追溯性](./15_observability_audit_and_traceability.md) | AuditEvent、tool trace、产物血缘、白盒视图和告警。 |
| 16 | [开源参考与适配策略](./16_open_source_references_and_adaptation.md) | Clowder、Claude-Code-Game-Studios、美术/策划/Cocos/QA 参考。 |
| 17 | [交付计划与工程任务](./17_delivery_plan_and_engineering_tasks.md) | 仓库结构、模块任务、测试策略、本地环境和验收标准。 |
| 18 | [Agent 会话、Context Packet 与跨会话协议](./18_agent_session_context_protocol.md) | 房间游标、Claude resume、session mutex、上下文健康、child session、seal 和 handoff capsule。 |
| 19 | [游戏、场景与试玩契约](./19_game_scene_playtest_contracts.md) | GameContract、SceneBlueprint、PlaytestContract 和契约驱动试玩。 |
| 20 | [工作流持久化与安全](./20_workflow_persistence_security.md) | Workflow Aggregate、持久化恢复、路径和本地服务安全。 |
| 21 | [独立质量评审与多模态美术](./21_quality_review_and_multimodal_art.md) | 设计/视觉独立评审、质量收据、多模态资产生产。 |
| 22 | [Task Episode 与生产证据审计](./22_task_episode_and_production_audit.md) | 四通道 Evidence Bundle、Finding、Intervention Ledger、不可变审计报告和门禁集成。 |
| 23 | [角色 Skill Registry 与受控装载](./23_role_skill_registry_and_activation.md) | 角色白名单、任务自动匹配、高风险阶段门禁、Context Packet 收据和 UI 可观测性。 |

## 阅读顺序

1. 先读 01 到 06，理解产品、角色、群聊、阶段、记忆和工作空间。
2. 再读 07 到 12，理解模型调用、策划、美术、Cocos、微信和 QA。
3. 再读 13 到 15，理解运维、数据模型和可追溯性。
4. 最后读 16 到 23，理解开源适配、工程任务拆解、持久会话、契约、质量评审、生产证据审计和角色 Skill 装载。

## 01. 产品范围与用户旅程

文件：`01_product_scope_and_user_journey.md`

章节边界：

- 产品目标。
- 目标用户：制作人。
- 输入：idea/ideal、服务器访问权限、制作人反馈。
- 输出：微信小游戏、Cocos 工程、资产、GDD、QA 报告、发布记录、迭代 backlog。
- 端到端用户旅程。
- 制作人在关键节点的参与方式。
- 模糊 idea 到可执行游戏方案的开局流程。

## 02. 工作室角色与 Agent 契约

文件：`02_studio_roles_and_agent_contracts.md`

章节边界：

- Studio Orchestrator。
- Producer Agent。
- Game Designer Agent。
- Art Director Agent。
- Asset Production Agent。
- Cocos Tech Lead Agent。
- Gameplay Programmer Agent。
- Cocos Automation Agent。
- Game Evaluator / QA Agent。
- WeChat Platform Agent。
- DevOps Agent。
- LiveOps / Analytics Agent。
- 每个角色的职责、权限、输入、输出、禁止行为和交接对象。
- Agent 背后模型能力与角色身份的解耦。

## 03. 多 Agent 群聊与消息路由

文件：`03_multi_agent_chat_and_routing.md`

章节边界：

- 工作室房间结构。
- `#studio-main`、`#design-room`、`#art-room`、`#engineering-room`、`#qa-room`、`#release-room`。
- 制作人随时提问的响应机制。
- Agent 自判断是否相关的规则。
- @mention、房间上下文、阶段上下文、最近任务上下文。
- 并行回复与串行交接。
- 消息类型与结构化消息 schema。
- Clowder 类聊天室能力在本系统中的映射。

## 04. 工作流编排与阶段门禁

文件：`04_workflow_orchestration_and_phase_gates.md`

章节边界：

- 三阶段生产状态机。
- 阶段 1：立项、机制和世界观讨论。
- 阶段 2：开发落地和可玩版本实现。
- 阶段 3：上线、运维和持续迭代。
- 阶段门禁。
- 制作人审批。
- 变更请求处理。
- 阻塞和回退。
- 任务生成、任务转交和阶段流转。

## 05. 生产记忆系统

文件：`05_production_memory_system.md`

章节边界：

- 生产记忆与普通聊天记忆的区别。
- Project Memory。
- Role Memory。
- Decision Memory。
- Artifact Memory。
- QA Memory。
- Release and LiveOps Memory。
- Producer Preference Memory。
- Knowledge Memory。
- 记忆状态：`draft`、`active`、`superseded`、`rejected`、`archived`。
- 记忆写入条件。
- Agent 上下文注入。
- 向量检索与结构化事实源的关系。
- Secret 不进入 memory 的规则。

## 06. 任务、产物与角色工作空间模型

文件：`06_task_artifact_and_workspace_model.md`

章节边界：

- Project、Stage、Room、Message、Task、Decision、Artifact、Workspace、AuditEvent。
- 大任务、任务、子任务层级。
- 任务归属。
- `进行中 / 阻塞中 / 待办 / 已完成` 状态桶。
- Workspace Task Board。
- 产物注册。
- 角色工作空间目录。
- 产物生命周期。
- 任务状态与阻塞状态。
- 产物和决策的关联。
- 制作人审阅记录。

## 07. Model Gateway 与 API Key 安全

文件：`07_model_gateway_and_api_key_security.md`

章节边界：

- Agent 角色身份与模型执行引擎的解耦。
- 统一 Model Gateway。
- API key 存储。
- BYOK 模式。
- per-agent 模型权限。
- per-agent 成本预算。
- 限流、重试、降级。
- 模型调用审计。
- 敏感信息脱敏。
- 文本模型、代码模型、图像模型、视频模型、评估模型的路由。

## 08. 策划 Agent 与 GDD 流水线

文件：`08_design_agent_and_gdd_pipeline.md`

章节边界：

- 策划 Agent 基础来源：`Claude-Code-Game-Studios/game-designer`。
- GDD 模板来源：`openagenticgame-gdd`。
- 开局澄清流程。
- 核心循环设计。
- 机制设计。
- 数值和平衡。
- 世界观和玩家幻想。
- 关卡与成长。
- 设计决策留痕。
- GDD 到工程任务的拆解。

## 09. 美术 Agent 与资产流水线

文件：`09_art_agent_and_asset_pipeline.md`

章节边界：

- 美术 Agent 基础来源：`Claude-Code-Game-Studios/art-director`。
- Art Bible。
- 美术风格、色板、视觉层级、UI 视觉方向。
- 资产规格和命名规范。
- Asset Production Agent。
- `ai-game-art-pipeline-skill` 的接入方式。
- `agent-sprite-forge` 的接入方式。
- 2D sprite、UI、背景、特效、sprite sheet、动画序列。
- 资产生成、清洗、打包、导入 Cocos。
- 美术资产 QA 与审阅。

## 10. Cocos 引擎桥

文件：`10_cocos_engine_bridge.md`

章节边界：

- Cocos Creator 3.8 LTS。
- Cocos Engine Bridge / Cocos MCP。
- SceneBlueprint。
- 资产导入。
- 场景树查询。
- Prefab 创建与更新。
- 脚本生成与编译。
- Cocos 构建。
- 编辑器操作留痕。
- 避免直接无约束修改 `.scene` 和 `.prefab`。
- 与程序 Agent、美术 Agent、QA Agent 的接口。

## 11. 微信小游戏发布流水线

文件：`11_wechat_minigame_release_pipeline.md`

章节边界：

- 微信小游戏构建目标。
- 包体和分包策略。
- 资源加载策略。
- 预览和上传准备。
- 平台检查。
- 发布记录。
- 回滚方案。
- 与 DevOps、QA、制作人审批的关系。

## 12. QA 评估与 Cocos MiniGame Bench

文件：`12_qa_evaluation_and_cocos_minigame_bench.md`

章节边界：

- QA Agent 的定位：游戏作品评估流程。
- Cocos MiniGame Bench。
- Artifact Completeness。
- Build Health。
- Runtime Playability。
- Gameplay Correctness。
- Visual Usability。
- Art Consistency。
- Intent Alignment。
- WeChat Readiness。
- Performance。
- Security and Ops。
- 自动试玩、截图、录屏、Bug 复现、发布门禁。

## 13. DevOps、LiveOps 与持续迭代

文件：`13_devops_liveops_and_iteration_loop.md`

章节边界：

- 服务器访问权限接入。
- Secret Vault。
- 部署计划。
- 部署记录。
- 日志脱敏。
- 回滚。
- 生产健康检查。
- 埋点方案。
- 数据分析。
- 迭代 backlog。
- 制作人后续优化决策。

## 14. 数据模型、存储与事件结构

文件：`14_data_model_storage_and_event_schema.md`

章节边界：

- 数据实体。
- 数据库表结构。
- JSON schema。
- Message schema。
- Task schema。
- Decision schema。
- Artifact schema。
- Memory schema。
- AuditEvent schema。
- 文件存储与对象存储。
- 本地工作区与数据库的一致性。

## 15. 可观测性、审计与可追溯性

文件：`15_observability_audit_and_traceability.md`

章节边界：

- Append-only audit log。
- Tool call trace。
- Agent invocation trace。
- 消息留痕。
- 产物血缘。
- 成本、token、耗时统计。
- 失败原因。
- 敏感信息脱敏。
- 问题追责路径。
- 制作人可见的白盒视图。

## 16. 开源参考与适配策略

文件：`16_open_source_references_and_adaptation.md`

章节边界：

- Clowder AI。
- Claude-Code-Game-Studios。
- OpenAgenticGame-Studios。
- gamestudio-subagents。
- openagenticgame-gdd。
- OpenGame。
- ai-game-art-pipeline-skill。
- agent-sprite-forge。
- Funplay Cocos MCP / cocos-code-mode。
- 各项目可复用部分。
- 不直接照搬的部分。
- License 和 attribution。

## 17. 交付计划与工程任务

文件：`17_delivery_plan_and_engineering_tasks.md`

章节边界：

- 产品能力模块到工程任务的映射。
- 仓库结构。
- 后端服务。
- 前端工作室界面。
- Agent runtime。
- Model Gateway。
- Cocos Bridge。
- 数据库。
- 工作区文件系统。
- 测试和验证。
- 部署方式。
- 工程任务拆解。

## 审核重点

请优先审核以下问题：

- 章节是否覆盖完整产品系统。
- 策划、美术、程序、QA、运维的职责是否都有独立承载位置。
- Model Gateway、API key、安全和记忆系统是否需要拆得更细。
- Cocos 和微信小游戏是否需要提前独立成更多章节。
- 开源项目适配策略是否需要单独拆成“设计参考”和“代码复用”两类。
