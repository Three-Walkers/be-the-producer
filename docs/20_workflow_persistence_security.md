# Workflow、持久化与 API 边界

本文记录第二阶段架构收口后的实际边界。它描述已经实现的本地纵向能力，也明确哪些部分仍不能按生产系统使用。

## 1. Workflow Aggregate 是唯一阶段真相

项目阶段不再由调用方任意赋值。`StudioKernel` 持有一个可重放的 `WorkflowAggregate`，项目快照中的 `project.currentStage` 必须与 Workflow stage 一致，否则恢复失败。

合法主路径是：

```text
concept_discussion
  -> concept_review
  -> production
  -> first_playable_review
  -> release_preparation
  -> release_gate
  -> production_deploy
  -> liveops
```

其中三个 review stage 都是显式状态。打开评审、记录制作人决定、提交变更、记录豁免、部署回滚和发起 LiveOps 迭代都使用专用命令，不能通过通用 `setStage` 绕过。

每条命令必须携带：

- `expectedRevision`：乐观并发控制。
- `idempotencyKey`：相同请求安全重放，不重复产生决定或事件。
- `actor`：记录执行者及角色。
- `occurredAt`：可选的显式事件时间。

只有 `producer` 能记录门禁决定。Agent 可以准备材料、提出意见和提交评审，但不能自我批准。拒绝和变更请求会回到对应返工阶段；发布部署失败可显式回滚到 `release_preparation`；LiveOps 迭代会创建变更请求并回到 `production`。

评审开启后，Workflow 保持在 review stage，但 Agent Loop 仍可执行该评审来源阶段中尚未完成的任务，用于消除评审阻塞。只有制作人决定能离开 review stage。

工作区同步会写出：

```text
shared/workflow/workflow.json
shared/workflow/events.json
```

这两个文件是观察副本；持久化快照内嵌的 Workflow event stream 才是恢复依据。
同一视图也可通过受保护的 `GET /projects/{projectId}/workflow` API 读取。

## 2. 本地项目状态持久化

`ProjectStateRepository` 是持久化端口，当前实现 `ProjectPersistenceStore` 是单进程文件适配器。默认目录：

```text
${GAME_PIPELINE_DATA_ROOT:-<repo>/.local/projects}/{projectId}/
  studio-state.json
  studio-state.backup.json
```

保存流程为：

1. 对内存快照做最低结构校验。
2. 用 `createStudioKernelFromSnapshot` 完整恢复一次，验证跨对象不变量和 Workflow event stream。
3. 若旧 primary 合法，将它原子写为 last-known-good backup。
4. 将新内容写入同目录独占临时文件，`fsync` 文件。
5. 原子 rename 为 primary，再 `fsync` 目录。

读取时，损坏或不可恢复的 primary 不会导致所有项目启动失败。适配器会尝试合法 backup，成功后修复 primary，并把问题放入 `listIssues()`。`loadAll()` 对不同项目做故障隔离。

路径边界包括安全 project id、根目录约束、持久化路径拒绝符号链接，以及 POSIX 下目录 `0700`、文件 `0600`。

这仍然不是生产数据库。当前适配器不提供：

- 跨进程事务或锁。
- 多实例一致性。
- 数据库级唯一键、外键和查询索引。
- 增量事件归档、压缩和灾备复制。
- Invocation Queue 的 lease、heartbeat、重试和 dead-letter queue。

在引入多个 worker 前，应实现数据库版 `ProjectStateRepository`，并把模型调用、Cocos 构建、试玩和发布操作迁入持久化 Invocation Queue。

## 3. API 最小安全边界

默认只绑定 `127.0.0.1`。任何非 loopback 绑定在没有 `BTP_API_TOKEN` 时同步拒绝启动：

```bash
BTP_API_TOKEN='<random-token>' \
BTP_ALLOWED_ORIGINS='https://studio.example.com' \
npm start -- --host 0.0.0.0
```

启用 token 后，除静态 UI 和 `/health` 外，所有 API 都要求：

```http
Authorization: Bearer <BTP_API_TOKEN>
```

浏览器 UI 在第一次收到 `401` 时会请求 token，并只保留在当前页面内存中。刷新页面需要重新输入，避免把服务端凭据持久化到 URL 或浏览器存储。

Origin 策略默认只允许请求自身 origin；额外 origin 通过逗号分隔的 `BTP_ALLOWED_ORIGINS` 显式加入。预检请求应用同一规则。
未启用 token 的 loopback 模式还要求 Host 本身是 loopback，阻断用攻击者域名解析到 `127.0.0.1` 的 DNS rebinding 请求。

JSON 请求要求 `application/json` 或 `+json` Content-Type，拒绝压缩编码和畸形 JSON。默认请求体上限为 1 MiB，可用 `BTP_JSON_BODY_LIMIT_BYTES` 调整，硬上限 10 MiB。API 响应使用 `no-store`，并设置基础 CSP、frame、MIME sniffing、referrer 和 permissions 响应头。未处理的 500 返回通用错误，不回显 token 或内部异常。

这只是访问边界，不是完整安全控制面。仍需实现：

- 用户身份、项目成员关系和细粒度 RBAC。
- 短期会话、token 轮换、撤销和速率限制。
- Secret Vault/KMS；模型、微信和部署密钥不能继续只依赖进程环境或本地设置文件。
- 审计日志防篡改、敏感字段统一脱敏和安全告警。
- TLS 终止、反向代理可信边界及 CSRF 策略。

## 4. 本地文件系统路径边界

项目工作区、Harness 工作区扫描、Cocos Bridge、QA 试玩证据/契约读取和内置静态文件服务共用同一条本地路径安全规则：

- 只接受信任根目录内的相对路径，project id 只能是单个安全路径段。
- 用 `lstat` 检查根目录以下每个已存在的组件；文件、目录和中间父路径只要是符号链接就 fail-closed。
- 对目标与最近现存父目录做 `realpath` containment 校验。
- 创建缺失父目录后重新校验，再读取、写入、rename、复制或启动静态流。
- 工作区树、模型预览、Harness snapshot 和 QA 静态服务不会跳过链接后继续读取，而是拒绝本次操作。

独立回归会构造指向根目录外的目录链接和 dangling symlink，并验证工作区写入/读取、Cocos 资产导入及 QA 契约读取均失败，外部目标字节保持不变。

这是明确的**单进程本地边界**。它防止普通配置错误、Agent 生成路径和本进程内的链接逃逸，但不宣称抵抗具有本机并发写权限的攻击者在校验与 I/O 之间反复替换目录。生产多租户部署仍需要基于目录文件描述符的 `openat`/`O_NOFOLLOW`（或等价平台原语）、隔离 worker/container 和只读挂载来关闭跨进程 TOCTOU。

## 5. 任务授权与产物血缘

模型返回的 JSON 工具请求和 Claude CLI/MCP 使用同一组授权事实：当前 Agent、当前 Workflow 可执行任务、任务输入/输出产物、不可变产物身份以及显式 service 路径。既有产物的 owner、type、path 和 sourceTask 不能由工具请求改写；普通写入只能命中当前任务声明的输出。Cocos 与 QA 服务工具在副作用前分别校验最小读写路径，不能借引擎操作覆盖其他角色源码或产物。

Claude 房间会话只暴露受控的 `read_file` 和 `list_files`；任务会话也不暴露内建 `Read`、`Glob`、`Grep`、`Bash` 或可执行项目脚本的通用工具。CLI 子进程只继承运行所需环境和当前 provider 配置，不继承无关进程密钥。失败的 Bridge 操作会记录 `failed`/`bridgeOk=false`，其报告是诊断证据，不是可消费交付物。

每次物化产物时，Artifact Ledger 会冻结 source task 的完整声明输入：artifact id、版本、登记路径、证据路径、hash、size，以及目录产物的 manifest digest。消费和审批会递归检查这些输入仍与当前登记和真实文件一致；上游契约或文件改变后，旧的源码、构建和 QA 报告不会继续通过门禁。

Cocos 构建报告包含输出目录内所有文件的规范 path/hash/size 清单和总 digest。门禁会验证文件集合、每个文件内容及清单 digest，保留报告但修改或删除 bundle 同样会使构建失效。QA v2 收据绑定当前 PlaytestContract 及 QA task 的全部输入，其中包括被测构建的 manifest digest；输入升级后必须重新构建并重新试玩。

这套 Ledger 目前仍是本地单进程事实，不是数据库事务、不可变签名或远程证明；全量目录 hash 的验证成本也是 O(n)。进入生产阶段后应把证据写入事务型存储，对大型 bundle 使用分块/Merkle 清单，并由隔离 worker 对构建和测试收据签名。

## 6. 当前验收命令

```bash
npm run typecheck
npm run verify:workflow
npm run verify:persistence
npm run verify:api-security
npm run verify:tool-authorization
npm run verify:harness-authorization
npm run verify:path-safety
npm run verify:artifact-provenance
```

架构契约和 QA/Cocos 相关验收见 `docs/19_game_scene_playtest_contracts.md`。
