import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { CocosBridgeEvidence } from "./cocosEngineBridge.js";
import { parsePlaytestMarker, type PlaytestReportEvidence } from "./playtestEvidence.js";

export interface QaPlaytestReceipt {
  schemaVersion: 1;
  operationId: string;
  reportPath: string;
  result: PlaytestReportEvidence;
  evidence: CocosBridgeEvidence[];
  createdAt: string;
}

const receiptDirectory = ".be-the-producer/qa-playtest-receipts";

export function writeQaPlaytestReceipt(
  projectRoot: string,
  reportPath: string,
  result: PlaytestReportEvidence,
  evidence: CocosBridgeEvidence[]
): string {
  if (!evidence.some((item) => item.path === reportPath)) {
    throw new Error(`QA 收据缺少主报告证据：${reportPath}`);
  }
  const receipt: QaPlaytestReceipt = {
    schemaVersion: 1,
    operationId: result.operationId,
    reportPath,
    result,
    evidence,
    createdAt: new Date().toISOString()
  };
  const path = `${receiptDirectory}/${result.operationId}.json`;
  const absolutePath = resolveInsideProject(projectRoot, path);
  const temporaryPath = `${absolutePath}.tmp`;
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, absolutePath);
  return path;
}

export function readVerifiedQaPlaytestReceipts(projectRoot: string): QaPlaytestReceipt[] {
  const directory = resolveInsideProject(projectRoot, receiptDirectory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readReceipt(projectRoot, resolve(directory, name)))
    .filter((receipt): receipt is QaPlaytestReceipt => Boolean(receipt))
    .sort((left, right) => left.result.completedAt.localeCompare(right.result.completedAt));
}

function readReceipt(projectRoot: string, path: string): QaPlaytestReceipt | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<QaPlaytestReceipt>;
    if (
      parsed.schemaVersion !== 1 ||
      !parsed.operationId ||
      !parsed.reportPath ||
      !parsed.result ||
      !Array.isArray(parsed.evidence) ||
      parsed.result.operationId !== parsed.operationId
    ) {
      return undefined;
    }
    const reportEvidence = parsed.evidence.find((item) => item.path === parsed.reportPath);
    if (!reportEvidence || !parsed.evidence.every((item) => evidenceMatches(projectRoot, item))) {
      return undefined;
    }
    const reportAbsolutePath = resolveInsideProject(projectRoot, parsed.reportPath);
    const marker = parsePlaytestMarker(readFileSync(reportAbsolutePath, "utf8"));
    if (!marker || marker.operationId !== parsed.operationId || marker.verdict !== parsed.result.verdict) {
      return undefined;
    }
    if (!parsed.result.evidencePaths.every((evidencePath) => parsed.evidence?.some((item) => item.path === evidencePath))) {
      return undefined;
    }
    return parsed as QaPlaytestReceipt;
  } catch {
    return undefined;
  }
}

function evidenceMatches(projectRoot: string, evidence: CocosBridgeEvidence): boolean {
  const path = resolveInsideProject(projectRoot, evidence.path);
  if (!existsSync(path) || !statSync(path).isFile()) {
    return false;
  }
  const body = readFileSync(path);
  return body.byteLength === evidence.sizeBytes && createHash("sha256").update(body).digest("hex") === evidence.hash;
}

function resolveInsideProject(projectRoot: string, path: string): string {
  const root = resolve(projectRoot);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`QA 收据路径越界：${path}`);
  }
  return target;
}
