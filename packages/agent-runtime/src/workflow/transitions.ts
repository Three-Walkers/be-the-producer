import type { WorkflowReviewStage, WorkflowStage } from "./types.js";

const transitions: Record<WorkflowStage, readonly WorkflowStage[]> = {
  concept_discussion: ["concept_review"],
  concept_review: ["production", "concept_discussion"],
  production: ["first_playable_review"],
  first_playable_review: ["release_preparation", "production"],
  release_preparation: ["release_gate"],
  release_gate: ["production_deploy", "production"],
  production_deploy: ["liveops", "release_preparation"],
  liveops: ["production"]
};

export const WORKFLOW_STAGE_TRANSITIONS: Readonly<Record<WorkflowStage, readonly WorkflowStage[]>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(transitions).map(([stage, targets]) => [stage, Object.freeze([...targets])])
    )
  ) as Readonly<Record<WorkflowStage, readonly WorkflowStage[]>>;

export const REVIEW_ENTRY_STAGE: Readonly<
  Partial<Record<WorkflowStage, WorkflowReviewStage>>
> = Object.freeze({
  concept_discussion: "concept_review",
  production: "first_playable_review",
  release_preparation: "release_gate"
});

/**
 * Review is a workflow state, not a separate production lane. While a gate is
 * open, unfinished work from its source stage may still resolve review
 * blockers; the producer decision remains the only way to leave the gate.
 */
export const REVIEW_SOURCE_STAGE: Readonly<Record<WorkflowReviewStage, WorkflowStage>> = Object.freeze({
  concept_review: "concept_discussion",
  first_playable_review: "production",
  release_gate: "release_preparation"
});

export const REVIEW_APPROVAL_TARGET: Readonly<Record<WorkflowReviewStage, WorkflowStage>> = Object.freeze({
  concept_review: "production",
  first_playable_review: "release_preparation",
  release_gate: "production_deploy"
});

export const REVIEW_REWORK_TARGET: Readonly<Record<WorkflowReviewStage, WorkflowStage>> = Object.freeze({
  concept_review: "concept_discussion",
  first_playable_review: "production",
  release_gate: "production"
});

export function isWorkflowStage(value: string): value is WorkflowStage {
  return Object.hasOwn(WORKFLOW_STAGE_TRANSITIONS, value);
}

export function isReviewStage(stage: WorkflowStage): stage is WorkflowReviewStage {
  return stage === "concept_review" || stage === "first_playable_review" || stage === "release_gate";
}

export function workflowTaskStages(stage: WorkflowStage): readonly WorkflowStage[] {
  return isReviewStage(stage) ? [REVIEW_SOURCE_STAGE[stage], stage] : [stage];
}

export function canTransitionWorkflowStage(fromStage: WorkflowStage, toStage: WorkflowStage): boolean {
  return WORKFLOW_STAGE_TRANSITIONS[fromStage].includes(toStage);
}
