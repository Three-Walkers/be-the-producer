# 14. 数据模型、存储与事件结构

## 1. 存储分层

| 层 | 存储内容 | 技术形态 |
| --- | --- | --- |
| 关系数据库 | Project、Room、Message、Task、TaskGroup、Decision、Artifact、Memory、AuditEvent 元数据。 | PostgreSQL |
| 文件工作区 | GDD、Art Bible、QA 报告、部署报告、角色 summary。 | 本地文件系统或对象存储挂载 |
| 对象存储 | 图片、视频、构建包、录屏。 | S3 兼容对象存储 |
| 向量索引 | 文档片段、历史报告、知识记忆。 | pgvector 或独立向量库 |
| Secret Vault | 模型 key、服务器凭据、上传凭据。 | Vault / KMS / 加密数据库 |

## 2. Project 表

```sql
create table projects (
  project_id text primary key,
  name text not null,
  status text not null,
  current_stage text not null,
  producer_id text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

## 3. Rooms 表

```sql
create table rooms (
  room_id text primary key,
  project_id text not null references projects(project_id),
  name text not null,
  room_type text not null,
  stage_scope text,
  routing_policy jsonb not null,
  created_at timestamptz not null
);
```

## 4. Messages 表

```sql
create table messages (
  message_id text primary key,
  project_id text not null references projects(project_id),
  room_id text not null references rooms(room_id),
  sender_type text not null,
  sender_id text not null,
  message_type text not null,
  content text not null,
  mentions jsonb not null default '[]',
  related_task_ids jsonb not null default '[]',
  related_artifact_ids jsonb not null default '[]',
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);
```

## 5. Tasks 表

```sql
create table tasks (
  task_id text primary key,
  project_id text not null references projects(project_id),
  stage_id text not null,
  room_id text,
  parent_task_id text references tasks(task_id),
  task_level text not null,
  owner_agent_id text not null,
  title text not null,
  description text not null,
  status text not null,
  priority integer not null default 50,
  sort_order integer not null default 0,
  progress_percent integer,
  children_summary jsonb not null default '{}',
  input_artifacts jsonb not null default '[]',
  output_artifacts jsonb not null default '[]',
  acceptance_criteria jsonb not null default '[]',
  blockers jsonb not null default '[]',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

任务层级字段：

```text
task_level = task_group | task | subtask
parent_task_id = null 或父级 task_id
children_summary = {"doing":0,"blocked":0,"todo":0,"done":0,"cancelled":0}
```

任务状态索引：

```sql
create index idx_tasks_project_status on tasks(project_id, status);
create index idx_tasks_parent on tasks(parent_task_id);
create index idx_tasks_workspace_order on tasks(project_id, stage_id, task_level, sort_order);
```

## 6. Task Status Snapshots 表

Workspace Task Board 使用快照表快速渲染大任务和子任务状态。

```sql
create table task_status_snapshots (
  snapshot_id text primary key,
  project_id text not null references projects(project_id),
  room_id text,
  stage_id text,
  scope text not null,
  total_count integer not null,
  doing_count integer not null,
  blocked_count integer not null,
  todo_count integer not null,
  done_count integer not null,
  cancelled_count integer not null,
  payload jsonb not null,
  created_at timestamptz not null
);
```

`scope` 取值：

```text
project
stage
room
agent
```

## 7. Decisions 表

```sql
create table decisions (
  decision_id text primary key,
  project_id text not null references projects(project_id),
  stage_id text not null,
  producer_id text not null,
  decision_type text not null,
  verdict text not null,
  content text not null,
  affected_tasks jsonb not null default '[]',
  affected_artifacts jsonb not null default '[]',
  supersedes text,
  created_at timestamptz not null
);
```

## 8. Artifacts 表

```sql
create table artifacts (
  artifact_id text primary key,
  project_id text not null references projects(project_id),
  type text not null,
  path text not null,
  owner_agent_id text not null,
  stage_id text not null,
  status text not null,
  version integer not null,
  source_task_id text,
  source_decision_ids jsonb not null default '[]',
  checksum text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

## 9. Memory 表

```sql
create table memories (
  memory_id text primary key,
  project_id text not null references projects(project_id),
  stage_id text,
  scope text not null,
  owner_agent text,
  type text not null,
  status text not null,
  content text not null,
  source_message_id text,
  source_event_id text,
  source_artifact_id text,
  supersedes text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
```

## 10. Audit Events 表

```sql
create table audit_events (
  event_id text primary key,
  project_id text not null,
  stage_id text,
  agent_id text,
  task_id text,
  event_type text not null,
  input_artifacts jsonb not null default '[]',
  output_artifacts jsonb not null default '[]',
  tool_calls jsonb not null default '[]',
  decision_refs jsonb not null default '[]',
  status text not null,
  failure_reason text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null
);
```

## 11. Invocation 表

```sql
create table invocations (
  invocation_id text primary key,
  project_id text not null,
  room_id text not null,
  agent_id text not null,
  source_message_id text,
  status text not null,
  priority integer not null default 50,
  idempotency_key text not null unique,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null
);
```

## 12. Workspace Task Board 查询

项目级任务状态：

```sql
select status, count(*)
from tasks
where project_id = $1
  and task_level in ('task', 'subtask')
group by status;
```

大任务树：

```sql
select *
from tasks
where project_id = $1
  and (task_level = 'task_group' or parent_task_id is not null)
order by stage_id, sort_order;
```

角色任务：

```sql
select *
from tasks
where project_id = $1
  and owner_agent_id = $2
  and status in ('todo', 'doing', 'review', 'blocked')
order by priority desc, updated_at desc;
```

## 13. 数据一致性

一致性规则：

- 文件写入成功后注册 Artifact。
- Artifact 注册失败时任务不能标记 done。
- 子任务状态变化后必须重新计算父任务 `children_summary` 和 `progress_percent`。
- 大任务状态变化后必须生成 `TASK_STATUS_SNAPSHOT_CREATED` 审计事件。
- Workspace Task Board 快照失败时不影响任务写入，但必须进入重试队列。
- 阶段门禁只读取 Artifact Registry，不扫描裸文件。
- AuditEvent 写入失败时关键操作失败。
- Secret 写入和读取必须产生审计事件。

## 14. 文件路径规范

文件路径必须相对项目工作区：

```text
agents/design/gdd/01_core_loop.md
agents/art/art-bible.md
agents/qa/playtest-reports/report_001.md
shared/build-artifacts/wechat/release/
```

禁止存储绝对本机路径到数据库业务字段。绝对路径只允许出现在本地运行时配置。

## 15. 事件命名

事件类型：

```text
PROJECT_CREATED
ROOM_CREATED
MESSAGE_POSTED
AGENT_INVOKED
AGENT_RESPONDED
TASK_CREATED
TASK_UPDATED
SUBTASK_CREATED
TASK_STATUS_CHANGED
TASK_STATUS_SNAPSHOT_CREATED
DECISION_MADE
ARTIFACT_CREATED
MEMORY_WRITTEN
MODEL_INVOKED
TOOL_STARTED
TOOL_COMPLETED
COCOS_BUILD_STARTED
COCOS_BUILD_COMPLETED
QA_REPORT_CREATED
RELEASE_GATE_COMPLETED
SECRET_WRITTEN
DEPLOYMENT_STARTED
DEPLOYMENT_COMPLETED
```

## 16. 数据删除

删除策略：

- 业务记录软删除。
- Artifact 删除写 tombstone。
- AuditEvent append-only，不删除。
- Secret 删除执行 revoke。
- 构建包按保留策略归档。

## 17. 查询视图

产品界面使用聚合视图：

- 项目阶段视图。
- Agent 工作区视图。
- Workspace Task Board 视图。
- 大任务和子任务树视图。
- 制作人决策视图。
- 产物血缘视图。
- QA 门禁视图。
- 发布视图。
- 成本和调用视图。
