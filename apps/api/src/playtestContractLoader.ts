import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  ContractValidationError,
  parsePlaytestContract,
  type PlaytestContract
} from "@game-pipeline/shared-schemas";
import { resolvePathWithinRoot } from "./pathSafety.js";

export const defaultPlaytestContractPath = "agents/qa/contracts/core-loop.playtest-contract.json";
const contractsDirectory = "agents/qa/contracts";
const maximumContractBytes = 1_000_000;

export interface LoadedPlaytestContract {
  contract: PlaytestContract;
  path: string;
  hash: string;
  sizeBytes: number;
}

/**
 * Loads an explicitly selected contract or discovers the single v1 contract in
 * the QA contracts directory. `undefined` means this is an old/legacy project.
 * A present-but-invalid or ambiguous contract always throws and must not fall
 * back to legacy behaviour.
 */
export function loadPlaytestContract(
  projectRoot: string,
  explicitPath?: string
): LoadedPlaytestContract | undefined {
  const path = explicitPath?.trim()
    ? normalizeRelativeContractPath(explicitPath)
    : discoverPlaytestContractPath(projectRoot);
  if (!path) return undefined;

  const absolutePath = resolveInsideProject(projectRoot, path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`PlaytestContract 不存在：${path}`);
  }
  const sizeBytes = statSync(absolutePath).size;
  if (sizeBytes <= 0 || sizeBytes > maximumContractBytes) {
    throw new Error(`PlaytestContract 大小必须在 1-${maximumContractBytes} bytes：${path}`);
  }
  const body = readFileSync(absolutePath);
  let document: unknown;
  try {
    document = JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`PlaytestContract 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return {
      contract: parsePlaytestContract(document),
      path,
      hash: createHash("sha256").update(body).digest("hex"),
      sizeBytes
    };
  } catch (error) {
    if (error instanceof ContractValidationError) {
      const details = error.issues.slice(0, 12).map((issue) => `${issue.path}: ${issue.message}`).join("；");
      throw new Error(`PlaytestContract 未通过结构校验：${details}`);
    }
    throw error;
  }
}

function discoverPlaytestContractPath(projectRoot: string): string | undefined {
  const preferred = resolveInsideProject(projectRoot, defaultPlaytestContractPath);
  if (existsSync(preferred)) {
    if (!statSync(preferred).isFile()) throw new Error(`PlaytestContract 路径不是文件：${defaultPlaytestContractPath}`);
    return defaultPlaytestContractPath;
  }
  const directory = resolveInsideProject(projectRoot, contractsDirectory);
  if (!existsSync(directory)) return undefined;
  if (!statSync(directory).isDirectory()) throw new Error(`QA contracts 路径不是目录：${contractsDirectory}`);
  const entries = readdirSync(directory, { withFileTypes: true });
  const linkedContracts = entries.filter((entry) => entry.isSymbolicLink() && /(?:^|[._-])playtest-contract\.json$/i.test(entry.name));
  if (linkedContracts.length > 0) {
    throw new Error(`PlaytestContract 不能是符号链接：${linkedContracts.map((entry) => entry.name).join("、")}`);
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /(?:^|[._-])playtest-contract\.json$/i.test(entry.name))
    .map((entry) => `${contractsDirectory}/${entry.name}`)
    .sort();
  if (candidates.length > 1) {
    throw new Error(`发现多个 PlaytestContract，必须显式选择：${candidates.join("、")}`);
  }
  return candidates[0];
}

function normalizeRelativeContractPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`PlaytestContract 路径非法：${path}`);
  }
  if (!/(?:^|[._-])playtest-contract\.json$/i.test(basename(normalized))) {
    throw new Error(`PlaytestContract 文件名必须以 playtest-contract.json 结尾：${path}`);
  }
  return normalized;
}

function resolveInsideProject(projectRoot: string, path: string): string {
  return resolvePathWithinRoot(projectRoot, path, {
    allowMissing: true,
    label: "PlaytestContract 路径"
  }).absolutePath;
}
