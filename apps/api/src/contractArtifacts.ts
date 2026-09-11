import {
  ContractValidationError,
  parseGameContract,
  parsePlaytestContract,
  parseSceneBlueprint,
  type GameContract,
  type PlaytestContract,
  type SceneBlueprint
} from "@game-pipeline/shared-schemas";
import { createHash } from "node:crypto";
import type { Artifact } from "@game-pipeline/shared-schemas";
import { engineeringContractGuide } from "./engineeringContractGuide.js";

export type ContractArtifactType = Extract<Artifact["type"], "game_contract" | "scene_blueprint" | "playtest_contract">;

export function isContractArtifactType(type: Artifact["type"]): type is ContractArtifactType {
  return type === "game_contract" || type === "scene_blueprint" || type === "playtest_contract";
}

export function contractArtifactTypeForPath(path: string): ContractArtifactType | undefined {
  const normalized = path.toLowerCase();
  if (normalized.endsWith("game-contract.json") || normalized.endsWith("game_contract.json")) {
    return "game_contract";
  }
  if (normalized.endsWith("scene-blueprint.json") || normalized.endsWith("scene_blueprint.json")) {
    return "scene_blueprint";
  }
  if (normalized.endsWith("playtest-contract.json") || normalized.endsWith("playtest_contract.json")) {
    return "playtest_contract";
  }
  return undefined;
}

export function parseContractArtifactText(type: ContractArtifactType, content: string): unknown {
  let document: unknown;
  try {
    document = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${contractLabel(type)} 必须是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    switch (type) {
      case "game_contract":
        return parseGameContract(document);
      case "scene_blueprint":
        return parseSceneBlueprint(document);
      case "playtest_contract":
        return parsePlaytestContract(document);
    }
  } catch (error) {
    if (error instanceof ContractValidationError) {
      throw new Error(`${contractLabel(type)} 未通过结构校验：${error.message}\n${engineeringContractGuide([type]).join("\n")}`);
    }
    throw error;
  }
}

export function assertContractArtifactContent(type: Artifact["type"], content: string, mode: "write" | "append" = "write"): void {
  if (!isContractArtifactType(type)) return;
  if (mode === "append") {
    throw new Error(`${contractLabel(type)} 是版本化 JSON 契约，只允许整份替换，不能追加写入。`);
  }
  parseContractArtifactText(type, content);
}

export function assertContractPathContent(path: string, content: string, mode: "write" | "append" = "write"): void {
  const type = contractArtifactTypeForPath(path);
  if (type) assertContractArtifactContent(type, content, mode);
}

export function assertContractRevisionAdvance(
  type: ContractArtifactType,
  previousContent: string | undefined,
  nextContent: string
): void {
  if (!previousContent || hashContractText(previousContent) === hashContractText(nextContent)) return;
  const previous = parseContractArtifactText(type, previousContent);
  const next = parseContractArtifactText(type, nextContent);
  const previousRevision = contractRevision(type, previous);
  const nextRevision = contractRevision(type, next);
  if (nextRevision <= previousRevision) {
    throw new Error(
      `${contractLabel(type)} 内容发生变化时 revision 必须递增：当前 ${previousRevision}，提交 ${nextRevision}。`
    );
  }
}

function contractRevision(type: ContractArtifactType, value: unknown): number {
  return type === "game_contract"
    ? (value as GameContract).identity.revision
    : type === "scene_blueprint"
      ? (value as SceneBlueprint).revision
      : (value as PlaytestContract).revision;
}

function hashContractText(content: string): string {
  try {
    return createHash("sha256").update(JSON.stringify(JSON.parse(content))).digest("hex");
  } catch {
    return createHash("sha256").update(content).digest("hex");
  }
}

function contractLabel(type: ContractArtifactType): string {
  switch (type) {
    case "game_contract":
      return "GameContract";
    case "scene_blueprint":
      return "SceneBlueprint";
    case "playtest_contract":
      return "PlaytestContract";
  }
}
