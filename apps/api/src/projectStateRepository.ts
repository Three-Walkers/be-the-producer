import type { StudioKernel, StudioKernelSnapshot } from "@game-pipeline/agent-runtime";

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

/**
 * Persistence port for project state.
 *
 * The current adapter is a local filesystem store. Keeping callers behind this
 * port lets a durable database-backed adapter replace it without changing the
 * studio orchestration API.
 */
export interface ProjectStateRepository {
  loadAll(): StudioKernel[];
  listSummaries(): ProjectSummary[];
  save(kernel: StudioKernel): StudioKernelSnapshot;
  load(projectId: string): StudioKernel | undefined;
  delete(projectId: string): void;
}
