import assert from "node:assert/strict";
import {
  QualityReviewValidationError,
  assertQualityReview,
  parseArtifactQualityReview,
  parseQualityReview,
  validateArtifactQualityReview,
  validateQualityReview,
} from "../packages/shared-schemas/dist/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function passingFixture() {
  return {
    schemaVersion: "1.0.0",
    kind: "artifact_quality_review",
    reviewId: "review.design.baseline.v1",
    domain: "design",
    reviewerAgentId: "design_reviewer",
    targets: [
      {
        artifactId: "artifact_gdd_baseline",
        version: 3,
        path: "agents/design/gdd-baseline-v0.3.md",
        ledgerHash: HASH_A,
        sizeBytes: 4096,
      },
      {
        artifactId: "artifact_game_contract",
        version: 1,
        path: "agents/design/contracts/game-contract.json",
        ledgerHash: HASH_B,
        sizeBytes: 2048,
      },
    ],
    rubric: {
      rubricId: "rubric.design.baseline",
      version: "1.2.0",
      passThreshold: 85,
    },
    criteria: [
      {
        criterionId: "core_loop",
        label: "Core loop clarity and testability",
        weight: 60,
        score: 90,
        status: "pass",
        findings: [],
      },
      {
        criterionId: "contract_alignment",
        label: "GDD and GameContract alignment",
        weight: 40,
        score: 80,
        status: "pass",
        findings: [
          {
            issueCode: "design.naming_consistency",
            severity: "minor",
            summary: "One public signal uses a less precise label than the GDD.",
            evidenceRefs: ["artifact_game_contract#runtimeSignals.progress"],
          },
        ],
      },
    ],
    scoreTotal: 86,
    verdict: "pass",
    requiredChanges: [],
    risks: [
      {
        riskId: "risk.tutorial_discovery",
        severity: "minor",
        summary: "First-time players may need an extra affordance during usability testing.",
        evidenceRefs: ["artifact_gdd_baseline#onboarding"],
      },
    ],
    blockingIssueCodes: [],
    modelTrace: {
      providerId: "dashscope",
      model: "qwen3.7-plus",
      invocationId: "inv_quality_review_001",
      promptVersion: "1.0.0",
    },
    reviewedAt: "2026-08-15T12:00:00.000Z",
  };
}

function expectIssue(value, code, pathPart) {
  const result = validateQualityReview(value);
  assert.equal(result.ok, false, `expected ${code} for ${pathPart}`);
  assert.ok(
    !result.ok && result.issues.some((entry) => entry.code === code && entry.path.includes(pathPart)),
    `expected ${code} at ${pathPart}; received ${!result.ok ? JSON.stringify(result.issues) : "valid"}`,
  );
}

const passing = passingFixture();
assert.deepEqual(parseQualityReview(passing), passing);
assert.deepEqual(parseArtifactQualityReview(passing), passing);
assert.equal(validateArtifactQualityReview(passing).ok, true);
assert.doesNotThrow(() => assertQualityReview(passing));

const requested = structuredClone(passing);
requested.criteria[0].score = 60;
requested.criteria[0].status = "change_requested";
requested.criteria[0].findings = [{
  issueCode: "design.core_loop_unclear",
  severity: "major",
  summary: "The failure/recovery loop has no measurable player-facing feedback.",
  evidenceRefs: ["artifact_gdd_baseline#core-loop.failure"],
}];
requested.scoreTotal = 68;
requested.verdict = "change_requested";
requested.requiredChanges = [{
  issueCode: "design.core_loop_unclear",
  summary: "Specify recovery feedback and its observable runtime signal.",
  acceptanceCriteria: ["GDD and GameContract identify the same public recovery signal."],
  evidenceRefs: ["artifact_gdd_baseline#core-loop.failure", "artifact_game_contract#runtimeSignals"],
}];
assert.equal(validateQualityReview(requested).ok, true, "a grounded change request should validate");

const blocked = structuredClone(requested);
blocked.verdict = "blocked";
blocked.criteria[0].status = "blocked";
blocked.blockingIssueCodes = ["design.core_loop_unclear"];
assert.equal(validateQualityReview(blocked).ok, true, "a blocked review must name a known issue code");

const unknownTopLevel = structuredClone(passing);
unknownTopLevel.reviewrAgentId = "typo";
expectIssue(unknownTopLevel, "unknown_property", "reviewrAgentId");

const unknownNested = structuredClone(passing);
unknownNested.criteria[0].weigth = 60;
expectIssue(unknownNested, "unknown_property", "weigth");

const duplicateTarget = structuredClone(passing);
duplicateTarget.targets[1].artifactId = duplicateTarget.targets[0].artifactId;
expectIssue(duplicateTarget, "duplicate_id", "targets[1].artifactId");

const duplicateCriterion = structuredClone(passing);
duplicateCriterion.criteria[1].criterionId = duplicateCriterion.criteria[0].criterionId;
expectIssue(duplicateCriterion, "duplicate_id", "criteria[1].criterionId");

const duplicateIssue = structuredClone(requested);
duplicateIssue.criteria[1].findings.push({
  issueCode: "design.core_loop_unclear",
  severity: "minor",
  summary: "Duplicate issue code must not create ambiguous references.",
  evidenceRefs: ["artifact_game_contract#coreLoop"],
});
expectIssue(duplicateIssue, "duplicate_id", "issueCode");

const badWeights = structuredClone(passing);
badWeights.criteria[1].weight = 39;
expectIssue(badWeights, "inconsistent_score", "criteria");

const badTotal = structuredClone(passing);
badTotal.scoreTotal = 85.98;
expectIssue(badTotal, "inconsistent_score", "scoreTotal");

const belowThresholdPass = structuredClone(passing);
belowThresholdPass.rubric.passThreshold = 90;
expectIssue(belowThresholdPass, "inconsistent_verdict", "verdict");

const majorFindingPass = structuredClone(passing);
majorFindingPass.criteria[1].findings[0].severity = "major";
expectIssue(majorFindingPass, "inconsistent_verdict", "verdict");

const majorRiskPass = structuredClone(passing);
majorRiskPass.risks[0].severity = "major";
expectIssue(majorRiskPass, "inconsistent_verdict", "verdict");

const failedCriterionPass = structuredClone(passing);
failedCriterionPass.criteria[1].status = "change_requested";
expectIssue(failedCriterionPass, "inconsistent_verdict", "verdict");

const requiredChangePass = structuredClone(passing);
requiredChangePass.requiredChanges = [{
  issueCode: "design.naming_consistency",
  summary: "Align the signal label.",
  acceptanceCriteria: ["Both artifacts use the same public label."],
  evidenceRefs: ["artifact_game_contract#runtimeSignals.progress"],
}];
expectIssue(requiredChangePass, "inconsistent_verdict", "verdict");

const blockingPass = structuredClone(passing);
blockingPass.blockingIssueCodes = ["design.naming_consistency"];
expectIssue(blockingPass, "inconsistent_verdict", "verdict");

const unnecessaryRequest = structuredClone(passing);
unnecessaryRequest.verdict = "change_requested";
expectIssue(unnecessaryRequest, "inconsistent_verdict", "verdict");

const requestWithBlocker = structuredClone(blocked);
requestWithBlocker.verdict = "change_requested";
expectIssue(requestWithBlocker, "inconsistent_verdict", "verdict");

const blockedWithoutIssue = structuredClone(requested);
blockedWithoutIssue.verdict = "blocked";
blockedWithoutIssue.criteria[0].status = "blocked";
expectIssue(blockedWithoutIssue, "inconsistent_verdict", "verdict");

const blockedWithoutCriterion = structuredClone(blocked);
blockedWithoutCriterion.criteria[0].status = "change_requested";
expectIssue(blockedWithoutCriterion, "inconsistent_verdict", "criteria");

const unknownChangeIssue = structuredClone(requested);
unknownChangeIssue.requiredChanges[0].issueCode = "design.unknown_issue";
expectIssue(unknownChangeIssue, "unknown_reference", "requiredChanges[0].issueCode");

const unknownBlockingIssue = structuredClone(blocked);
unknownBlockingIssue.blockingIssueCodes = ["design.unknown_issue"];
expectIssue(unknownBlockingIssue, "unknown_reference", "blockingIssueCodes[0]");

const malformedEvidence = structuredClone(passing);
malformedEvidence.targets[0].ledgerHash = "not-a-sha256";
expectIssue(malformedEvidence, "invalid_format", "ledgerHash");

const malformedTime = structuredClone(passing);
malformedTime.reviewedAt = "yesterday";
expectIssue(malformedTime, "invalid_format", "reviewedAt");

assert.throws(() => parseQualityReview(unknownTopLevel), QualityReviewValidationError);

console.log("Quality review contract passed: strict shape, evidence binding, scoring, references, and verdict semantics");
