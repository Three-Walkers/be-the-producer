import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { CocosBridgeEvidence } from "./cocosEngineBridge.js";
import type { ArtifactInputProvenance } from "@game-pipeline/shared-schemas";
import { parsePlaytestMarker, type PlaytestReportEvidence } from "./playtestEvidence.js";
import { resolvePathWithinRoot } from "./pathSafety.js";

export interface QaPlaytestReceipt {
  schemaVersion: 1 | 2;
  operationId: string;
  reportPath: string;
  result: PlaytestReportEvidence;
  evidence: CocosBridgeEvidence[];
  contractEvidence?: CocosBridgeEvidence;
  /** Frozen by the orchestrator before the harness starts. */
  taskInputEvidence?: ArtifactInputProvenance[];
  createdAt: string;
}

const receiptDirectory = ".be-the-producer/qa-playtest-receipts";

export function writeQaPlaytestReceipt(
  projectRoot: string,
  reportPath: string,
  result: PlaytestReportEvidence,
  evidence: CocosBridgeEvidence[],
  taskInputEvidence: ArtifactInputProvenance[] = []
): string {
  if (!evidence.some((item) => item.path === reportPath)) {
    throw new Error(`QA 收据缺少主报告证据：${reportPath}`);
  }
  const contractEvidence = result.schemaVersion === 2 && result.contract
    ? fileEvidence(projectRoot, result.contract.path)
    : undefined;
  if (result.contract && contractEvidence &&
    (contractEvidence.hash !== result.contract.hash || contractEvidence.sizeBytes !== result.contract.sizeBytes)) {
    throw new Error(`QA 收据中的 PlaytestContract 已变化：${result.contract.path}`);
  }
  const receipt: QaPlaytestReceipt = {
    schemaVersion: result.schemaVersion === 2 ? 2 : 1,
    operationId: result.operationId,
    reportPath,
    result,
    evidence,
    taskInputEvidence: taskInputEvidence.map((entry) => ({ ...entry })),
    ...(contractEvidence ? { contractEvidence } : {}),
    createdAt: new Date().toISOString()
  };
  const path = `${receiptDirectory}/${result.operationId}.json`;
  ensureDirectoryInsideProject(projectRoot, receiptDirectory);
  const absolutePath = resolveInsideProject(projectRoot, path);
  const temporaryPath = resolveInsideProject(projectRoot, `${path}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  resolveInsideProject(projectRoot, path);
  renameSync(temporaryPath, absolutePath);
  return path;
}

export function readVerifiedQaPlaytestReceipts(projectRoot: string): QaPlaytestReceipt[] {
  const directory = resolveInsideProject(projectRoot, receiptDirectory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [];
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  const linkedReceipts = entries.filter((entry) => entry.isSymbolicLink() && entry.name.endsWith(".json"));
  if (linkedReceipts.length > 0) {
    throw new Error(`QA 收据不能是符号链接：${linkedReceipts.map((entry) => entry.name).join("、")}`);
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readReceipt(projectRoot, `${receiptDirectory}/${entry.name}`))
    .filter((receipt): receipt is QaPlaytestReceipt => Boolean(receipt))
    .sort((left, right) => left.result.completedAt.localeCompare(right.result.completedAt));
}

function readReceipt(projectRoot: string, path: string): QaPlaytestReceipt | undefined {
  try {
    const absolutePath = resolveInsideProject(projectRoot, path);
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as Partial<QaPlaytestReceipt>;
    if (
      ![1, 2].includes(Number(parsed.schemaVersion)) ||
      !parsed.operationId ||
      !parsed.reportPath ||
      !parsed.result ||
      !Array.isArray(parsed.evidence) ||
      (parsed.taskInputEvidence !== undefined && !validTaskInputEvidence(parsed.taskInputEvidence)) ||
      parsed.result.operationId !== parsed.operationId
    ) {
      return undefined;
    }
    const reportEvidence = parsed.evidence.find((item) => item.path === parsed.reportPath);
    if (!reportEvidence || !parsed.evidence.every((item) => evidenceMatches(projectRoot, item))) {
      return undefined;
    }
    if (!(parsed.taskInputEvidence ?? []).every((item) => evidenceMatches(projectRoot, {
      path: item.evidencePath,
      hash: item.hash,
      sizeBytes: item.sizeBytes
    }))) {
      return undefined;
    }
    const reportAbsolutePath = resolveInsideProject(projectRoot, parsed.reportPath);
    const marker = parsePlaytestMarker(readFileSync(reportAbsolutePath, "utf8"));
    if (!marker || marker.operationId !== parsed.operationId || marker.verdict !== parsed.result.verdict) {
      return undefined;
    }
    if (parsed.schemaVersion === 2) {
      const resultContract = parsed.result.contract;
      const markerContract = marker.contract;
      if (!resultContract || !markerContract ||
        resultContract.playtestId !== markerContract.playtestId ||
        resultContract.revision !== markerContract.revision ||
        resultContract.hash !== markerContract.hash) {
        return undefined;
      }
      const contractEvidence = parsed.contractEvidence;
      if (!contractEvidence || contractEvidence.path !== resultContract.path ||
        contractEvidence.hash !== resultContract.hash || contractEvidence.sizeBytes !== resultContract.sizeBytes ||
        !evidenceMatches(projectRoot, contractEvidence)) {
        return undefined;
      }
    }
    if (!parsed.result.evidencePaths.every((evidencePath) => parsed.evidence?.some((item) => item.path === evidencePath))) {
      return undefined;
    }
    return parsed as QaPlaytestReceipt;
  } catch {
    return undefined;
  }
}

function validTaskInputEvidence(value: unknown): value is ArtifactInputProvenance[] {
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry) &&
    typeof (entry as ArtifactInputProvenance).artifactId === "string" &&
    Number.isInteger((entry as ArtifactInputProvenance).version) && (entry as ArtifactInputProvenance).version > 0 &&
    typeof (entry as ArtifactInputProvenance).path === "string" &&
    typeof (entry as ArtifactInputProvenance).evidencePath === "string" &&
    typeof (entry as ArtifactInputProvenance).hash === "string" &&
    typeof (entry as ArtifactInputProvenance).sizeBytes === "number"
  );
}

function evidenceMatches(projectRoot: string, evidence: CocosBridgeEvidence): boolean {
  const path = resolveInsideProject(projectRoot, evidence.path);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return false;
  }
  const body = readFileSync(path);
  return body.byteLength === evidence.sizeBytes && createHash("sha256").update(body).digest("hex") === evidence.hash;
}

function fileEvidence(projectRoot: string, path: string): CocosBridgeEvidence {
  const absolutePath = resolveInsideProject(projectRoot, path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`QA 收据证据不存在：${path}`);
  }
  const body = readFileSync(absolutePath);
  return { path, hash: createHash("sha256").update(body).digest("hex"), sizeBytes: body.byteLength };
}

function resolveInsideProject(projectRoot: string, path: string): string {
  return resolvePathWithinRoot(projectRoot, path, {
    allowMissing: true,
    label: "QA 收据路径"
  }).absolutePath;
}

function ensureDirectoryInsideProject(projectRoot: string, path: string): string {
  let resolved = resolvePathWithinRoot(projectRoot, path, {
    allowMissing: true,
    expectedKind: "directory",
    label: "QA 收据目录"
  });
  mkdirSync(resolved.absolutePath, { recursive: true, mode: 0o700 });
  resolved = resolvePathWithinRoot(projectRoot, path, {
    allowMissing: false,
    expectedKind: "directory",
    label: "QA 收据目录"
  });
  return resolved.absolutePath;
}
