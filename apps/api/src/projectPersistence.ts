import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createStudioKernelFromSnapshot, type StudioKernel, type StudioKernelSnapshot } from "@game-pipeline/agent-runtime";

export interface ProjectSummary {
  projectId: string;
  name: string;
  currentStage: string;
  status: string;
  executionStatus?: string;
  agentLoopStatus?: string;
  agentLoopWaitingReason?: string;
  initialIdea?: string;
  createdAt: string;
  updatedAt: string;
  savedAt: string;
}

export class ProjectPersistenceStore {
  constructor(private readonly dataRoot = defaultDataRoot()) {}

  loadAll(): StudioKernel[] {
    if (!existsSync(this.dataRoot)) {
      return [];
    }

    return readdirSync(this.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.load(entry.name))
      .filter((kernel): kernel is StudioKernel => Boolean(kernel));
  }

  listSummaries(): ProjectSummary[] {
    if (!existsSync(this.dataRoot)) {
      return [];
    }

    return readdirSync(this.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.loadSnapshot(entry.name))
      .filter((snapshot): snapshot is StudioKernelSnapshot => Boolean(snapshot))
      .map((snapshot) => {
        return {
          projectId: snapshot.project.projectId,
          name: snapshot.project.name,
          currentStage: snapshot.project.currentStage,
          status: snapshot.project.status,
          ...(snapshot.project.executionStatus ? { executionStatus: snapshot.project.executionStatus } : {}),
          ...(snapshot.agentLoop?.status ? { agentLoopStatus: snapshot.agentLoop.status } : {}),
          ...(snapshot.agentLoop?.waitingReason ? { agentLoopWaitingReason: snapshot.agentLoop.waitingReason } : {}),
          ...(snapshot.project.initialIdea ? { initialIdea: snapshot.project.initialIdea } : {}),
          createdAt: snapshot.project.createdAt,
          updatedAt: snapshot.project.updatedAt,
          savedAt: snapshot.savedAt
        };
      })
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  save(kernel: StudioKernel): StudioKernelSnapshot {
    const snapshot = kernel.toSnapshot();
    const path = this.snapshotPath(kernel.project.projectId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    return snapshot;
  }

  load(projectId: string): StudioKernel | undefined {
    const snapshot = this.loadSnapshot(projectId);
    if (!snapshot) {
      return undefined;
    }

    return createStudioKernelFromSnapshot(snapshot);
  }

  delete(projectId: string): void {
    rmSync(join(this.dataRoot, projectId), {
      recursive: true,
      force: true
    });
  }

  private loadSnapshot(projectId: string): StudioKernelSnapshot | undefined {
    const path = this.snapshotPath(projectId);
    if (!existsSync(path)) {
      return undefined;
    }

    return JSON.parse(readFileSync(path, "utf8")) as StudioKernelSnapshot;
  }

  private snapshotPath(projectId: string): string {
    return join(this.dataRoot, projectId, "studio-state.json");
  }
}

function defaultDataRoot(): string {
  return process.env.GAME_PIPELINE_DATA_ROOT ?? join(process.env.INIT_CWD ?? process.cwd(), ".local", "projects");
}
