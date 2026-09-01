# Agent Worker 与事务工作区隔离

本文描述当前已经落地的本地 Agent 执行边界。目标不是把每个角色变成长驻进程，而是让每次模型调用或 Harness 任务都经过受控 Worker，并让任务对正式项目的文件修改具备预检、提交和回滚边界。

## 1. 控制面与执行面

API 主进程仍是控制面，负责：

- Workflow、Task、Session、Context Packet 和 Agent 路由。
- Agent Worker 排队、取消和超时。
- 产物授权、质量收据、Artifact Ledger 与最终状态提交。

执行面分为两条兼容路径：

| 路径 | 进程边界 | 文件边界 |
| --- | --- | --- |
| Direct API | 独立 Node Worker 子进程 | 不直接写项目；模型结果回到控制面后由受权工具提交 |
| Claude CLI | 独立 Claude CLI 子进程及 stdio MCP 子进程 | 在任务级 staging 副本中执行；通过预检后事务写回 |

Agent 的长期身份仍由持久化 Session Record 表达。子进程按调用创建和回收，不是常驻 Agent，也不是系统真相来源。

## 2. Direct API Worker 协议

Direct API 不再在 API 主进程里直接执行网络模型调用。控制面通过版本化 JSON 协议把 provider 和不可变 prompt 输入写入子进程 stdin；Worker 以 NDJSON 返回：

- `activity`：请求开始、响应头、首个输出、完成或失败。
- `result`：模型内容、模型身份、延迟和完整 trace。
- `error`：可重建的 `ModelRequestError` 类型、失败类型和 trace。

边界规则：

- API key 不进入命令行参数，也不进入 Worker 环境变量，只存在于受控 stdin 请求。
- Worker 默认使用 256MB V8 old-space 上限，可通过 `BTP_MODEL_WORKER_MEMORY_MB` 调整，范围限制为 128–1024MB。
- 总超时之外还有父进程 safety deadline；取消时先 `SIGTERM`，宽限后 `SIGKILL`。
- stdout 有 16MB 上限，协议事件必须绑定当前 request id。
- Worker 仅继承网络/TLS 所需的最小环境。

## 3. 全局执行池

Direct API Worker 与通过 Model Runtime 启动的 Claude CLI Harness 共用进程内执行池：

```text
route/task -> FIFO queue -> bounded execution slot -> worker/harness -> result
```

默认并发上限为 4，可通过 `BTP_AGENT_WORKER_CONCURRENCY` 调整，硬限制为 1–32。排队支持：

- FIFO 释放。
- queue timeout。
- 项目暂停、切换或任务取消时从队列移除。
- 无论成功、失败或抛错都释放执行槽。

这解决单机上的进程风暴，但不是分布式 Invocation Queue。多实例部署仍需要数据库 lease、heartbeat、幂等键、重试策略和 dead-letter queue。

## 4. Claude staging 工作区

Claude task session 不再以正式项目目录作为 `cwd`。每轮执行会：

1. 对正式项目做符号链接和路径安全校验。
2. 复制为系统临时目录中的 staging 工作区；忽略 `.git`、Harness 状态、依赖缓存和 Cocos 临时目录。
3. 在 staging 中启动 Claude CLI，MCP 的 `BTP_PROJECT_ROOT` 也指向 staging。
4. 把 `CLAUDE_CONFIG_DIR` 单独指向正式项目内的持久 Harness 状态目录，保证 `--resume` 不因 staging 回收而丢失。
5. 以 staging 前后完整快照检测所有实际文件变化，而不是只相信模型声明的 changed paths。
6. 校验任务写权限、受保护 QA 证据、失败工具副作用、删除行为和产物质量收据。
7. 在深拷贝的 Studio Kernel 上预演 Artifact Ledger 物化。
8. 通过后逐文件原子 rename 到正式目录；保留备份直到状态提交成功，异常时恢复旧字节并删除新文件。
9. 清理 staging。

任意未授权写入、删除、失败工具残留或质量收据错误都会使整轮文件变更不提交，不再保留“部分合法、部分越权”的混合结果。

Claude room session 使用相同 staging 副本，但严格只读：任何变化都会使会话失败，副本随后销毁。

## 5. 仍然存在的边界

当前实现是本地产品级基础，不等同于多租户强沙箱：

- Worker 与主进程仍使用同一 OS 用户。
- staging 是文件副本，不是只读 mount、namespace、VM 或容器。
- Cocos 构建、试玩和发布工具内部启动的外部进程尚未全部迁入容器。
- Kernel 和 Artifact Ledger 仍由单个 API 进程持有，尚无数据库事务或跨实例一致性。
- 本机上拥有同一用户权限的恶意进程仍可能制造 TOCTOU；生产环境需要 `openat`/`O_NOFOLLOW`、容器挂载和独立服务身份。

下一阶段应将当前 Worker 协议迁移到持久 Invocation Queue，并为 Cocos、QA 和发布任务提供容器镜像、只读输入挂载、独立输出卷、网络 allowlist、CPU/内存配额以及签名执行收据。

## 6. 验收命令

```bash
npm run verify:agent-worker
npm run verify:agent-pool
npm run verify:workspace-isolation
npm run verify:claude-harness
npm run verify:harness-authorization
npm run verify:path-safety
npm run verify:session-runtime
npm run verify:concurrent-room
```
