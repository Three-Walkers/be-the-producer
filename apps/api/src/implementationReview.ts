import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Artifact } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import { resolvePathWithinRoot } from "./pathSafety.js";
import { runImplementationChecks, type ImplementationCheckResult } from "./implementationChecks.js";
import { cocosEngineSettingsStore } from "./cocosEngineSettings.js";
import { resolveProjectWorkspaceRoot } from "./workspaceWriter.js";

export const selfCheckPath = "docs/engineering/implementation-self-check.json";
export const implementationReviewPath = "agents/qa/reviews/implementation-review.json";
export const implementationReviewTaskId = "task_stage_2_qa_implementation_review";
export const reviewFacets = ["core_loop", "economy_progression", "interaction", "visual_integration", "persistence", "negative_paths"] as const;
interface Citation { path: string; quote: string; lineStart?: number; lineEnd?: number }
interface Coverage { facet: string; verdict: "pass" | "fail" | "not_applicable"; reason: string; baseline: Citation; implementation: Citation }
interface ReviewIssue { title: string; expected: string; actual: string; baseline: Citation; implementation: Citation }
export interface ImplementationReview {
  schemaVersion: 1;
  kind: "implementation_review";
  verdict: "pass" | "change_requested";
  coverage: Coverage[];
  issues: ReviewIssue[];
  checks: ImplementationCheckResult;
}

/** Exact source excerpts are checked, not trusted because the reviewer says so.
 * This proves grounding, not correctness of the reviewer's product judgment. */
export function validateImplementationReview(projectRoot: string, document: unknown, checks: ImplementationCheckResult): ImplementationReview {
  if (!isRecord(document) || document.schemaVersion !== 1 || document.kind !== "implementation_review" ||
      !["pass", "change_requested"].includes(String(document.verdict)) || !Array.isArray(document.coverage) || !Array.isArray(document.issues)) {
    const received = isRecord(document) ? ` Received schemaVersion=${JSON.stringify(document.schemaVersion)}, kind=${JSON.stringify(document.kind)}, verdict=${JSON.stringify(document.verdict)}, keys=${Object.keys(document).join(",")}.` : " Received non-object document.";
    throw new Error("Use submit_implementation_review: schemaVersion must be integer 1 (not '1.0.0'), kind=implementation_review, verdict=pass|change_requested (not fail/blocked), coverage[], issues[]." + received);
  }
  if (document.coverage.length !== reviewFacets.length || new Set(document.coverage.map((item) => isRecord(item) && item.facet)).size !== reviewFacets.length) {
    throw new Error(`Coverage must contain each facet exactly once: ${reviewFacets.join(", ")}`);
  }
  for (const item of document.coverage) {
    if (!isRecord(item) || !(reviewFacets as readonly unknown[]).includes(item.facet) ||
        !["pass", "fail", "not_applicable"].includes(String(item.verdict)) || !nonempty(item.reason)) throw new Error("Invalid review coverage entry.");
    validateCitation(projectRoot, item.baseline, "baseline");
    validateCitation(projectRoot, item.implementation, "implementation");
  }
  if (document.issues.length > 60) throw new Error("Implementation review exceeds 60 issues; group related observations.");
  for (const issue of document.issues) {
    if (!isRecord(issue) || !nonempty(issue.title) || !nonempty(issue.expected) || !nonempty(issue.actual)) throw new Error("Each defect requires title, expected and actual behavior.");
    validateCitation(projectRoot, issue.baseline, "baseline");
    validateCitation(projectRoot, issue.implementation, "implementation");
  }
  const hasFailure = document.issues.length > 0 || document.coverage.some((item) => isRecord(item) && item.verdict === "fail") || checks.status !== "pass";
  if ((document.verdict === "pass") === hasFailure) throw new Error("Review verdict conflicts with grounded defects or machine-check failure. Static checks never establish gameplay acceptance.");
  if (document.coverage.some((item) => isRecord(item) && item.verdict === "fail") && document.issues.length === 0) throw new Error("Failing coverage must include actionable issues.");
  return { schemaVersion: 1, kind: "implementation_review", verdict: document.verdict as ImplementationReview["verdict"],
    coverage: document.coverage as Coverage[], issues: document.issues as ReviewIssue[], checks };
}

function validateCitation(root: string, value: unknown, kind: "baseline" | "implementation"): void {
  if (!isRecord(value) || !nonempty(value.path)) throw new Error(`Invalid ${kind} citation; provide path and exact quote, or lineStart/lineEnd from read_file.`);
  const allowed = kind === "baseline" ? /^(agents\/design\/|agents\/art\/art-bible\.md$)/ : /^(assets\/scripts\/|agents\/engineering\/cocos-scene-blueprints\/)/;
  if (!allowed.test(value.path) || value.path.endsWith(".d.ts")) throw new Error(`Out-of-scope ${kind} citation: ${value.path}`);
  const target = resolvePathWithinRoot(root, value.path, { allowMissing: false, expectedKind: "file" });
  const source = readFileSync(target.absolutePath, "utf8");
  if (value.lineStart !== undefined || value.lineEnd !== undefined) {
    const start = value.lineStart, end = value.lineEnd;
    const lines = source.split(/\r?\n/);
    if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 1 || end < start || end > lines.length || end - start >= 40) throw new Error(`Citation line range must be valid and at most 40 lines: ${value.path}`);
    const extracted = lines.slice(start - 1, end).join("\n");
    if (value.quote !== undefined && value.quote !== extracted) throw new Error(`Citation quote differs from its line range: ${value.path}; omit quote and the server will extract the exact source.`);
    value.quote = extracted;
  }
  if (!nonempty(value.quote) || value.quote.length < 4 || value.quote.length > 2400) throw new Error(`Invalid ${kind} citation length; select 4–2400 characters.`);
  if (!source.replaceAll("\r\n", "\n").includes(value.quote)) throw new Error(`Citation does not match current file bytes: ${value.path}. Read the file with withLineNumbers=true; supply path+lineStart+lineEnd without quote to extract exact evidence. Do not paraphrase JSON as a quotation.`);
}

function readServiceImplementationReport(kernel: StudioKernel, artifact: Artifact, allowInvalidated = false) {
  if (![selfCheckPath, implementationReviewPath].includes(artifact.path)) return undefined;
  try {
    const self = artifact.path === selfCheckPath;
    if (artifact.type !== "bug_report" || artifact.artifactId !== (self ? "artifact_implementation_self_check" : "artifact_implementation_review") ||
        artifact.ownerAgentId !== (self ? "gameplay_programmer" : "qa_evaluator") ||
        artifact.sourceTaskId !== (self ? "task_stage_2_cocos_implementation" : implementationReviewTaskId)) return undefined;
    const root = resolveProjectWorkspaceRoot(kernel.project.projectId);
    const file = readFileSync(resolvePathWithinRoot(root, artifact.path, { allowMissing: false }).absolutePath);
    const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId);
    const fileHash = hash(file);
    const isOwnOperation = (entry: ReturnType<StudioKernel["listArtifactOperations"]>[number]) =>
      entry.status === "completed" && entry.agentId === artifact.ownerAgentId && entry.taskId === artifact.sourceTaskId &&
      entry.artifactId === artifact.artifactId && entry.path === artifact.path && entry.metadata.implementationVerificationHash === fileHash;
    const currentOperation = kernel.listArtifactOperations().find((entry) => entry.operationId === ledger?.sourceOperationId);
    const historical = allowInvalidated && ledger?.status === "pending" &&
      artifact.metadata.filesystemEvidenceInvalidationReason === "review_output_not_current_after_workspace_sync";
    const operation = historical ? kernel.listArtifactOperations().filter(isOwnOperation).at(-1) : currentOperation;
    if (!operation || !isOwnOperation(operation) || (!historical && (ledger?.status !== "verified" || ledger.hash !== fileHash))) return undefined;
    const document = JSON.parse(file.toString("utf8"));
    const checks = runImplementationChecks(root, cocosEngineSettingsStore.getResolvedConfig().executablePath);
    if (operation.metadata.implementationVerificationTool !== (self ? "run_implementation_checks" : "write_artifact")) return undefined;
    return { document, checks, root, self, historical };
  } catch { return undefined; }
}

export function currentImplementationReport(kernel: StudioKernel, artifact: Artifact): ImplementationReview | ImplementationCheckResult | undefined {
  try {
    const verified = readServiceImplementationReport(kernel, artifact);
    if (!verified) return undefined;
    const { document, checks, root, self } = verified;
    if (self) return document.fingerprint === checks.fingerprint && document.status === checks.status ? checks : undefined;
    if (document.checks?.fingerprint !== checks.fingerprint) return undefined;
    return validateImplementationReview(root, document, checks);
  } catch { return undefined; }
}

/** An authentic old report remains audit history, but changed implementation
 * bytes require a new author check / independent review, not manual unblocking. */
export function implementationReportNeedsRefresh(kernel: StudioKernel, artifact: Artifact): boolean {
  const verified = readServiceImplementationReport(kernel, artifact, true);
  if (!verified) return false;
  const previous = verified.self ? verified.document.fingerprint : verified.document.checks?.fingerprint;
  return typeof previous === "string" && /^[a-f0-9]{64}$/.test(previous) && (verified.historical || previous !== verified.checks.fingerprint);
}

/** Negative review evidence reopens only the responsible original author tasks.
 * The reviewer never writes code, changes design approval or closes defects. */
export function applyImplementationReviewFeedback(kernel: StudioKernel, artifact: Artifact, review: ImplementationReview): void {
  if (review.verdict === "pass") return;
  const targets = new Map<string, string[]>();
  for (const issue of review.issues) {
    const owner = issue.implementation.path.startsWith("assets/scripts/") ? "gameplay_programmer" : "cocos_tech_lead";
    targets.set(owner, [...(targets.get(owner) ?? []), `${issue.title}；预期：${issue.expected}；实际：${issue.actual}；证据：${issue.implementation.path}\n${issue.implementation.quote}`]);
  }
  for (const finding of review.checks.findings.filter((finding) => finding.severity === "error")) {
    targets.set(finding.ownerAgentId, [...(targets.get(finding.ownerAgentId) ?? []), `${finding.code}: ${finding.path}:${finding.line ?? 1} ${finding.details}`]);
  }
  const taskByOwner: Record<string, string> = { gameplay_programmer: "task_stage_2_cocos_implementation", cocos_tech_lead: "task_stage_2_cocos_architecture", cocos_automation: "task_stage_2_cocos_build" };
  const now = new Date().toISOString();
  for (const [owner, details] of targets) {
    const task = kernel.findTask(taskByOwner[owner] ?? "");
    if (!task) continue;
    const marker = `IMPLEMENTATION_REVIEW:${artifact.artifactId}:v${artifact.version}`;
    if (task.description.includes(marker)) continue;
    kernel.updateTask(task.taskId, { status: "doing", progressPercent: 50,
      description: `${task.description.split("\nIMPLEMENTATION_REVIEW:")[0]}\n${marker}\n${details.join("\n")}`,
      blockers: [], updatedAt: now });
    for (const id of task.outputArtifacts) {
      const output = kernel.listArtifacts().find((candidate) => candidate.artifactId === id);
      if (output) kernel.upsertArtifact({ ...output, status: "change_requested", updatedAt: now });
    }
    kernel.updateAgentLoopAgent(task.ownerAgentId, { status: "queued", taskId: task.taskId, lastError: undefined, updatedAt: now });
    kernel.recordMessage({ messageId: `msg_impl_review_${hash(`${artifact.artifactId}:${artifact.version}:${owner}`).slice(0, 20)}`,
      projectId: kernel.project.projectId, roomId: task.roomId ?? kernel.getRoom("engineering-room").roomId,
      senderType: "agent", senderId: "qa_evaluator", messageType: "handoff",
      content: `独立 QA 源码审查未通过，已自动回派给 @${owner}。修复后重新自检；QA 会基于新字节重新审查，不能以修复说明关闭。\n${details.join("\n")}`,
      mentions: [task.ownerAgentId], relatedTaskIds: [task.taskId, implementationReviewTaskId], relatedArtifactIds: [artifact.artifactId],
      metadata: { generatedBy: "implementation_review_feedback" }, createdAt: now });
  }
}

function nonempty(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
