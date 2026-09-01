export class AgentWorkerQueueTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Agent Worker 等待执行槽超过 ${Math.round(timeoutMs / 1_000)} 秒。`);
    this.name = "AgentWorkerQueueTimeoutError";
  }
}

export class AgentWorkerQueueCancelledError extends Error {
  constructor() {
    super("Agent Worker 在排队期间因项目暂停、切换或任务取消而终止。");
    this.name = "AgentWorkerQueueCancelledError";
  }
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  abortSignal?: AbortSignal;
  abort?: () => void;
  settled: boolean;
}

export interface AgentExecutionPoolOptions {
  concurrency?: number;
}

export interface AgentExecutionRequest {
  abortSignal?: AbortSignal;
  queueTimeoutMs?: number;
}

export class AgentExecutionPool {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  readonly concurrency: number;

  constructor(options: AgentExecutionPoolOptions = {}) {
    this.concurrency = normalizeConcurrency(options.concurrency ?? configuredConcurrency());
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.queue.filter((entry) => !entry.settled).length;
  }

  async run<T>(request: AgentExecutionRequest, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(request);
    try {
      return await work();
    } finally {
      release();
    }
  }

  private acquire(request: AgentExecutionRequest): Promise<() => void> {
    if (request.abortSignal?.aborted) {
      return Promise.reject(new AgentWorkerQueueCancelledError());
    }
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, settled: false };
      const timeoutMs = normalizeQueueTimeout(request.queueTimeoutMs);
      if (timeoutMs !== undefined) {
        entry.timeout = setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          this.detach(entry);
          reject(new AgentWorkerQueueTimeoutError(timeoutMs));
        }, timeoutMs);
      }
      if (request.abortSignal) {
        entry.abortSignal = request.abortSignal;
        entry.abort = () => {
          if (entry.settled) return;
          entry.settled = true;
          this.detach(entry);
          reject(new AgentWorkerQueueCancelledError());
        };
        request.abortSignal.addEventListener("abort", entry.abort, { once: true });
      }
      this.queue.push(entry);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.settled) continue;
      entry.settled = true;
      this.detach(entry);
      this.active += 1;
      entry.resolve(this.createRelease());
    }
  }

  private detach(entry: QueueEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    if (entry.abortSignal && entry.abort) {
      entry.abortSignal.removeEventListener("abort", entry.abort);
    }
  }
}

export const agentExecutionPool = new AgentExecutionPool();

function configuredConcurrency(): number {
  const parsed = Number(process.env.BTP_AGENT_WORKER_CONCURRENCY);
  return Number.isFinite(parsed) ? parsed : 4;
}

function normalizeConcurrency(value: number): number {
  return Math.max(1, Math.min(32, Math.round(value)));
}

function normalizeQueueTimeout(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(10, Math.round(value));
}
