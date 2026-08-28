# Task Episode 与生产证据审计

## 1. 目标

生产证据审计位于 Artifact Ledger、Claim Verifier、质量审查收据、Cocos Bridge 收据和 Workflow Aggregate 之上。它不替代任何底层证据系统，而是把一次制作目标的会话、产物、验证、决策和交接组合成可审计的完整执行单元。

系统解决四类问题：

1. Agent 做了很多动作，但无法回答这些动作是否围绕制作人的当前目标。
2. 文件存在，但无法证明是责任 Agent 通过授权工具生成的当前版本。
3. 作者、评审、QA 和门禁证据混在一起，无法保持组织独立性。
4. 发现问题后只有聊天提醒，没有责任人、复验窗口和结果对比。

## 2. Task Episode

Task Episode 是一个制作人目标和其可观察验收边界。它跨越工作阶段的讨论态和评审态：

- `concept_discussion` 与 `concept_review` 属于同一个 concept Episode。
- `production` 与 `first_playable_review` 属于同一个 first playable Episode。
- `release_preparation` 与 `release_gate` 属于同一个 release Episode。
- 部署和持续运营分别建立独立 Episode。

Episode 保存：

- 制作人目标和 `initialIdea`。
- 验收边界、任务、产物和房间引用。
- 制作人消息、Agent session 和交接 capsule 引用。
- 当前阶段、状态、开始时间、关闭时间和结果。

工作流进入下一个 Episode scope 时，前一个 Episode 被封存。审计器不能自行改变工作流阶段。

## 3. 独立 Evidence Bundle

每个 Audit Run 冻结四条证据通道：

| 通道 | 内容 | 典型缺口 |
| --- | --- | --- |
| Session | 制作人消息、room/task session、Context Health | 无目标消息、无可观察 session、session failed |
| Artifact | Task、Artifact、Artifact Ledger、Claim Verification | 输出未物化、hash/size 不匹配、开放补证任务 |
| Validation | 独立质量审查、Cocos build、QA playtest、发布检查 | 自审、收据未绑定当前 hash、QA 输出未验证 |
| Decision & Delivery | Workflow gate、制作人决策、handoff capsule、交付记录 | 评审阶段无活动门禁、交接未消费、决策不可追溯 |

每条通道只能是：

- `available`：所需证据已观察且没有明确缺口。
- `partial`：有部分事实，同时存在明确缺口。
- `unavailable`：没有可用于判断的证据。

缺失证据不会被推断成通过，也不会由 Orchestrator 用自然语言补齐。

## 4. Audit Finding

审计 Finding 由确定性规则从 Evidence Bundle 产生。当前维度包括：

- intent alignment
- controlled production
- artifact integrity
- quality validation
- delivery recoverability
- learning capture

每条 Finding 必须包含：

- 严重度和责任角色。
- 原因与证据引用。
- 预期结果。
- 修复责任边界。
- 可复验验收条件。

`critical` 和 `high` 是门禁阻塞项。审计器只读其他角色的证据，不能代替责任 Agent 写文件、修复代码、生成美术或把审查结果改成通过。

## 5. Intervention Ledger

每个阻塞 Finding 自动建立 Intervention Ledger Entry：

- baseline 保存发现窗口和证据引用。
- action 保存责任角色允许执行的修复边界。
- expectedOutcome 保存目标结果。
- stopOrRevertCondition 保存停止和回滚条件。
- comparison 保存后续复核窗口。

当同一 Finding 的触发条件不再出现时，Finding 进入 `resolved`，Intervention 进入 `outcome_supported`，并绑定新的 Audit Run 作为对比证据。没有比较窗口时不能宣称干预有效。

## 6. Audit Run 与项目资产

Audit Run 由 checkpoint、任务评审、阶段门禁、发布门禁或手动审计触发。Evidence Bundle digest 和触发引用共同形成稳定 Audit Run ID；完全相同的证据不会重复创建运行。

每个运行写入项目 Cocos 根目录：

```text
shared/audit/runs/<auditRunId>/
├── episode.json
├── evidence-bundle.json
├── findings.json
├── report.md
├── report.html
└── manifest.json
```

`manifest.json` 保存五个报告文件的 SHA-256 和字节数。已经存在的 Audit Run 文件只能以完全相同的内容重复同步；任何内容冲突都会失败，不能静默覆盖历史证据。

项目还维护当前索引：

```text
shared/audit/task-episodes.json
shared/audit/evidence-bundles.json
shared/audit/findings.json
shared/audit/intervention-ledger.json
shared/audit/audit-runs.json
shared/audit/latest.json
```

索引可以更新，运行目录不可变。

## 7. 门禁集成

阶段门禁按以下顺序执行：

1. 冻结当前 Task Episode 的 Evidence Bundle 和 Audit Run。
2. 校验 canonical artifact identity。
3. 校验独立质量审查绑定当前产物且 verdict 为 pass。
4. 校验产物路径、hash、size、source operation 和输入 provenance。
5. 需要 QA 时校验受保护 PlaytestContract 收据和报告产物。
6. 拒绝仍有 `critical/high` 开放 Finding 的 Audit Run。
7. 进入制作人风险审阅和二次确认。

Agent 说“完成”不会改变任务或门禁状态；任务、产物、审查和 Audit Run 必须分别给出真实证据。

## 8. API 与制作人界面

`GET /projects/:projectId/production-audit` 返回：

- Task Episodes
- Evidence Bundles
- Findings
- Interventions
- Audit Runs
- latest run 和 latest bundle

制作人界面的“生产审计”面板展示：

- 当前审计触发类型和阶段。
- 四条证据通道状态。
- 开放 Finding 和责任角色。
- 本地 Markdown 审计报告入口。

## 9. 对话门禁的最小干预

阶段约束仍在系统提示中，但不再无条件附加到每次普通聊天。消息处理遵循：

1. 制作人没有询问阶段推进时，Agent 直接回答专业问题，不复述门禁规则。
2. 模型正常回答原样保留。
3. 模型越权宣布阶段结束或推进时，只删除越权句，不替换整段回答。
4. 普通专业角色不重复门禁提示。
5. 只有总控在制作人明确要求推进时，补充一次当前阶段对应的简短门禁动作。

这保证了硬约束仍然成立，同时避免每个 Agent 机械地发送相同模板。

## 10. 验证

执行：

```bash
npm run verify:production-audit
```

验证覆盖：

- Task Episode 建立和封存结构。
- 四通道 Evidence Bundle。
- 阻塞 Finding 和 Intervention Ledger。
- 修复前后比较与 Finding 关闭。
- 不可变 Markdown/HTML/JSON/manifest 报告。
- 项目快照重启恢复。
- 普通回复不被改写、越权句最小删除、总控单点门禁提示。

