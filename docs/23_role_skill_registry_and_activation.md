# 角色 Skill Registry 与受控装载

文档状态：已实现

## 1. 目标

Skill 是版本化的专业工作方法，不是角色、工具或权限。系统根据当前 Agent、任务、阶段和产物类型，在每次模型调用前选出少量适用 Skill，写入 Context Packet，并把实际装载结果保存在快照和记忆面板中。

本能力解决三个问题：

- 让策划、美术、程序、QA、运维获得稳定的专业工作法，而不是只依赖一段不断膨胀的角色 Prompt。
- 普通任务自动使用合适 Skill，不要求制作人每轮手工点名。
- Skill 不能扩大 `AgentContract` 的工具、工作空间、密钥、产物或阶段权限。

这里的 Skill 是 Game Pipeline Agents 自己的领域能力，不等同于 Codex Desktop 的个人 Skill 安装目录。生产 Agent 可能由 Claude CLI、Direct API 或其他模型执行，因此装载必须由服务端统一解析和留痕。

## 2. 领域结构

`AgentSkillDefinition` 是只读注册项：

- `skillId`、显示名、语义版本和说明。
- `riskLevel`：`standard` 或 `high`。
- `origin`：当前只接受 `internal_clean_room`。
- `requiredTools`：注册时核对角色本来就拥有这些工具；它不是授权清单。
- `instructions`：注入模型上下文的专业步骤。
- `contentHash`：服务端按规范字段计算 SHA-256，确保每次执行可追踪到精确内容。

`AgentContract.skillBindings` 是角色白名单，声明：

- 激活策略：`automatic`、`workflow_gate` 或 `manual_only`。
- 优先级与允许阶段。
- 可选的关键词、输入产物类型和输出产物类型选择器。
- 高风险 Skill 的批准阶段。

单次调用最多注入三个 Skill，避免上下文污染。未进入角色白名单的 Skill，即使制作人显式点名也不会装载。

## 3. 激活规则

解析器只使用受控状态：当前角色、当前 Workflow Stage、当前 Task、登记的输入/输出 Artifact，以及本次游标增量中的 Producer 消息。

| 策略 | 默认行为 | 人工指定 | 安全边界 |
| --- | --- | --- | --- |
| `automatic` | 任务语义或产物类型命中时自动装载 | `$skill-id` 可显式装载角色白名单内 Skill | 不新增工具或路径 |
| `workflow_gate` | 命中后先显示“等待批准” | 显式指定也不能跳过阶段门禁 | 只有 `approvedStages` 才能装载 |
| `manual_only` | 默认不装载 | 必须由制作人显式指定 | 仍受角色白名单和阶段限制 |

制作人可在本轮消息中使用：

- `$level-design`：显式要求角色白名单内的关卡设计 Skill。
- `$disable-skill:balance-analysis`：仅在本轮禁用指定 Skill。

普通任务不需要人工指定。显式指令主要用于覆盖自动判断、可复现测试或要求某个专业视角。禁用优先于启用。

## 4. 默认角色映射

| 角色 | Skill | 策略 |
| --- | --- | --- |
| Studio Orchestrator | `game-generation-router` | 立项阶段自动 |
| Game Designer | `level-design`、`balance-analysis` | 按任务语义自动 |
| Art Director | `cocos-mobile-ui` | UI/HUD 任务自动 |
| Asset Production | `asset-production` | 资产与 Manifest 任务自动 |
| Cocos Tech Lead | `cocos-architecture` | 架构与 SceneBlueprint 任务自动 |
| Gameplay Programmer | `gameplay-logic`、`cocos-mobile-ui` | 玩法逻辑/UI 实现任务自动 |
| QA Evaluator | `game-playtest` | 试玩契约与 QA 任务自动 |
| DevOps | `deploy-game` | 高风险，只有 `production_deploy` 阶段批准后装载 |
| LiveOps / Analytics | `game-analytics` | LiveOps 数据任务自动 |

`multiplayer-setup` 已作为高风险预研 Skill 登记，但当前没有 Network Architect 和 Backend Engineer 角色，因此不绑定任何默认角色。它不会因为制作人输入名称而获得执行能力；需要先增加角色、工具、服务端权限、网络契约和独立门禁。

设计/视觉质量审查员暂不装载作者 Skill，保持审查独立性。Producer 也不继承策划、美术或部署 Skill。

## 5. Context Packet 与审计

每次解析成功后，服务端增加 `skill_guidance` 层，并在 `ContextPacket.activatedSkills` 保存：

- Skill ID、名称、版本和内容 hash。
- 风险级别。
- 激活来源：自动、制作人指定或 Workflow 批准。
- 本次命中的可读原因。

该收据随 Studio Snapshot 持久化。Direct API 与 Claude Harness 共同消费同一 Context Packet，所以不存在某条模型路径漏装或私自装载 Skill 的分叉。

## 6. UI 可视化

生产记忆面板的 Agent Inspector 增加 `ROLE SKILLS` 区域：

- “已注入”展示最后一次真实 Context Packet 中的 Skill，而不是根据当前界面状态猜测。
- “角色白名单”展示当前阶段下每项 Skill 的 `active`、`available`、`awaiting_approval`、`disabled` 或 `not_applicable`。
- 激活卡显示来源、原因、版本、hash 和高风险标记。

因此制作人能回答“这个 Agent 刚才实际用了哪个专业方法”，也能区分“角色具备”与“本轮已经注入”。

## 7. 外部 Skill 适配原则

图片中的 Skill 名单可以帮助确定能力分类，但仅凭名称和宣传图不能安全安装第三方代码。当前默认定义采用 clean-room 内部实现：不复制未知 Prompt、脚本、依赖或许可证内容。

未来接入真实第三方 Skill 时必须逐个完成：

1. 获取可审计源码、版本、许可证和来源。
2. 检查脚本、依赖、网络访问、密钥和文件写入范围。
3. 转换成内部 `AgentSkillDefinition`，不直接赋予权限。
4. 绑定最小角色白名单与阶段。
5. 增加专属 fixture、内容 hash、回滚和兼容策略。

## 8. 验证

运行：

```bash
npm run verify:agent-skills
npm run verify:memory-view
npm run verify:session-context
```

专属回归覆盖自动装载、人工覆盖、禁用、跨角色拒绝、高风险阶段门禁、Context Packet 收据、快照恢复和 UI 标记。
