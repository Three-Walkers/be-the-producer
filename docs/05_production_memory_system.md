# 05. 生产记忆系统

## 1. 定位

生产记忆系统保存项目交付事实。它不是聊天历史归档，也不是 Agent 人格记忆。系统只把经确认、可追溯、可引用的信息写入 durable memory，并通过状态字段控制草案、有效、被替换和被否决内容。

## 2. 记忆层次

| 记忆 | 说明 | 写入者 | 读取者 |
| --- | --- | --- | --- |
| Project Memory | 项目目标、阶段、里程碑、全局阻塞。 | Orchestrator, Producer | 全部 Agent |
| Role Memory | 角色任务、进度、阻塞、交接。 | 各角色 Agent | Orchestrator, Producer, 对应 Agent |
| Decision Memory | 制作人审批、否决、豁免、变更。 | Producer, Orchestrator | 全部 Agent |
| Artifact Memory | 产物元数据、版本、来源、负责人。 | Artifact Registry | 全部 Agent |
| QA Memory | 测试计划、试玩报告、Bug、门禁结果。 | QA Agent | Orchestrator, Engineering, Producer |
| Release Memory | 发布包、部署记录、回滚、上线状态。 | DevOps, WeChat | Producer, LiveOps, QA |
| Producer Preference Memory | 制作人明确偏好和禁区。 | Producer, Designer, Art | Designer, Art, Orchestrator |
| Knowledge Memory | 可复用 Cocos、微信、资产、QA、部署经验。 | Orchestrator, QA, Engineering | 全部 Agent |

## 3. 记忆状态

```text
draft       草案，未确认。
active      当前有效事实。
superseded  被新决策替代。
rejected    被制作人否决。
archived    历史归档，不参与默认上下文。
```

Agent 默认只读取 `active`，在需要追溯时读取 `superseded` 和 `rejected`。

## 4. 记忆记录 Schema

```json
{
  "memory_id": "mem_...",
  "project_id": "game_...",
  "stage_id": "stage_1",
  "scope": "decision",
  "owner_agent": "game_designer",
  "type": "core_loop",
  "status": "active",
  "content": "核心玩法采用 60 秒一局的点击防守循环。",
  "source_message_id": "msg_...",
  "source_event_id": "evt_...",
  "source_artifact_id": "artifact_...",
  "supersedes": null,
  "created_at": "2026-07-15T00:00:00Z",
  "updated_at": "2026-07-15T00:00:00Z"
}
```

## 5. 写入条件

进入 durable memory 的条件：

- 制作人明确审批。
- Agent 提交产物并被 Orchestrator 接收。
- QA 报告生成完成。
- 构建或部署任务完成。
- 变更请求被接受。
- 阶段门禁给出结论。

不进入 durable memory 的内容：

- 未确认脑暴。
- 模型中间思考。
- 明文 key、password、token、private key。
- 失败的临时草稿。
- 无来源的推断。

## 6. Producer Preference Memory

制作人偏好只记录明确表达内容，不推断人格。

示例：

```json
{
  "type": "producer_preference",
  "status": "active",
  "content": "制作人偏好轻松明快、低学习成本、单局 60 秒以内。",
  "source_message_id": "msg_..."
}
```

禁止记录：

- 未明确表达的心理画像。
- 和项目无关的私人信息。
- 无法验证的偏好推断。

## 7. 上下文注入

每次 Agent 调用前，Context Builder 生成 memory pack：

```json
{
  "project_brief": "...",
  "stage_snapshot": "...",
  "active_decisions": [],
  "producer_preferences": [],
  "role_workspace_summary": "...",
  "open_tasks": [],
  "blockers": [],
  "relevant_artifacts": [],
  "recent_audit_events": []
}
```

上下文注入规则：

- 只有 `active` 记录进入默认 durable memory。
- `project`、`decision`、`producer_preference` 三类 active 记录作为共享事实进入每个 Agent 的 memory pack。
- 带 `owner_agent` 的 active 记录只进入对应 Agent 的角色工作摘要。
- `draft`、`superseded`、`rejected`、`archived` 保留用于追溯，不进入默认 durable memory。
- 开放任务、阻塞、相关产物和最近 20 条审计事件与结构化记忆一起拼装，但它们仍由各自的 Registry 负责，不会伪装成 MemoryRecord。
- durable memory 层当前有 10,000 字符上限；跨房间消息摘要是会话上下文层，不是长期记忆。

## 8. 结构化记忆与检索边界

结构化记忆是事实源。当前本地纵向 MVP 只实现按项目、阶段、作用域、Owner 和状态的确定性过滤，没有启用 embedding 或向量库。这样可保证 UI 展示、Agent 注入和审计读取的是同一批记录，不会把相似度召回误称为已确认事实。

向量检索仍是目标能力，未来只用于召回文档片段、历史报告和相似经验：

检索流程：

1. 按 `project_id`、`stage_id`、`status` 过滤结构化记录。
2. 使用向量检索召回相关 artifacts 和 knowledge。
3. 合并去重。
4. 标注来源。
5. 注入 Agent。

Agent 输出必须引用来源，不把向量检索结果直接当事实。

## 9. 记忆更新和替换

当制作人变更方向：

- 新决策写入 `active`。
- 被替换旧决策改为 `superseded`。
- 关联任务重新评估。
- 受影响产物标记需要更新。

当制作人否决方案：

- 方案记忆标记为 `rejected`。
- 后续 Agent 不能把它作为候选默认方案。
- QA 和 Orchestrator 在报告中展示否决原因。

## 10. 记忆和工作空间同步

角色工作空间中的 `workspace-summary.md` 是 Role Memory 的可读落地文件。

同步规则：

- 任务状态变化时更新。
- 产物提交时更新。
- 阻塞产生或解除时更新。
- 阶段门禁完成时更新。

`workspace-summary.md` 示例：

```markdown
# Art Director Workspace Summary

当前阶段：production
当前任务：完善 UI 视觉规范
已交付：art-bible.md, asset-specs/ui.md
阻塞：等待制作人确认按钮主色
下一步：生成 UI asset manifest
```

## 11. 当前数据存储与目标形态

当前实现：

- 运行时：`StudioKernel` 内的 `InMemoryProductionMemory`。
- 恢复源：项目 `studio-state.json` 快照中的 `memoryRecords`。
- 人类可读镜像：工作空间 `shared/memory/project-memory.jsonl`。
- 每次 `writeMemory` 同步追加 `MEMORY_WRITTEN` 审计事件。

当前实现不包含 PostgreSQL、对象存储或向量库。生产多实例部署的目标形态才是：

- PostgreSQL：结构化 Memory 记录。
- 文件系统：workspace summary、GDD、Art Bible、QA 报告。
- 对象存储：图片、视频、构建包。
- 向量库：artifact 和 knowledge 的检索索引。

索引字段：

- `project_id`
- `stage_id`
- `scope`
- `owner_agent`
- `type`
- `status`
- `created_at`

迁移到数据库时，MemoryRecord 的 ID、状态、来源引用和 supersedes 关系必须保持不变，UI 不应因为存储适配器变化而改变语义。

## 12. 安全规则

- Secret 不进入 Memory。
- 日志和记忆中的服务器地址按策略脱敏。
- Producer Preference Memory 不记录个人隐私。
- 模型调用上下文中只包含任务所需最小信息。
- 记忆导出必须过滤 secret 和私密服务器信息。

## 13. 记忆中枢 UI

制作人界面的“记忆中枢”是只读的可观测面。它同时展示长期 `MemoryRecord` 与会话工作记忆（AgentSession、最近 ContextPacket 的层次、交接胶囊计数），并按 Agent 区分四种长期记忆关系：

| 标记 | 含义 |
| --- | --- |
| Agent 自有 | `ownerAgent` 指向该 Agent；不等于当前有效。 |
| 权限可读 | 记录作用域出现在 Agent Contract 的 `memoryScopes.read` 中。 |
| 本轮注入 | 记录满足当前 `buildMemoryPack` 的 active 注入规则，会进入 durable memory。 |
| 历史留档 | 非 active 状态，只供追溯，不影响默认决策。 |

UI 同时展示来源消息、审计事件、来源产物、替换关系、运行状态、开放任务和阻塞数。编辑和状态迁移暂不放进 UI：生产事实必须通过带角色权限、来源校验和审计事件的领域命令写入，不能由前端直接覆盖 JSON。
