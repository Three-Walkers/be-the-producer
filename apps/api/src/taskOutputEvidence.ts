import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type { ArtifactDirectoryManifest, ArtifactInputProvenance, Task } from "@game-pipeline/shared-schemas";
import { createHash } from "node:crypto";
import { readArtifactContentForModel } from "./workspaceWriter.js";
import { hashWorkspaceFile, readWorkspaceTree, resolveWorkspacePathTarget } from "./workspaceWriter.js";
import type { PlaytestReportEvidence } from "./playtestEvidence.js";
import { isContractArtifactType, parseContractArtifactText } from "./contractArtifacts.js";
import { projectContractArtifactIsCompatible } from "./projectContracts.js";

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
    !artifact?.metadata.toolExecutedAt ||
    evidence?.status !== "verified" ||
    ["change_requested", "rejected", "superseded"].includes(artifact.status)
  ) {
    return false;
  }
  // A failed bridge operation still produces a useful, hash-verified report.
  // That report is failure evidence, not a consumable scene/build deliverable.
  if (artifact.metadata.bridgeOperationId && artifact.metadata.bridgeOk !== true) {
    return false;
  }
  if (!artifactMatchesLedger(kernel, artifact.artifactId, evidence.path)) {
    return false;
  }
  if (!artifactInputProvenanceIsCurrent(kernel, artifact.artifactId)) {
    return false;
  }
  if (artifact.type === "build" && !directoryManifestIsCurrent(kernel, evidence.directoryManifest)) {
    return false;
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
