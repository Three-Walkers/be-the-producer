/**
 * Machine-verifiable quality review artifacts.
 *
 * This contract is deliberately strict: reviewer prose may explain a verdict,
 * but it cannot replace immutable target evidence, a versioned rubric, or the
 * cross-field rules that make pass/change-requested/blocked mutually exclusive.
 */

export const QUALITY_REVIEW_SCHEMA_VERSION = "1.0.0" as const;
export const QUALITY_REVIEW_KIND = "artifact_quality_review" as const;

export type QualityReviewSchemaVersion = typeof QUALITY_REVIEW_SCHEMA_VERSION;
export type QualityReviewDomain = "design" | "art_direction" | "visual_assets";
export type QualityReviewVerdict = "pass" | "change_requested" | "blocked";
export type QualityReviewCriterionStatus = "pass" | "change_requested" | "blocked";
export type QualityReviewSeverity = "critical" | "major" | "minor" | "note";

export interface QualityReviewTarget {
  artifactId: string;
  version: number;
  path: string;
  ledgerHash: string;
  sizeBytes: number;
}

export interface QualityReviewRubric {
  rubricId: string;
  version: string;
  passThreshold: number;
}

export interface QualityReviewFinding {
  issueCode: string;
  severity: QualityReviewSeverity;
  summary: string;
  evidenceRefs: string[];
}

export interface QualityReviewCriterion {
  criterionId: string;
  label: string;
  weight: number;
  score: number;
  status: QualityReviewCriterionStatus;
  findings: QualityReviewFinding[];
}

export interface QualityReviewRequiredChange {
  issueCode: string;
  summary: string;
  acceptanceCriteria: string[];
  evidenceRefs: string[];
}

export interface QualityReviewRisk {
  riskId: string;
  severity: QualityReviewSeverity;
  summary: string;
  evidenceRefs: string[];
}

export interface QualityReviewModelTrace {
  providerId: string;
  model: string;
  invocationId: string;
  promptVersion: string;
}

export interface ArtifactQualityReview {
  schemaVersion: QualityReviewSchemaVersion;
  kind: typeof QUALITY_REVIEW_KIND;
  reviewId: string;
  domain: QualityReviewDomain;
  reviewerAgentId: string;
  targets: QualityReviewTarget[];
  rubric: QualityReviewRubric;
  criteria: QualityReviewCriterion[];
  scoreTotal: number;
  verdict: QualityReviewVerdict;
  requiredChanges: QualityReviewRequiredChange[];
  risks: QualityReviewRisk[];
  blockingIssueCodes: string[];
  modelTrace: QualityReviewModelTrace;
  reviewedAt: string;
}

export type QualityReviewValidationIssueCode =
  | "invalid_type"
  | "missing_property"
  | "unknown_property"
  | "invalid_literal"
  | "invalid_format"
  | "invalid_value"
  | "duplicate_id"
  | "unknown_reference"
  | "inconsistent_score"
  | "inconsistent_verdict";

export interface QualityReviewValidationIssue {
  path: string;
  code: QualityReviewValidationIssueCode;
  message: string;
}

export type QualityReviewValidationResult =
  | { ok: true; value: ArtifactQualityReview }
  | { ok: false; issues: QualityReviewValidationIssue[] };

export class QualityReviewValidationError extends Error {
  readonly issues: QualityReviewValidationIssue[];

  constructor(issues: QualityReviewValidationIssue[]) {
    super(`ArtifactQualityReview validation failed with ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n` +
      issues.slice(0, 40).map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`).join("\n") +
      (issues.length > 40 ? `\n… ${issues.length - 40} more issues; fix these first and retry.` : ""));
    this.name = "QualityReviewValidationError";
    this.issues = issues;
  }
}

type JsonObject = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SCORE_EPSILON = 0.01;

function addIssue(
  issues: QualityReviewValidationIssue[],
  path: string,
  code: QualityReviewValidationIssueCode,
  message: string,
): void {
  issues.push({ path, code, message });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectAt(value: unknown, path: string, issues: QualityReviewValidationIssue[]): JsonObject | undefined {
  if (!isObject(value)) {
    addIssue(issues, path, "invalid_type", "Expected an object.");
    return undefined;
  }
  return value;
}

function strictKeys(
  value: JsonObject,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: QualityReviewValidationIssue[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, `${path}.${key}`, "unknown_property", `Unknown property '${key}'.`);
    }
  }
  for (const key of required) {
    if (!hasOwn(value, key)) {
      addIssue(issues, `${path}.${key}`, "missing_property", `Required property '${key}' is missing.`);
    }
  }
}

function stringAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: QualityReviewValidationIssue[],
  options: { identifier?: boolean; semver?: boolean; sha256?: boolean; dateTime?: boolean } = {},
): string | undefined {
  if (!hasOwn(value, key)) return undefined;
  const candidate = value[key];
  const fieldPath = `${path}.${key}`;
  if (typeof candidate !== "string") {
    addIssue(issues, fieldPath, "invalid_type", "Expected a string.");
    return undefined;
  }
  if (candidate.trim().length === 0) {
    addIssue(issues, fieldPath, "invalid_value", "String must not be empty.");
  } else if (options.identifier && !IDENTIFIER_PATTERN.test(candidate)) {
    addIssue(issues, fieldPath, "invalid_format", "Expected a stable lowercase identifier.");
  } else if (options.semver && !SEMVER_PATTERN.test(candidate)) {
    addIssue(issues, fieldPath, "invalid_format", "Expected a semantic version.");
  } else if (options.sha256 && !SHA256_PATTERN.test(candidate)) {
    addIssue(issues, fieldPath, "invalid_format", "Expected a 64-character SHA-256 digest.");
  } else if (options.dateTime && (!ISO_DATE_TIME_PATTERN.test(candidate) || Number.isNaN(Date.parse(candidate)))) {
    addIssue(issues, fieldPath, "invalid_format", "Expected an ISO 8601 date-time with an explicit timezone.");
  }
  return candidate;
}

function numberAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: QualityReviewValidationIssue[],
  options: { integer?: boolean; min?: number; max?: number } = {},
): number | undefined {
  if (!hasOwn(value, key)) return undefined;
  const candidate = value[key];
  const fieldPath = `${path}.${key}`;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    addIssue(issues, fieldPath, "invalid_type", "Expected a finite number.");
    return undefined;
  }
  if (options.integer && !Number.isInteger(candidate)) {
    addIssue(issues, fieldPath, "invalid_value", "Expected an integer.");
  }
  if (options.min !== undefined && candidate < options.min) {
    addIssue(issues, fieldPath, "invalid_value", `Expected a number greater than or equal to ${options.min}.`);
  }
  if (options.max !== undefined && candidate > options.max) {
    addIssue(issues, fieldPath, "invalid_value", `Expected a number less than or equal to ${options.max}.`);
  }
  return candidate;
}

function literalAt<T extends string>(
  value: JsonObject,
  key: string,
  path: string,
  allowed: readonly T[],
  issues: QualityReviewValidationIssue[],
): T | undefined {
  const candidate = stringAt(value, key, path, issues);
  if (candidate !== undefined && !allowed.includes(candidate as T)) {
    addIssue(issues, `${path}.${key}`, "invalid_literal", `Expected one of: ${allowed.join(", ")}.`);
    return undefined;
  }
  return candidate as T | undefined;
}

function arrayAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: QualityReviewValidationIssue[],
  options: { nonEmpty?: boolean } = {},
): unknown[] | undefined {
  if (!hasOwn(value, key)) return undefined;
  const candidate = value[key];
  const fieldPath = `${path}.${key}`;
  if (!Array.isArray(candidate)) {
    addIssue(issues, fieldPath, "invalid_type", "Expected an array.");
    return undefined;
  }
  if (options.nonEmpty && candidate.length === 0) {
    addIssue(issues, fieldPath, "invalid_value", "Array must not be empty.");
  }
  return candidate;
}

function stringArrayAt(
  value: JsonObject,
  key: string,
  path: string,
  issues: QualityReviewValidationIssue[],
  options: { nonEmpty?: boolean; identifier?: boolean; unique?: boolean } = {},
): string[] | undefined {
  const values = arrayAt(value, key, path, issues, options.nonEmpty === undefined ? {} : { nonEmpty: options.nonEmpty });
  if (!values) return undefined;
  const seen = new Set<string>();
  values.forEach((candidate, index) => {
    const itemPath = `${path}.${key}[${index}]`;
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      addIssue(issues, itemPath, "invalid_type", "Expected a non-empty string.");
      return;
    }
    if (options.identifier && !IDENTIFIER_PATTERN.test(candidate)) {
      addIssue(issues, itemPath, "invalid_format", "Expected a stable lowercase identifier.");
    }
    if (options.unique && seen.has(candidate)) {
      addIssue(issues, itemPath, "duplicate_id", `Duplicate value '${candidate}'.`);
    }
    seen.add(candidate);
  });
  return values as string[];
}

function validateTarget(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const target = objectAt(value, path, issues);
  if (!target) return;
  const keys = ["artifactId", "version", "path", "ledgerHash", "sizeBytes"] as const;
  strictKeys(target, path, keys, keys, issues);
  stringAt(target, "artifactId", path, issues, { identifier: true });
  numberAt(target, "version", path, issues, { integer: true, min: 1 });
  stringAt(target, "path", path, issues);
  stringAt(target, "ledgerHash", path, issues, { sha256: true });
  numberAt(target, "sizeBytes", path, issues, { integer: true, min: 1 });
}

function validateRubric(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const rubric = objectAt(value, path, issues);
  if (!rubric) return;
  const keys = ["rubricId", "version", "passThreshold"] as const;
  strictKeys(rubric, path, keys, keys, issues);
  stringAt(rubric, "rubricId", path, issues, { identifier: true });
  stringAt(rubric, "version", path, issues, { semver: true });
  numberAt(rubric, "passThreshold", path, issues, { min: 0, max: 100 });
}

function validateFinding(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const finding = objectAt(value, path, issues);
  if (!finding) return;
  const keys = ["issueCode", "severity", "summary", "evidenceRefs"] as const;
  strictKeys(finding, path, keys, keys, issues);
  stringAt(finding, "issueCode", path, issues, { identifier: true });
  literalAt(finding, "severity", path, ["critical", "major", "minor", "note"] as const, issues);
  stringAt(finding, "summary", path, issues);
  stringArrayAt(finding, "evidenceRefs", path, issues, { nonEmpty: true, unique: true });
}

function validateCriterion(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const criterion = objectAt(value, path, issues);
  if (!criterion) return;
  const keys = ["criterionId", "label", "weight", "score", "status", "findings"] as const;
  strictKeys(criterion, path, keys, keys, issues);
  stringAt(criterion, "criterionId", path, issues, { identifier: true });
  stringAt(criterion, "label", path, issues);
  numberAt(criterion, "weight", path, issues, { min: 0, max: 100 });
  numberAt(criterion, "score", path, issues, { min: 0, max: 100 });
  literalAt(criterion, "status", path, ["pass", "change_requested", "blocked"] as const, issues);
  const findings = arrayAt(criterion, "findings", path, issues);
  findings?.forEach((finding, index) => validateFinding(finding, `${path}.findings[${index}]`, issues));
}

function validateRequiredChange(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const change = objectAt(value, path, issues);
  if (!change) return;
  const keys = ["issueCode", "summary", "acceptanceCriteria", "evidenceRefs"] as const;
  strictKeys(change, path, keys, keys, issues);
  stringAt(change, "issueCode", path, issues, { identifier: true });
  stringAt(change, "summary", path, issues);
  stringArrayAt(change, "acceptanceCriteria", path, issues, { nonEmpty: true, unique: true });
  stringArrayAt(change, "evidenceRefs", path, issues, { nonEmpty: true, unique: true });
}

function validateRisk(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const risk = objectAt(value, path, issues);
  if (!risk) return;
  const keys = ["riskId", "severity", "summary", "evidenceRefs"] as const;
  strictKeys(risk, path, keys, keys, issues);
  stringAt(risk, "riskId", path, issues, { identifier: true });
  literalAt(risk, "severity", path, ["critical", "major", "minor", "note"] as const, issues);
  stringAt(risk, "summary", path, issues);
  stringArrayAt(risk, "evidenceRefs", path, issues, { nonEmpty: true, unique: true });
}

function validateModelTrace(value: unknown, path: string, issues: QualityReviewValidationIssue[]): void {
  const trace = objectAt(value, path, issues);
  if (!trace) return;
  const keys = ["providerId", "model", "invocationId", "promptVersion"] as const;
  strictKeys(trace, path, keys, keys, issues);
  stringAt(trace, "providerId", path, issues, { identifier: true });
  stringAt(trace, "model", path, issues);
  stringAt(trace, "invocationId", path, issues);
  stringAt(trace, "promptVersion", path, issues, { semver: true });
}

function validateShape(value: unknown, issues: QualityReviewValidationIssue[]): void {
  const root = objectAt(value, "$", issues);
  if (!root) return;
  const keys = [
    "schemaVersion",
    "kind",
    "reviewId",
    "domain",
    "reviewerAgentId",
    "targets",
    "rubric",
    "criteria",
    "scoreTotal",
    "verdict",
    "requiredChanges",
    "risks",
    "blockingIssueCodes",
    "modelTrace",
    "reviewedAt",
  ] as const;
  strictKeys(root, "$", keys, keys, issues);
  literalAt(root, "schemaVersion", "$", [QUALITY_REVIEW_SCHEMA_VERSION] as const, issues);
  literalAt(root, "kind", "$", [QUALITY_REVIEW_KIND] as const, issues);
  stringAt(root, "reviewId", "$", issues, { identifier: true });
  literalAt(root, "domain", "$", ["design", "art_direction", "visual_assets"] as const, issues);
  stringAt(root, "reviewerAgentId", "$", issues, { identifier: true });

  const targets = arrayAt(root, "targets", "$", issues, { nonEmpty: true });
  targets?.forEach((target, index) => validateTarget(target, `$.targets[${index}]`, issues));
  if (hasOwn(root, "rubric")) validateRubric(root.rubric, "$.rubric", issues);
  const criteria = arrayAt(root, "criteria", "$", issues, { nonEmpty: true });
  criteria?.forEach((criterion, index) => validateCriterion(criterion, `$.criteria[${index}]`, issues));
  numberAt(root, "scoreTotal", "$", issues, { min: 0, max: 100 });
  literalAt(root, "verdict", "$", ["pass", "change_requested", "blocked"] as const, issues);

  const requiredChanges = arrayAt(root, "requiredChanges", "$", issues);
  requiredChanges?.forEach((change, index) => validateRequiredChange(change, `$.requiredChanges[${index}]`, issues));
  const risks = arrayAt(root, "risks", "$", issues);
  risks?.forEach((risk, index) => validateRisk(risk, `$.risks[${index}]`, issues));
  stringArrayAt(root, "blockingIssueCodes", "$", issues, { identifier: true, unique: true });
  if (hasOwn(root, "modelTrace")) validateModelTrace(root.modelTrace, "$.modelTrace", issues);
  stringAt(root, "reviewedAt", "$", issues, { dateTime: true });
}

function recordUnique(
  values: Array<{ id: string; path: string }>,
  issues: QualityReviewValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      addIssue(issues, value.path, "duplicate_id", `Duplicate identifier '${value.id}'.`);
    }
    seen.add(value.id);
  }
}

function validateSemantics(review: ArtifactQualityReview, issues: QualityReviewValidationIssue[]): void {
  recordUnique(
    review.targets.map((target, index) => ({ id: target.artifactId, path: `$.targets[${index}].artifactId` })),
    issues,
  );
  recordUnique(
    review.criteria.map((criterion, index) => ({ id: criterion.criterionId, path: `$.criteria[${index}].criterionId` })),
    issues,
  );

  const findings = review.criteria.flatMap((criterion, criterionIndex) =>
    criterion.findings.map((finding, findingIndex) => ({
      finding,
      path: `$.criteria[${criterionIndex}].findings[${findingIndex}].issueCode`,
    })),
  );
  recordUnique(findings.map(({ finding, path }) => ({ id: finding.issueCode, path })), issues);
  recordUnique(
    review.risks.map((risk, index) => ({ id: risk.riskId, path: `$.risks[${index}].riskId` })),
    issues,
  );
  recordUnique(
    review.requiredChanges.map((change, index) => ({ id: change.issueCode, path: `$.requiredChanges[${index}].issueCode` })),
    issues,
  );

  const issueCodes = new Set(findings.map(({ finding }) => finding.issueCode));
  review.requiredChanges.forEach((change, index) => {
    if (!issueCodes.has(change.issueCode)) {
      addIssue(
        issues,
        `$.requiredChanges[${index}].issueCode`,
        "unknown_reference",
        `Required change references unknown issue code '${change.issueCode}'.`,
      );
    }
  });
  review.blockingIssueCodes.forEach((issueCode, index) => {
    if (!issueCodes.has(issueCode)) {
      addIssue(
        issues,
        `$.blockingIssueCodes[${index}]`,
        "unknown_reference",
        `Blocking issue references unknown issue code '${issueCode}'.`,
      );
    }
  });

  const weightTotal = review.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (Math.abs(weightTotal - 100) > SCORE_EPSILON) {
    addIssue(issues, "$.criteria", "inconsistent_score", `Criterion weights must total 100; received ${weightTotal}.`);
  }
  const calculatedScore = review.criteria.reduce(
    (sum, criterion) => sum + (criterion.weight * criterion.score) / 100,
    0,
  );
  if (Math.abs(calculatedScore - review.scoreTotal) > SCORE_EPSILON) {
    addIssue(
      issues,
      "$.scoreTotal",
      "inconsistent_score",
      `scoreTotal must equal the weighted score ${calculatedScore.toFixed(4)}; received ${review.scoreTotal}.`,
    );
  }

  const severeIssueCodes = findings
    .filter(({ finding }) => finding.severity === "critical" || finding.severity === "major")
    .map(({ finding }) => finding.issueCode);
  const hasSevereRisk = review.risks.some((risk) => risk.severity === "critical" || risk.severity === "major");
  const allCriteriaPassed = review.criteria.every((criterion) => criterion.status === "pass");
  const meetsPassConditions =
    review.scoreTotal + SCORE_EPSILON >= review.rubric.passThreshold &&
    severeIssueCodes.length === 0 &&
    !hasSevereRisk &&
    allCriteriaPassed &&
    review.requiredChanges.length === 0 &&
    review.blockingIssueCodes.length === 0;

  if (review.verdict === "pass" && !meetsPassConditions) {
    addIssue(
      issues,
      "$.verdict",
      "inconsistent_verdict",
      "A pass verdict requires the rubric threshold, all criteria passing, no critical/major findings or risks, no required changes, and no blocking issues.",
    );
  } else if (review.verdict === "change_requested") {
    if (meetsPassConditions) {
      addIssue(issues, "$.verdict", "inconsistent_verdict", "change_requested requires at least one failed pass condition.");
    }
    if (review.blockingIssueCodes.length > 0) {
      addIssue(issues, "$.verdict", "inconsistent_verdict", "A review with blocking issues must use the blocked verdict.");
    }
    if (review.criteria.some((criterion) => criterion.status === "blocked")) {
      addIssue(issues, "$.verdict", "inconsistent_verdict", "A review with a blocked criterion must use the blocked verdict.");
    }
  } else if (review.verdict === "blocked") {
    if (review.blockingIssueCodes.length === 0) {
      addIssue(issues, "$.verdict", "inconsistent_verdict", "A blocked verdict requires at least one blocking issue code.");
    }
    if (!review.criteria.some((criterion) => criterion.status === "blocked")) {
      addIssue(issues, "$.criteria", "inconsistent_verdict", "A blocked verdict requires at least one blocked criterion.");
    }
  }
}

export function validateQualityReview(value: unknown): QualityReviewValidationResult {
  const issues: QualityReviewValidationIssue[] = [];
  validateShape(value, issues);
  if (issues.length === 0) validateSemantics(value as ArtifactQualityReview, issues);
  return issues.length === 0 ? { ok: true, value: value as ArtifactQualityReview } : { ok: false, issues };
}

export function parseQualityReview(value: unknown): ArtifactQualityReview {
  const result = validateQualityReview(value);
  if (!result.ok) throw new QualityReviewValidationError(result.issues);
  return result.value;
}

export function assertQualityReview(value: unknown): asserts value is ArtifactQualityReview {
  parseQualityReview(value);
}

export const validateArtifactQualityReview = validateQualityReview;
export const parseArtifactQualityReview = parseQualityReview;
export const assertArtifactQualityReview = assertQualityReview;
