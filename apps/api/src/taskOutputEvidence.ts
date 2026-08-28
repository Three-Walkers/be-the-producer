import {
  createStudioKernelFromSnapshot,
  getStageOneArtifactContracts,
  type StudioKernel
} from "@game-pipeline/agent-runtime";
import type { Artifact, ArtifactDirectoryManifest, ArtifactInputProvenance, Task } from "@game-pipeline/shared-schemas";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readArtifactContentForModel, resolveProjectWorkspaceRoot } from "./workspaceWriter.js";
import { hashWorkspaceFile, readWorkspaceTree, resolveWorkspacePathTarget } from "./workspaceWriter.js";
import { verifyCocosBuildImportReceipt } from "./cocosEngineBridge.js";
import type { PlaytestReportEvidence } from "./playtestEvidence.js";
import { isContractArtifactType, parseContractArtifactText } from "./contractArtifacts.js";
import { projectContractArtifactIsCompatible } from "./projectContracts.js";
import {
  parseQualityReviewText,
  qualityReviewReadyForGate
} from "./qualityReviewArtifacts.js";
import { validateManifestRuntimeAssetAlphaPolicies } from "./imageAssetValidation.js";
import { hasCurrentGenerateRasterAssetReceipt } from "./mediaArtifactEvidence.js";

const requiredLegacyPlaytestChecks = [
  "launch",
  "start_flow",
  "terminal_flow",
  "hud_runtime_values",
  "dynamic_values",
  "text_fit",
  "terminal_panel_state",
  "label_overlap",
  "terminal_exclusivity",
  "viewport_fit",
  "restart_control",
  "restart_flow",
  "console_errors"
];

/**
 * Stage 1 IDs are protocol identities, not aliases for arbitrary verified files.
 * Returning a mismatch here prevents a wrong type from bypassing strict-contract
 * parsing and prevents a valid ledger at a non-canonical path/owner/task from
 * satisfying either downstream task inputs or producer gates.
 */
export function stageOneCanonicalArtifactIdentityMismatch(
  kernel: StudioKernel,
  artifactId: string
): string | undefined {
  const expected = getStageOneArtifactContracts().find((contract) => contract.artifactId === artifactId);
  if (!expected) {
    return undefined;
  }
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  if (!artifact) {
    return "artifact missing";
  }
  const mismatches = [
    artifact.type === expected.type ? undefined : `type=${artifact.type}, expected=${expected.type}`,
    artifact.path === expected.path ? undefined : `path=${artifact.path}, expected=${expected.path}`,
    artifact.ownerAgentId === expected.ownerAgentId
      ? undefined
      : `owner=${artifact.ownerAgentId}, expected=${expected.ownerAgentId}`,
    artifact.sourceTaskId === expected.sourceTaskId
      ? undefined
      : `sourceTask=${artifact.sourceTaskId ?? "missing"}, expected=${expected.sourceTaskId}`
  ].filter((value): value is string => Boolean(value));
  return mismatches.length > 0 ? mismatches.join("; ") : undefined;
}

export function requiredRuntimePngPaths(kernel: StudioKernel, task: Task): string[] {
  if (task.ownerAgentId !== "asset_production") {
    return [];
  }
  return task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId)?.path)
    .filter((path): path is string => Boolean(path?.toLowerCase().endsWith(".svg")))
    .map((path) => path.replace(/\.svg$/i, ".png"));
}

export function expectedHarnessOutputPaths(kernel: StudioKernel, task: Task): string[] {
  const registeredPaths = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId)?.path)
    .filter((path): path is string => Boolean(path));
  return [...new Set([...registeredPaths, ...requiredRuntimePngPaths(kernel, task)])];
}

export function taskOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  if (task.outputArtifacts.length === 0) {
    return false;
  }
  const artifacts = kernel.listArtifacts();
  const ledger = kernel.listArtifactLedger();
  const registeredOutputsVerified = task.outputArtifacts.every((artifactId) => artifactReadyForConsumption(kernel, artifactId));
  if (!registeredOutputsVerified) {
    return false;
  }

  if (task.ownerAgentId === "qa_evaluator") {
    return qaPlaytestOutputsVerified(kernel, task);
  }
  if (task.taskId.startsWith("task_qa_repair_")) {
    return qaRepairOutputsVerified(kernel, task);
  }
  if (task.taskId === "task_stage_2_asset_pipeline" && !assetProductionOutputsVerified(kernel, task)) {
    return false;
  }

  const runtimePngPaths = requiredRuntimePngPaths(kernel, task);
  if (runtimePngPaths.length === 0) {
    return true;
  }
  const pngEvidenceVerified = runtimePngPaths.every((path) => {
    const artifact = artifacts.find((candidate) => candidate.path === path);
    const evidence = artifact ? ledger.find((candidate) => candidate.artifactId === artifact.artifactId) : undefined;
    return Boolean(artifact?.metadata.toolExecutedAt && evidence?.status === "verified");
  });
  if (!pngEvidenceVerified) {
    return false;
  }
  const manifest = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "asset_manifest");
  const manifestContent = manifest ? readArtifactContentForModel(kernel.project.projectId, manifest, 1_000_000) : undefined;
  return Boolean(manifestContent && runtimePngPaths.every((path) => manifestContent.includes(path)));
}

export function artifactReadyForConsumption(kernel: StudioKernel, artifactId: string): boolean {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const evidence = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  if (
    stageOneCanonicalArtifactIdentityMismatch(kernel, artifactId) !== undefined ||
    !artifact?.metadata.toolExecutedAt ||
    evidence?.status !== "verified" ||
    ["change_requested", "rejected", "superseded"].includes(artifact.status)
  ) {
    return false;
  }
  // Cocos bridge evidence is consumable only after an explicit successful
  // result. Harness media operations also carry an operation id, but prove
  // success through stricter provider/vision receipts instead of bridgeOk.
  if (artifact.metadata.bridgeOperationId && artifact.metadata.bridgeOk === false) {
    return false;
  }
  if (artifact.metadata.bridgeOperationId && artifact.metadata.bridgeOk !== true) {
    const verifiedMediaOperation =
      artifact.metadata.bridgeOperationType === "image_generation" &&
      hasCurrentGenerateRasterAssetReceipt(kernel, artifact) &&
      workspaceArtifactHasPngSignature(kernel, artifact);
    const verifiedReviewOperation =
      artifact.type === "quality_review" &&
      artifact.metadata.bridgeOperationType === "quality_review_with_vision";
    if (!verifiedMediaOperation && !verifiedReviewOperation) {
      return false;
    }
  }
  if (!artifactMatchesLedger(kernel, artifact.artifactId, evidence.path)) {
    return false;
  }
  if (!artifactInputProvenanceIsCurrent(kernel, artifact.artifactId)) {
    return false;
  }
  if (artifact.type === "build") {
    if (!directoryManifestIsCurrent(kernel, evidence.directoryManifest)) {
      return false;
    }
    const requiresCocosImportReceipt =
      artifact.sourceTaskId === "task_stage_2_cocos_build" ||
      artifact.metadata.bridgeOperationType === "build";
    if (requiresCocosImportReceipt && !cocosBuildImportReceiptIsCurrent(kernel, artifact)) {
      return false;
    }
  }
  if (artifact.type === "quality_review") {
    return qualityReviewReadyForTaskCompletion(kernel, artifact.artifactId);
  }
  if (!isContractArtifactType(artifact.type)) {
    return true;
  }
  const content = readArtifactContentForModel(kernel.project.projectId, artifact, 2_000_000);
  if (!content) return false;
  try {
    parseContractArtifactText(artifact.type, content);
    return projectContractArtifactIsCompatible(kernel, artifact);
  } catch {
    return false;
  }
}

/**
 * A Cocos build remains consumable only while the import receipt frozen into
 * its report is still the canonical current receipt and all imported source /
 * destination bytes continue to match it.
 */
export function cocosBuildImportReceiptIsCurrent(kernel: StudioKernel, artifact: Artifact): boolean {
  if (artifact.type !== "build") return false;
  const content = readArtifactContentForModel(kernel.project.projectId, artifact, 2_000_000);
  if (!content) return false;
  try {
    const report = JSON.parse(content) as unknown;
    if (!isRecord(report) || report.status !== "success") return false;
    return verifyCocosBuildImportReceipt(
      resolveProjectWorkspaceRoot(kernel.project.projectId),
      report.importReceipt
    );
  } catch {
    return false;
  }
}

/**
 * Reviewer work is complete when it produced either a passing review or a
 * grounded change request. A blocked receipt remains incomplete. The feedback
 * path marks reviewed artifacts change_requested immediately, so a narrow
 * projection restores only statuses changed by this exact review before
 * reusing the strict quality-review validator.
 */
function qualityReviewReadyForTaskCompletion(kernel: StudioKernel, artifactId: string): boolean {
  let result = qualityReviewReadyForGate(kernel, artifactId, false);
  if (!result.ok) {
    const reviewArtifact = kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId);
    const content = reviewArtifact
      ? readArtifactContentForModel(kernel.project.projectId, reviewArtifact, 2_000_000)
      : undefined;
    if (!reviewArtifact || !content) return false;
    let review;
    try {
      review = parseQualityReviewText(content);
    } catch {
      return false;
    }
    if (review.verdict !== "change_requested") return false;

    const snapshot = structuredClone(kernel.toSnapshot());
    let projectedFeedbackStatus = false;
    for (const target of review.targets) {
      const targetArtifact = snapshot.artifacts.find((artifact) => artifact.artifactId === target.artifactId);
      if (!targetArtifact || targetArtifact.status !== "change_requested") continue;
      if (
        targetArtifact.metadata.qualityChangeReviewId !== review.reviewId ||
        targetArtifact.metadata.qualityChangeReviewArtifactId !== artifactId
      ) {
        return false;
      }
      targetArtifact.status = "submitted";
      projectedFeedbackStatus = true;
    }
    if (!projectedFeedbackStatus) return false;
    try {
      result = qualityReviewReadyForGate(createStudioKernelFromSnapshot(snapshot), artifactId, false);
    } catch {
      return false;
    }
  }
  return Boolean(result.ok && result.review && ["pass", "change_requested"].includes(result.review.verdict));
}

/**
 * Production art cannot be satisfied by a manifest/contact sheet pair alone or
 * by SVG rasterization. At least one task-owned runtime PNG must carry a
 * server-generated generate_raster_asset receipt, and every manifest runtimePath
 * must resolve to current PNG evidence.
 */
export function assetProductionOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  if (task.taskId !== "task_stage_2_asset_pipeline") return true;
  if (task.ownerAgentId !== "asset_production") return false;
  const artifacts = kernel.listArtifacts();
  const outputArtifacts = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const manifest = outputArtifacts.find((artifact) => artifact.artifactId === "artifact_asset_manifest_draft");
  const contactSheet = outputArtifacts.find((artifact) => artifact.artifactId === "artifact_asset_contact_sheet");
  if (
    !manifest ||
    manifest.type !== "asset_manifest" ||
    manifest.path !== "agents/art/asset-manifest.json" ||
    manifest.ownerAgentId !== "asset_production" ||
    manifest.sourceTaskId !== task.taskId ||
    !contactSheet ||
    contactSheet.type !== "asset" ||
    contactSheet.path !== "agents/art/processed-assets/first-playable-contact-sheet.png" ||
    contactSheet.ownerAgentId !== "asset_production" ||
    contactSheet.sourceTaskId !== task.taskId ||
    contactSheet.metadata.mediaRole !== "asset_contact_sheet" ||
    !artifactReadyForConsumption(kernel, manifest.artifactId) ||
    !artifactReadyForConsumption(kernel, contactSheet.artifactId) ||
    !workspaceArtifactHasPngSignature(kernel, contactSheet)
  ) {
    return false;
  }

  const manifestContent = readArtifactContentForModel(kernel.project.projectId, manifest, 1_000_000);
  if (!manifestContent) return false;
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestContent);
  } catch {
    return false;
  }
  let runtimePaths: string[];
  try {
    const alphaReceipts = validateManifestRuntimeAssetAlphaPolicies(kernel.project.projectId, manifestValue);
    runtimePaths = alphaReceipts.map((receipt) => receipt.runtimePath);
  } catch {
    return false;
  }
  if (runtimePaths.length === 0) return false;

  const runtimeArtifacts = runtimePaths.map((path) => artifacts.find((artifact) => artifact.path === path));
  if (runtimeArtifacts.some((artifact) => !artifact)) return false;
  const currentRuntimePngs = runtimeArtifacts.filter((artifact): artifact is Artifact => Boolean(artifact)).filter((artifact) =>
    task.outputArtifacts.includes(artifact.artifactId) &&
    artifact.sourceTaskId === task.taskId &&
    artifact.ownerAgentId === "asset_production" &&
    artifact.type === "asset" &&
    artifact.artifactId !== contactSheet.artifactId &&
    artifact.metadata.mediaRole !== "asset_contact_sheet" &&
    artifact.path.toLowerCase().endsWith(".png") &&
    artifactReadyForConsumption(kernel, artifact.artifactId) &&
    workspaceArtifactHasPngSignature(kernel, artifact)
  );
  if (currentRuntimePngs.length !== runtimePaths.length) return false;
  return currentRuntimePngs.some((artifact) => hasCurrentGenerateRasterAssetReceipt(kernel, artifact));
}

function workspaceArtifactHasPngSignature(kernel: StudioKernel, artifact: Artifact): boolean {
  if (!artifact.path.toLowerCase().endsWith(".png")) return false;
  try {
    const target = resolveWorkspacePathTarget(kernel.project.projectId, artifact.path);
    if (!target.exists || target.type !== "file" || (target.sizeBytes ?? 0) < 8) return false;
    const signature = readFileSync(target.absolutePath).subarray(0, 8);
    return signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } catch {
    return false;
  }
}

/** Recursively proves that an output was created from the current declared inputs. */
export function artifactInputProvenanceIsCurrent(
  kernel: StudioKernel,
  artifactId: string,
  visiting = new Set<string>()
): boolean {
  if (visiting.has(artifactId)) return false;
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
  const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  if (!artifact || !ledger) return false;
  const task = artifact.sourceTaskId ? kernel.findTask(artifact.sourceTaskId) : undefined;
  const declaredInputs = task ? [...new Set(task.inputArtifacts)].sort() : [];
  const receipt = [...(ledger.inputArtifacts ?? [])].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (receipt.length !== declaredInputs.length || receipt.some((entry, index) => entry.artifactId !== declaredInputs[index])) {
    return false;
  }
  const nextVisiting = new Set(visiting).add(artifactId);
  return receipt.every((entry) => {
    const inputArtifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === entry.artifactId);
    const inputLedger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === entry.artifactId);
    if (!inputArtifact || !inputLedger?.hash || inputLedger.sizeBytes === undefined || inputLedger.status !== "verified") return false;
    if (entry.version !== inputArtifact.version || entry.path !== inputArtifact.path || entry.evidencePath !== inputLedger.path ||
      entry.hash !== inputLedger.hash || entry.sizeBytes !== inputLedger.sizeBytes ||
      entry.directoryManifestDigest !== inputLedger.directoryManifest?.digest) return false;
    if (!artifactMatchesLedger(kernel, inputArtifact.artifactId, inputLedger.path)) return false;
    if (inputArtifact.type === "build" && !directoryManifestIsCurrent(kernel, inputLedger.directoryManifest)) return false;
    return artifactInputProvenanceIsCurrent(kernel, inputArtifact.artifactId, nextVisiting);
  });
}

export function captureCurrentTaskInputProvenance(kernel: StudioKernel, task: Task): ArtifactInputProvenance[] {
  return [...new Set(task.inputArtifacts)].sort().map((artifactId) => {
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === artifactId);
    const ledger = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
    if (!artifact || !ledger?.hash || ledger.sizeBytes === undefined || ledger.status !== "verified" ||
      !artifactReadyForConsumption(kernel, artifactId)) {
      throw new Error(`QA/构建输入缺少当前可消费证据：${artifactId}`);
    }
    return {
      artifactId,
      version: artifact.version,
      path: artifact.path,
      evidencePath: ledger.path,
      hash: ledger.hash,
      sizeBytes: ledger.sizeBytes,
      ...(ledger.directoryManifest?.digest ? { directoryManifestDigest: ledger.directoryManifest.digest } : {})
    };
  });
}

export function directoryManifestIsCurrent(kernel: StudioKernel, manifest: ArtifactDirectoryManifest | undefined): boolean {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.files.length === 0) return false;
  const canonicalFiles = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalFiles.some((entry, index) => entry.path !== manifest.files[index]?.path)) return false;
  const prefix = `${manifest.rootPath.replace(/\/+$/, "")}/`;
  if (canonicalFiles.some((entry) => !entry.path.startsWith(prefix))) return false;
  const digest = createHash("sha256")
    .update(canonicalFiles.map((entry) => `${entry.path}\0${entry.sizeBytes}\0${entry.hash}\n`).join(""))
    .digest("hex");
  if (digest !== manifest.digest) return false;
  const currentFiles = readWorkspaceTree(kernel.project.projectId).entries
    .filter((entry) => entry.type === "file" && entry.path.startsWith(prefix))
    .map((entry) => entry.path)
    .filter((path) => path !== `${manifest.rootPath}/build-report.json` && !path.endsWith("/.gitkeep"))
    .sort();
  if (currentFiles.length !== canonicalFiles.length || currentFiles.some((path, index) => path !== canonicalFiles[index]?.path)) {
    return false;
  }
  return canonicalFiles.every((entry) => {
    try {
      const target = resolveWorkspacePathTarget(kernel.project.projectId, entry.path);
      return target.exists && target.type === "file" && target.sizeBytes === entry.sizeBytes &&
        hashWorkspaceFile(target.absolutePath) === entry.hash;
    } catch {
      return false;
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTaskPlaytestEvidence(kernel: StudioKernel, task: Task): PlaytestReportEvidence | undefined {
  const artifacts = kernel.listArtifacts();
  const report = task.outputArtifacts
    .map((artifactId) => artifacts.find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "qa_report" && artifact.path.endsWith(".md"));
  if (!report) {
    return undefined;
  }
  if (!report || report.metadata.generatedBy !== "qa_result_ingestion") {
    return undefined;
  }
  const operationId = typeof report.metadata.playtestOperationId === "string" ? report.metadata.playtestOperationId : undefined;
  const verdict = report.metadata.playtestVerdict;
  const checks = report.metadata.playtestChecks;
  const defects = report.metadata.playtestDefects;
  const evidencePaths = report.metadata.playtestEvidencePaths;
  const runtime = report.metadata.playtestRuntime;
  const schemaVersion = report.metadata.playtestSchemaVersion;
  const contract = report.metadata.playtestContract;
  const scenarios = report.metadata.playtestScenarios;
  if (
    !operationId ||
    !["pass", "fail", "blocked"].includes(String(verdict)) ||
    !Array.isArray(checks) ||
    !Array.isArray(defects) ||
    !Array.isArray(evidencePaths) ||
    !runtime ||
    typeof runtime !== "object" ||
    Array.isArray(runtime)
  ) {
    return undefined;
  }
  return {
    ...(schemaVersion === 2 ? { schemaVersion: 2 as const } : {}),
    operationId,
    verdict: verdict as PlaytestReportEvidence["verdict"],
    completedAt: typeof report.metadata.toolExecutedAt === "string" ? report.metadata.toolExecutedAt : report.updatedAt,
    checks: checks as PlaytestReportEvidence["checks"],
    defects: defects as PlaytestReportEvidence["defects"],
    evidencePaths: evidencePaths.filter((path): path is string => typeof path === "string"),
    ...(schemaVersion === 2 && contract && typeof contract === "object" && !Array.isArray(contract)
      ? { contract: contract as NonNullable<PlaytestReportEvidence["contract"]> }
      : {}),
    ...(schemaVersion === 2 && Array.isArray(scenarios)
      ? { scenarios: scenarios as NonNullable<PlaytestReportEvidence["scenarios"]> }
      : {}),
    runtime: runtime as PlaytestReportEvidence["runtime"]
  };
}

function qaPlaytestOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  const result = readTaskPlaytestEvidence(kernel, task);
  const report = task.outputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "qa_report");
  const provenByPlaytestTool = report?.metadata.generatedBy === "qa_result_ingestion" && report.metadata.toolName === "run_playtest";
  if (!result || !report || !provenByPlaytestTool || !artifactMatchesLedger(kernel, report.artifactId, report.path) || result.verdict !== "pass") {
    return false;
  }
  if (result.defects.some((defect) => ["blocker", "critical", "major"].includes(defect.severity))) {
    return false;
  }
  if (result.schemaVersion === 2) {
    if (!contractPlaytestEvidenceVerified(kernel, task, result)) return false;
    if (!qaTaskInputEvidenceVerified(kernel, task, report.metadata.playtestTaskInputEvidence)) return false;
  } else if (!requiredLegacyPlaytestChecks.every((checkId) =>
    result.checks.some((check) => check.checkId === checkId && check.status === "passed")
  )) {
    return false;
  }
  const artifacts = kernel.listArtifacts();
  return result.evidencePaths.length >= 4 && result.evidencePaths.every((path) => {
    const artifact = artifacts.find((candidate) => candidate.path === path);
    return Boolean(artifact?.metadata.toolExecutedAt && artifactMatchesLedger(kernel, artifact.artifactId, path));
  });
}

function qaTaskInputEvidenceVerified(kernel: StudioKernel, task: Task, raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  try {
    const expected = captureCurrentTaskInputProvenance(kernel, task);
    const actual = [...raw].sort((left, right) => {
      const leftId = typeof left === "object" && left !== null ? String((left as { artifactId?: unknown }).artifactId ?? "") : "";
      const rightId = typeof right === "object" && right !== null ? String((right as { artifactId?: unknown }).artifactId ?? "") : "";
      return leftId.localeCompare(rightId);
    });
    return JSON.stringify(expected) === JSON.stringify(actual);
  } catch {
    return false;
  }
}

function contractPlaytestEvidenceVerified(
  kernel: StudioKernel,
  task: Task,
  result: PlaytestReportEvidence
): boolean {
  if (!result.contract || !result.scenarios || result.contract.adapterMode !== "runtime_adapter" || !result.contract.hashVerified) {
    return false;
  }
  const requiredChecks = ["launch", "adapter_handshake", "contract_conformance", "console_errors"];
  if (!requiredChecks.every((checkId) =>
    result.checks.some((check) => check.checkId === checkId && check.status === "passed")
  )) {
    return false;
  }
  if (result.scenarios.some((scenario) => scenario.required && !scenario.passed)) {
    return false;
  }
  const playtestArtifact = task.inputArtifacts
    .map((artifactId) => kernel.listArtifacts().find((artifact) => artifact.artifactId === artifactId))
    .find((artifact) => artifact?.type === "playtest_contract");
  if (!playtestArtifact || playtestArtifact.path !== result.contract.path) return false;
  const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === playtestArtifact.artifactId);
  return Boolean(
    playtestArtifact.metadata.toolExecutedAt &&
    ledger?.status === "verified" &&
    ledger.hash === result.contract.hash &&
    ledger.sizeBytes === result.contract.sizeBytes &&
    artifactReadyForConsumption(kernel, playtestArtifact.artifactId)
  );
}

function artifactMatchesLedger(kernel: StudioKernel, artifactId: string, path: string): boolean {
  const target = resolveWorkspacePathTarget(kernel.project.projectId, path);
  const evidence = kernel.listArtifactLedger().find((candidate) => candidate.artifactId === artifactId);
  return target.exists && target.type === "file" && Boolean(
    evidence?.status === "verified" &&
    evidence.hash === hashWorkspaceFile(target.absolutePath) &&
    evidence.sizeBytes === target.sizeBytes
  );
}

function qaRepairOutputsVerified(kernel: StudioKernel, task: Task): boolean {
  const artifacts = kernel.listArtifacts();
  const ledger = kernel.listArtifactLedger();
  return task.outputArtifacts.some((artifactId) => {
    const artifact = artifacts.find((candidate) => candidate.artifactId === artifactId);
    if (!artifact || artifact.path.includes("/qa-repairs/")) {
      return false;
    }
    const evidence = ledger.find((candidate) => candidate.artifactId === artifact.artifactId);
    const materializedAt = evidence?.materializedAt ? Date.parse(evidence.materializedAt) : 0;
    return Boolean(
      artifact.metadata.toolExecutedAt &&
      evidence?.status === "verified" &&
      materializedAt >= Date.parse(task.createdAt) &&
      (/^(assets|settings)\//.test(artifact.path) || /^agents\/(engineering|art|cocos-automation)\//.test(artifact.path))
    );
  });
}
