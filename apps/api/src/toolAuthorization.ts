import { workflowTaskStages, type StudioKernel } from "@game-pipeline/agent-runtime";
import type { AgentContract, Artifact, StudioMessage, Task, TaskId } from "@game-pipeline/shared-schemas";
import type { AgentHarnessAuthorization } from "./agentHarness.js";

export interface ToolAuthorizationRequest {
  toolName: string;
  path: string;
  artifactId?: string;
  artifactType?: Artifact["type"];
  artifactTypeExplicit?: boolean;
  requestedTaskId?: TaskId;
  access: "read" | "write";
}

export interface AuthorizedToolRequest {
  task: Task;
  sourceTaskId: TaskId;
  existing?: Artifact;
}

const controlledWriteRoots: Record<string, string[]> = {
  studio_orchestrator: ["shared/milestones", "docs/production"],
  producer: ["agents/producer", "shared/milestones", "docs/production"],
  game_designer: ["agents/design", "docs/design"],
  design_quality_reviewer: ["agents/review/design"],
  art_director: ["agents/art", "docs/art"],
  asset_production: ["agents/art/processed-assets", "agents/art/asset-manifest.json", "assets/art", "artifacts/art", "intermediate/art"],
  visual_quality_reviewer: ["agents/review/art"],
  cocos_tech_lead: ["agents/engineering", "docs/engineering", "intermediate/engineering"],
  gameplay_programmer: ["assets/scripts", "assets/resources", "docs/engineering", "intermediate/engineering"],
  cocos_automation: [
    "agents/cocos-automation",
    "assets/scenes",
    "assets/prefabs",
    "assets/scripts/btp",
    "assets/resources/btp",
    "assets/resources/btp-art",
    "settings",
    "builds",
    "shared/build-artifacts",
    "artifacts/builds",
    "intermediate/engineering"
  ],
  qa_evaluator: ["agents/qa", "docs/qa", "artifacts/qa", "outputs/qa"],
  wechat_platform: ["shared/build-artifacts", "builds", "outputs", "release/wechat", "docs/release"],
  devops: ["agents/devops", "builds", "outputs", "release/deployments", "release/rollback", "docs/release"],
  liveops_analytics: ["shared/release-notes", "docs/liveops", "release/liveops"]
};

const exclusiveWriteRoots: Array<{ root: string; agentIds: string[] }> = [
  { root: "assets/scripts/btp", agentIds: ["cocos_automation"] },
  { root: "assets/resources/btp", agentIds: ["cocos_automation"] },
  { root: "assets/resources/btp-art", agentIds: ["cocos_automation"] },
  { root: "assets/scenes", agentIds: ["cocos_automation"] },
  { root: "assets/prefabs", agentIds: ["cocos_automation"] },
  { root: "assets/scripts", agentIds: ["gameplay_programmer", "cocos_automation"] },
  { root: "assets/art", agentIds: ["asset_production"] },
  { root: "agents/design", agentIds: ["game_designer"] },
  { root: "agents/review/design", agentIds: ["design_quality_reviewer"] },
  { root: "agents/review/art", agentIds: ["visual_quality_reviewer"] },
  { root: "agents/engineering", agentIds: ["cocos_tech_lead"] },
  { root: "agents/qa", agentIds: ["qa_evaluator"] },
  { root: "agents/cocos-automation", agentIds: ["cocos_automation"] }
];

const cocosBridgeManagedWritePolicies: Array<{ roots: string[]; toolNames: string[] }> = [
  {
    roots: ["agents/cocos-automation/validation"],
    toolNames: ["cocos_validate_project"]
  },
  {
    roots: ["agents/cocos-automation/imports", "assets/resources/btp-art"],
    toolNames: ["cocos_import_assets"]
  },
  {
    roots: ["assets/resources/btp"],
    toolNames: ["cocos_import_assets", "cocos_apply_blueprint"]
  },
  {
    roots: ["agents/cocos-automation/scene-ops", "assets/scripts/btp", "assets/scenes", "assets/prefabs"],
    toolNames: ["cocos_apply_blueprint"]
  },
  {
    roots: ["agents/cocos-automation/build-ops", "agents/cocos-automation/cocos-build-logs"],
    toolNames: ["cocos_build"]
  }
];

const taskReadRoots: Record<string, string[]> = {
  studio_orchestrator: ["shared/milestones", "docs/production"],
  producer: ["agents/producer", "docs/production", "shared/milestones"],
  game_designer: ["agents/design", "docs/design"],
  design_quality_reviewer: ["agents/review/design"],
  art_director: ["agents/art", "docs/art"],
  asset_production: ["agents/art/processed-assets", "agents/art/asset-manifest.json", "assets/art"],
  visual_quality_reviewer: ["agents/review/art"],
  cocos_tech_lead: ["agents/engineering", "docs/engineering"],
  gameplay_programmer: ["assets/scripts", "docs/engineering"],
  cocos_automation: ["agents/cocos-automation"],
  qa_evaluator: ["agents/qa", "docs/qa"],
  wechat_platform: ["docs/release", "release/wechat"],
  devops: ["agents/devops", "docs/release"],
  liveops_analytics: ["docs/liveops", "release/liveops"]
};

export function createTaskHarnessAuthorization(
  kernel: StudioKernel,
  task: Task,
  agent: AgentContract,
  servicePaths: { read?: string[]; write?: string[] } = {}
): AgentHarnessAuthorization {
  if (task.ownerAgentId !== agent.agentId) {
    throw new Error(`taskId=${task.taskId} 属于 ${task.ownerAgentId}，不是当前 Agent ${agent.agentId}。`);
  }
  if (!["todo", "doing", "blocked"].includes(task.status) || !workflowTaskStages(kernel.project.currentStage).includes(task.stageId)) {
    throw new Error(`taskId=${task.taskId} 当前状态或阶段不允许启动可写 Harness。`);
  }
  const artifacts = kernel.listArtifacts();
  for (const artifactId of task.outputArtifacts) {
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact) {
      throw new Error(`任务 ${task.taskId} 的输出产物不存在：${artifactId}。`);
    }
    if (artifact.ownerAgentId !== agent.agentId || artifact.sourceTaskId !== task.taskId) {
      throw new Error(
        `任务 ${task.taskId} 的输出 ${artifactId} 身份不一致（owner=${artifact.ownerAgentId}, sourceTask=${artifact.sourceTaskId ?? "missing"}）。`
      );
    }
    assertAgentPathAuthorized(kernel, agent, task, artifact.path, "write");
  }
  for (const artifactId of task.inputArtifacts) {
    if (!artifacts.some((candidate) => candidate.artifactId === artifactId)) {
      throw new Error(`任务 ${task.taskId} 的输入产物不存在：${artifactId}。`);
    }
  }
  const referencedArtifactIds = new Set([...task.inputArtifacts, ...task.outputArtifacts]);
  return {
    mode: "task",
    taskId: task.taskId,
    inputArtifactIds: [...task.inputArtifacts],
    outputArtifactIds: [...task.outputArtifacts],
    artifacts: artifacts.filter((artifact) => referencedArtifactIds.has(artifact.artifactId)).map((artifact) => ({
      artifactId: artifact.artifactId,
      type: artifact.type,
      path: normalizeAuthorizationPath(artifact.path),
      ownerAgentId: artifact.ownerAgentId,
      ...(artifact.sourceTaskId ? { sourceTaskId: artifact.sourceTaskId } : {})
    })),
    readRoots: harnessReadRootsForAgent(agent),
    serviceReadPaths: [...new Set((servicePaths.read ?? []).map(normalizeAuthorizationPath))],
    serviceWritePaths: [...new Set((servicePaths.write ?? []).map(normalizeAuthorizationPath))]
  };
}

export function createConversationHarnessAuthorization(
  kernel: StudioKernel,
  agent: AgentContract
): AgentHarnessAuthorization {
  const readableStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const taskInputArtifactIds = new Set(
    kernel
      .listTasks()
      .filter(
        (task) =>
          task.ownerAgentId === agent.agentId &&
          task.status !== "cancelled" &&
          readableStages.has(task.stageId)
      )
      .flatMap((task) => task.inputArtifacts)
  );
  const artifacts = kernel.listArtifacts();
  const inputArtifactIds = artifacts
    .filter((artifact) => taskInputArtifactIds.has(artifact.artifactId))
    .map((artifact) => artifact.artifactId);
  const visibleArtifactIds = new Set([
    ...inputArtifactIds,
    ...artifacts.filter((artifact) => artifact.ownerAgentId === agent.agentId).map((artifact) => artifact.artifactId)
  ]);
  return {
    mode: "conversation",
    inputArtifactIds,
    outputArtifactIds: [],
    artifacts: artifacts.filter((artifact) => visibleArtifactIds.has(artifact.artifactId)).map((artifact) => ({
      artifactId: artifact.artifactId,
      type: artifact.type,
      path: normalizeAuthorizationPath(artifact.path),
      ownerAgentId: artifact.ownerAgentId,
      ...(artifact.sourceTaskId ? { sourceTaskId: artifact.sourceTaskId } : {})
    })),
    readRoots: harnessReadRootsForAgent(agent),
    serviceReadPaths: [],
    serviceWritePaths: []
  };
}

export function harnessReadRootsForAgent(agent: AgentContract): string[] {
  const workspace = normalizeAuthorizationPath(agent.workspace.replace(/\/+$/, ""));
  return [...new Set([workspace, ...(taskReadRoots[agent.agentId] ?? [])].map(normalizeAuthorizationPath))];
}

export function authorizeAgentToolRequest(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  request: ToolAuthorizationRequest
): AuthorizedToolRequest {
  const task = resolveAuthorizedTask(kernel, message, agent, request.requestedTaskId);
  const artifacts = kernel.listArtifacts();
  assertCocosBridgeManagedWriteAuthorized(task, artifacts, request);
  const byId = request.artifactId ? artifacts.find((artifact) => artifact.artifactId === request.artifactId) : undefined;
  const byPath = artifacts.find((artifact) => artifact.path === request.path);

  if (byId && byPath && byId.artifactId !== byPath.artifactId) {
    throw new Error(
      `工具请求把 artifactId=${byId.artifactId} 指向了已由 ${byPath.artifactId} 占用的路径 ${request.path}。`
    );
  }
  if (byId && byId.path !== request.path) {
    throw new Error(`既有产物 ${byId.artifactId} 的路径是 ${byId.path}，请求不得改写为 ${request.path}。`);
  }
  if (request.artifactId && byPath && byPath.artifactId !== request.artifactId) {
    throw new Error(`路径 ${request.path} 已属于 ${byPath.artifactId}，不得改挂到 ${request.artifactId}。`);
  }

  const existing = byId ?? byPath;
  if (existing) {
    if (request.access === "write" && existing.ownerAgentId !== agent.agentId) {
      throw new Error(
        `${agent.agentId} 不得覆盖 ${existing.ownerAgentId} 拥有的产物 ${existing.artifactId}（${existing.path}）。`
      );
    }
    if (request.access === "write" && request.artifactTypeExplicit && request.artifactType !== existing.type) {
      throw new Error(
        `既有产物 ${existing.artifactId} 的类型是 ${existing.type}，显式 artifactType=${request.artifactType ?? "invalid"} 不匹配。`
      );
    }
    if (request.access === "write" && existing.sourceTaskId && existing.sourceTaskId !== task.taskId) {
      throw new Error(
        `产物 ${existing.artifactId} 已绑定任务 ${existing.sourceTaskId}，当前任务 ${task.taskId} 不得跨任务改写。`
      );
    }
    const declaringTasks = kernel.listTasks().filter((candidate) => candidate.outputArtifacts.includes(existing.artifactId));
    if (request.access === "write" && declaringTasks.length > 0 && !declaringTasks.some((candidate) => candidate.taskId === task.taskId)) {
      throw new Error(`产物 ${existing.artifactId} 不是当前任务 ${task.taskId} 的输出。`);
    }
  } else if (request.access === "write" && request.artifactId && !task.outputArtifacts.includes(request.artifactId)) {
    throw new Error(`未登记的 artifactId=${request.artifactId} 不能由任务 ${task.taskId} 临时声明。`);
  }

  assertAgentPathAuthorized(kernel, agent, task, request.path, request.access);
  return {
    task,
    sourceTaskId: task.taskId,
    ...(existing ? { existing } : {})
  };
}

function assertCocosBridgeManagedWriteAuthorized(
  task: Task,
  artifacts: Artifact[],
  request: ToolAuthorizationRequest
): void {
  if (request.access !== "write") return;
  const normalized = normalizeAuthorizationPath(request.path);
  const staticPolicy = cocosBridgeManagedWritePolicies.find((policy) =>
    policy.roots.some((root) => pathMatchesRoot(normalized, root))
  );
  if (staticPolicy && !staticPolicy.toolNames.includes(request.toolName)) {
    throw new Error(
      `路径 ${normalized} 由 Cocos Bridge 管理；只能通过 ${staticPolicy.toolNames.join(" / ")} 写入，` +
      `${request.toolName} 不得直接伪造或覆盖引擎证据。`
    );
  }

  const registeredBuild = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "build" && pathMatchesArtifact(normalized, artifact));
  if (registeredBuild && request.toolName !== "cocos_build") {
    throw new Error(
      `构建路径 ${normalized} 由 Cocos Bridge 管理；只能通过 cocos_build 写入，` +
      `${request.toolName} 不得直接伪造 build report 或 bundle。`
    );
  }
}

export function assertAgentPathAuthorized(
  kernel: StudioKernel,
  agent: AgentContract,
  task: Task,
  path: string,
  access: "read" | "write"
): void {
  const normalized = normalizeAuthorizationPath(path);
  const artifacts = kernel.listArtifacts();
  const taskArtifactIds = access === "read"
    ? [...task.inputArtifacts, ...task.outputArtifacts]
    : task.outputArtifacts;
  const taskArtifacts = taskArtifactIds
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  if (taskArtifacts.some((artifact) => pathMatchesArtifact(normalized, artifact))) {
    if (access === "write" && taskArtifacts.some((artifact) => pathMatchesArtifact(normalized, artifact) && artifact.ownerAgentId !== agent.agentId)) {
      throw new Error(`${agent.agentId} 不能写入当前任务中由其他角色拥有的产物路径 ${normalized}。`);
    }
    return;
  }

  if (access === "read") {
    const ownedArtifact = artifacts.find(
      (artifact) => artifact.ownerAgentId === agent.agentId && pathMatchesArtifact(normalized, artifact)
    );
    if (ownedArtifact || authorizedWriteRootsForAgent(agent).some((root) => pathMatchesRoot(normalized, root))) {
      return;
    }
    throw new Error(`${agent.agentId} 没有读取路径 ${normalized} 的任务输入或工作区权限。`);
  }

  const exclusive = exclusiveWriteRoots.find((entry) => pathMatchesRoot(normalized, entry.root));
  if (exclusive && !exclusive.agentIds.includes(agent.agentId)) {
    throw new Error(`路径 ${normalized} 属于受控角色域 ${exclusive.root}，${agent.agentId} 没有写入权限。`);
  }
  if (!authorizedWriteRootsForAgent(agent).some((root) => pathMatchesRoot(normalized, root))) {
    throw new Error(`${agent.agentId} 没有写入路径 ${normalized} 的权限；允许根目录由 AgentContract.workspace 和受控引擎目录决定。`);
  }
}

export function normalizeAuthorizationPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/{2,}/g, "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes("://") ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(`不安全的工具路径：${path}`);
  }
  return normalized;
}

function resolveAuthorizedTask(
  kernel: StudioKernel,
  message: StudioMessage,
  agent: AgentContract,
  requestedTaskId?: TaskId
): Task {
  let task: Task | undefined;
  if (requestedTaskId) {
    task = kernel.findTask(requestedTaskId);
    if (!task) {
      throw new Error(`工具请求引用了不存在的 taskId=${requestedTaskId}。`);
    }
    if (message.relatedTaskIds.length > 0 && !message.relatedTaskIds.includes(requestedTaskId)) {
      throw new Error(`工具请求 taskId=${requestedTaskId} 与消息任务上下文不一致。`);
    }
  } else if (message.relatedTaskIds.length > 0) {
    const related = message.relatedTaskIds.map((taskId) => kernel.findTask(taskId));
    if (related.some((candidate) => !candidate)) {
      throw new Error("工具消息引用了不存在的任务。 ");
    }
    const owned = related.filter((candidate): candidate is Task => candidate?.ownerAgentId === agent.agentId);
    if (owned.length !== 1) {
      throw new Error(`${agent.agentId} 的工具消息必须关联且只关联一个自己负责的任务。`);
    }
    task = owned[0];
  } else {
    const activeStages = new Set(workflowTaskStages(kernel.project.currentStage));
    const candidates = kernel.listTasks().filter(
      (candidate) =>
        candidate.ownerAgentId === agent.agentId &&
        activeStages.has(candidate.stageId) &&
        ["todo", "doing", "blocked"].includes(candidate.status)
    );
    if (candidates.length !== 1) {
      throw new Error(
        `${agent.agentId} 的工具请求缺少可唯一确定的 taskId；当前候选任务数=${candidates.length}。`
      );
    }
    task = candidates[0];
  }

  if (!task) {
    throw new Error(`${agent.agentId} 的工具请求无法解析到有效任务。`);
  }
  if (task.ownerAgentId !== agent.agentId) {
    throw new Error(`taskId=${task.taskId} 属于 ${task.ownerAgentId}，不是当前 Agent ${agent.agentId}。`);
  }
  if (!["todo", "doing", "blocked"].includes(task.status)) {
    throw new Error(`taskId=${task.taskId} 当前状态 ${task.status} 不允许继续写入产物。`);
  }
  const activeStages = new Set(workflowTaskStages(kernel.project.currentStage));
  if (!activeStages.has(task.stageId)) {
    throw new Error(`taskId=${task.taskId} 不属于当前 Workflow 可执行阶段。`);
  }
  return task;
}

export function authorizedWriteRootsForAgent(agent: AgentContract): string[] {
  const workspace = normalizeAuthorizationPath(agent.workspace.replace(/\/+$/, ""));
  return [...new Set([workspace, ...(controlledWriteRoots[agent.agentId] ?? [])])];
}

function pathMatchesArtifact(path: string, artifact: Artifact): boolean {
  const artifactPath = artifact.path.replaceAll("\\", "/").replace(/\/+$/, "");
  return path === artifactPath || path.startsWith(`${artifactPath}/`);
}

function pathMatchesRoot(path: string, root: string): boolean {
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}
