import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import type { Artifact, MemoryRecord, StudioMessage, Task } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";

export interface WorkspaceSyncResult {
  projectRoot: string;
  filesWritten: string[];
}

export interface WorkspaceTreeEntry {
  path: string;
  type: "file" | "directory";
  sizeBytes?: number;
  updatedAt?: string;
}

const defaultWorkspaceRoot = (): string =>
  process.env.STUDIO_WORKSPACE_ROOT ?? join(process.env.INIT_CWD ?? process.cwd(), "studio", "projects");

export function syncProjectWorkspace(kernel: StudioKernel, workspaceRoot = defaultWorkspaceRoot()): WorkspaceSyncResult {
  const projectRoot = join(workspaceRoot, kernel.project.projectId);
  const filesWritten: string[] = [];
  const taskBoard = kernel.buildTaskBoard();
  const messages = kernel.listMessages();
  const tasks = kernel.listTasks();
  const artifacts = kernel.listArtifacts();
  const memory = kernel.memory.query({
    projectId: kernel.project.projectId,
    status: ["active", "draft", "superseded", "rejected", "archived"]
  });

  mkdirSync(projectRoot, { recursive: true });
  writeJson(projectRoot, "shared/milestones/project.json", kernel.project, filesWritten);
  writeJson(projectRoot, "shared/task-board/current-status.json", taskBoard, filesWritten);
  writeJson(projectRoot, "shared/tasks/tasks.json", tasks, filesWritten);
  writeJson(projectRoot, "shared/artifacts/artifacts.json", artifacts, filesWritten);
  writeJson(projectRoot, "shared/audit/audit-events.json", kernel.listAuditEvents(), filesWritten);
  writeJson(projectRoot, "shared/chat/messages.json", messages, filesWritten);
  writeJsonLines(projectRoot, "shared/memory/project-memory.jsonl", memory, filesWritten);
  writeText(projectRoot, "README.md", renderProjectReadme(kernel, taskBoard.total, artifacts.length, memory.length), filesWritten);

  for (const agent of kernel.agents.list()) {
    writeText(projectRoot, join(agent.workspace, "workspace-summary.md"), renderAgentSummary(agent.agentId, tasks, artifacts, messages, memory), filesWritten);
  }

  for (const artifact of artifacts) {
    writeArtifactFile(projectRoot, artifact, tasks, memory, filesWritten);
  }

  return {
    projectRoot,
    filesWritten
  };
}

export function readWorkspaceTree(projectId: string, workspaceRoot = defaultWorkspaceRoot()): {
  projectRoot: string;
  entries: WorkspaceTreeEntry[];
} {
  const projectRoot = join(workspaceRoot, projectId);
  if (!existsSync(projectRoot)) {
    return {
      projectRoot,
      entries: []
    };
  }

  return {
    projectRoot,
    entries: listWorkspaceEntries(projectRoot, projectRoot)
  };
}

export function deleteProjectWorkspace(projectId: string, workspaceRoot = defaultWorkspaceRoot()): void {
  rmSync(join(workspaceRoot, projectId), {
    recursive: true,
    force: true
  });
}

function listWorkspaceEntries(root: string, current: string): WorkspaceTreeEntry[] {
  const entries: WorkspaceTreeEntry[] = [];
  for (const name of readdirSync(current).sort()) {
    if (name === "secrets") {
      continue;
    }

    const absolutePath = join(current, name);
    const stats = statSync(absolutePath);
    const entryPath = relative(root, absolutePath).split(sep).join("/");
    if (stats.isDirectory()) {
      entries.push({
        path: entryPath,
        type: "directory",
        updatedAt: stats.mtime.toISOString()
      });
      entries.push(...listWorkspaceEntries(root, absolutePath));
      continue;
    }

    entries.push({
      path: entryPath,
      type: "file",
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString()
    });
  }
  return entries;
}

function writeJson(projectRoot: string, path: string, value: unknown, filesWritten: string[]): void {
  writeText(projectRoot, path, `${JSON.stringify(value, null, 2)}\n`, filesWritten);
}

function writeJsonLines(projectRoot: string, path: string, records: MemoryRecord[], filesWritten: string[]): void {
  writeText(projectRoot, path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, filesWritten);
}

function writeText(projectRoot: string, path: string, content: string, filesWritten: string[]): void {
  const safePath = normalize(path);
  if (safePath.startsWith("..") || safePath.includes(`${sep}..${sep}`)) {
    throw new Error(`Unsafe workspace path: ${path}`);
  }

  const absolutePath = join(projectRoot, safePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  filesWritten.push(relative(projectRoot, absolutePath).split(sep).join("/"));
}

function writeArtifactFile(
  projectRoot: string,
  artifact: Artifact,
  tasks: Task[],
  memory: MemoryRecord[],
  filesWritten: string[]
): void {
  const targetPath = artifactFilePath(artifact);
  const sourceTask = artifact.sourceTaskId ? tasks.find((task) => task.taskId === artifact.sourceTaskId) : undefined;
  const sourceMemory = memory.filter((record) => record.sourceArtifactId === artifact.artifactId || record.ownerAgent === artifact.ownerAgentId);

  if (targetPath.endsWith(".json")) {
    writeJson(
      projectRoot,
      targetPath,
      {
        artifact,
        sourceTask,
        relatedMemory: sourceMemory
      },
      filesWritten
    );
    return;
  }

  writeText(projectRoot, targetPath, renderArtifactMarkdown(artifact, sourceTask, sourceMemory), filesWritten);
}

function artifactFilePath(artifact: Artifact): string {
  const extension = extname(artifact.path);
  if (extension) {
    return artifact.path;
  }

  if (artifact.type === "build") {
    return join(artifact.path, "build-report.json");
  }

  return join(artifact.path, "README.md");
}

function renderProjectReadme(kernel: StudioKernel, totalTasks: number, totalArtifacts: number, totalMemory: number): string {
  return `# ${kernel.project.name}

Project ID: ${kernel.project.projectId}

Current stage: ${kernel.project.currentStage}

This workspace is generated by Game Pipeline Agents. It is the white-box record for producer decisions, agent workspaces, task state, artifacts, memory, and audit events.

## Snapshot

- Tasks: ${totalTasks}
- Artifacts: ${totalArtifacts}
- Memory records: ${totalMemory}

## Key Files

- shared/task-board/current-status.json
- shared/chat/messages.json
- shared/audit/audit-events.json
- shared/memory/project-memory.jsonl
- shared/artifacts/artifacts.json
`;
}

function renderAgentSummary(
  agentId: string,
  tasks: Task[],
  artifacts: Artifact[],
  messages: StudioMessage[],
  memory: MemoryRecord[]
): string {
  const ownedTasks = tasks.filter((task) => task.ownerAgentId === agentId);
  const ownedArtifacts = artifacts.filter((artifact) => artifact.ownerAgentId === agentId);
  const agentMessages = messages.filter((message) => message.senderId === agentId);
  const agentMemory = memory.filter((record) => record.ownerAgent === agentId);

  return `# ${agentId} Workspace

## Tasks

${renderTaskList(ownedTasks)}

## Artifacts

${renderArtifactList(ownedArtifacts)}

## Recent Messages

${renderMessageList(agentMessages.slice(-10))}

## Memory

${agentMemory.map((record) => `- ${record.type} [${record.status}]: ${record.content}`).join("\n") || "- No memory records yet."}
`;
}

function renderArtifactMarkdown(artifact: Artifact, sourceTask: Task | undefined, sourceMemory: MemoryRecord[]): string {
  return `# ${artifact.artifactId}

Type: ${artifact.type}

Owner: ${artifact.ownerAgentId}

Stage: ${artifact.stageId}

Status: ${artifact.status}

Version: ${artifact.version}

## Source Task

${sourceTask ? `- ${sourceTask.title} [${sourceTask.status}]` : "- No source task recorded."}

## Metadata

\`\`\`json
${JSON.stringify(artifact.metadata, null, 2)}
\`\`\`

## Related Memory

${sourceMemory.map((record) => `- ${record.type} [${record.status}]: ${record.content}`).join("\n") || "- No related memory records."}
`;
}

function renderTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "- No tasks assigned yet.";
  }

  return tasks.map((task) => `- ${task.title} [${task.status}] (${task.taskId})`).join("\n");
}

function renderArtifactList(artifacts: Artifact[]): string {
  if (artifacts.length === 0) {
    return "- No artifacts owned yet.";
  }

  return artifacts.map((artifact) => `- ${artifact.artifactId} [${artifact.status}] -> ${artifact.path}`).join("\n");
}

function renderMessageList(messages: StudioMessage[]): string {
  if (messages.length === 0) {
    return "- No messages sent yet.";
  }

  return messages.map((message) => `- ${message.createdAt} ${message.messageType}: ${message.content}`).join("\n");
}
