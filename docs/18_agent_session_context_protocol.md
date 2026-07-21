# Agent 会话、Context Packet 与跨会话协议

## 1. 目标

Agent 不依赖进程内最近消息数组维持工作状态。房间讨论、任务执行、上下文游标、Claude CLI session、恢复记录和交接内容都进入项目持久状态，服务重启后按同一协议继续。

## 2. 两级会话

| 会话 | 逻辑键 | 职责 |
| --- | --- | --- |
| 房间会话 | `room:{project}:{room}:{agent}` | 与制作人和其他角色持续讨论，读取项目事实，不直接写任务产物。 |
| 任务 child session | `task:{project}:{room}:{task}:{agent}` | 使用工具执行一个具体任务，生成可验证产物，并把结果回流父房间。 |

每次 seal 或 resume 恢复都会创建递增的 `epoch`。物理 `sessionKey` 在逻辑键后增加 `:e{epoch}`，旧记录不会被覆盖。

## 3. 房间游标与分层 Context Packet

每个 session 保存独立 `RoomContextCursor`。Context Builder 从游标之后读取房间增量，不使用固定条数截断。输入按层构建：

1. 身份、项目与房间。
2. 已确认的持久记忆。
3. 当前任务或角色开放工作。
4. Artifact Ledger 证据。
5. 尚未消费的 handoff capsule。
6. 超预算区间摘要。
7. 游标后的原始消息增量。

只有模型调用成功后才提交 `cursorAfter`。调用失败时游标不前移，因此后继 session 可以重新读取未成功处理的消息。

## 4. Claude CLI 持久恢复

第一次调用不传 resume 参数，解析 Claude CLI stream-json 返回的 `session_id` 并写入 `AgentSessionRecord`。后续同一逻辑 session 调用：

```text
claude --print ... --name <sessionKey> --resume <session_id>
```

房间和任务 child 分别保存 session ID。模型 Provider、模型名、调用 ID、上下文包 ID、resume 次数和最后成功时间一并持久化。

## 5. Session Mutex

mutex 键使用 `logicalSessionKey`，不是物理 epoch。这样旧 session 发生恢复并切换到后继 epoch 时，排队调用仍处于同一互斥域。同一 room/task session 不会被并发 resume 两次，不同 Agent 或不同 task 可以并行。

## 6. Context Health 与 Seal

Context Packet 计算 `healthy`、`degraded`、`stale`、`oversized`：

- `healthy`：游标连续且在预算内。
- `degraded`：接近预算或部分消息被压缩。
- `stale`：持久游标指向的消息不存在，需要摘要恢复。
- `oversized`：累计上下文达到预算。

已有提交历史的 session 出现 `stale` 或 `oversized` 时会 seal，并创建后继 epoch。seal 记录原因、时间、前驱 session 和恢复胶囊。

## 7. Resume 失败自愈

Claude CLI 返回 session 不存在、无法恢复、resume 进程异常或恢复调用无可读输出时：

1. 把当前 session 标记为 recovering。
2. seal 当前 epoch。
3. 创建无旧 `session_id` 的后继 epoch。
4. 生成 `resume_recovery` capsule，包含最后游标、上下文健康和未消费交接摘要。
5. 从持久状态重新构建 Context Packet。
6. 无 `--resume` 重试一次。
7. 重试失败则标记 failed，并保留原游标供后续人工或自动重试。

认证、权限、余额、限流和制作人取消不伪装成 resume 故障，不触发 session 重建。

## 8. 跨会话 Capsule

| Capsule | 方向 | 内容 |
| --- | --- | --- |
| `parent_to_child` | 房间 → task child | 任务、阶段、验收标准、父游标、输入产物。 |
| `child_to_parent` | task child → 房间 | 本轮结论、消息、真实变更路径、产物 ID。 |
| `agent_handoff` | 当前 Agent → 目标 Agent 房间 | handoff 原因、目标角色、任务和证据引用。 |
| `resume_recovery` | sealed → 后继 epoch | seal 原因、最后游标、健康状态和恢复要求。 |

Capsule 被目标 Context Packet 实际投递后才标记 consumed。运行期间新到达的 capsule 不会被旧调用误消费。

## 9. 任务收束

Agent 的文字声明不能 seal task child。Agent Loop 必须先执行工具并更新 Artifact Ledger，再执行回流协议：

- `ready_for_review` 只有在任务进入 `review/done` 且输出证据通过时才 seal。
- `handoff` 写入 child-to-parent 和 agent-handoff 后 seal 当前 child。
- `continue`、`blocked`、`waiting_for_producer` 保留 child session，下一轮继续 resume。

## 10. 持久化与观测

`studio-state.json` 保存 `agentSessions`、`contextPackets` 和 `handoffCapsules`。旧快照缺少这些字段时按空数组迁移。

调试接口：

```text
GET /projects/{projectId}/agent-sessions
```

返回当前项目全部会话、最近 Context Packet 和交接胶囊，用于检查 cursor、health、epoch、resume 和跨角色回流。

## 11. 自动验证

```bash
npm run verify:session-context
npm run verify:session-runtime
npm run verify:claude-harness
```

分别覆盖游标与分层上下文、mutex 与重启持久化、真实运行时 resume 自愈，以及 Claude CLI 参数和失败分类。
