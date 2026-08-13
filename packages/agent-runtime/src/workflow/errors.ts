import type { WorkflowStage } from "./types.js";

export type WorkflowErrorCode =
  | "WORKFLOW_INVALID_COMMAND"
  | "WORKFLOW_REVISION_CONFLICT"
  | "WORKFLOW_IDEMPOTENCY_CONFLICT"
  | "WORKFLOW_ILLEGAL_TRANSITION"
  | "WORKFLOW_FORBIDDEN"
  | "WORKFLOW_NOT_FOUND"
  | "WORKFLOW_INVARIANT_VIOLATION";

export class WorkflowDomainError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowDomainError";
    this.code = code;
  }
}

export class WorkflowRevisionConflictError extends WorkflowDomainError {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      "WORKFLOW_REVISION_CONFLICT",
      `Workflow revision conflict: expected ${expectedRevision}, actual ${actualRevision}.`
    );
    this.name = "WorkflowRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkflowIdempotencyConflictError extends WorkflowDomainError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      "WORKFLOW_IDEMPOTENCY_CONFLICT",
      `Idempotency key '${idempotencyKey}' was already used for a different workflow command.`
    );
    this.name = "WorkflowIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

export class IllegalWorkflowStageTransitionError extends WorkflowDomainError {
  readonly fromStage: WorkflowStage;
  readonly toStage: WorkflowStage;

  constructor(fromStage: WorkflowStage, toStage: WorkflowStage, detail?: string) {
    super(
      "WORKFLOW_ILLEGAL_TRANSITION",
      `Illegal workflow transition from '${fromStage}' to '${toStage}'${detail ? `: ${detail}` : "."}`
    );
    this.name = "IllegalWorkflowStageTransitionError";
    this.fromStage = fromStage;
    this.toStage = toStage;
  }
}
