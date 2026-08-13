import type { StudioKernel } from "@game-pipeline/agent-runtime";
import {
  parseGameContract,
  parsePlaytestContract,
  parseSceneBlueprint,
  validatePlaytestContractCompatibility,
  validateSceneBlueprintCompatibility,
  type ContractValidationIssue,
  type GameContract,
  type PlaytestContract,
  type SceneBlueprint
} from "@game-pipeline/shared-schemas";
import type { Artifact } from "@game-pipeline/shared-schemas";
import { readArtifactContentForModel } from "./workspaceWriter.js";
import { isContractArtifactType, parseContractArtifactText, type ContractArtifactType } from "./contractArtifacts.js";

export interface ProjectContractSet {
  gameContract?: { artifact: Artifact; value: GameContract };
  sceneBlueprint?: { artifact: Artifact; value: SceneBlueprint };
  playtestContract?: { artifact: Artifact; value: PlaytestContract };
}

export function readProjectContracts(kernel: StudioKernel): ProjectContractSet {
  const result: ProjectContractSet = {};
  for (const artifact of newestContractArtifacts(kernel)) {
    const content = readArtifactContentForModel(kernel.project.projectId, artifact, 2_000_000);
    if (!content) continue;
    try {
      switch (artifact.type) {
        case "game_contract":
          result.gameContract ??= { artifact, value: parseGameContract(JSON.parse(content) as unknown) };
          break;
        case "scene_blueprint":
          result.sceneBlueprint ??= { artifact, value: parseSceneBlueprint(JSON.parse(content) as unknown) };
          break;
        case "playtest_contract":
          result.playtestContract ??= { artifact, value: parsePlaytestContract(JSON.parse(content) as unknown) };
          break;
      }
    } catch {
      // Invalid candidates are rejected by readiness checks; continue so an older
      // valid, non-superseded contract can still be inspected during migration.
    }
  }
  return result;
}

export function assertProjectContractCompatibility(
  kernel: StudioKernel,
  type: ContractArtifactType,
  content: string
): void {
  const candidate = parseContractArtifactText(type, content);
  const current = readProjectContracts(kernel);
  if (type === "game_contract") return;

  if (!current.gameContract) {
    throw new Error(`${contractName(type)} 需要一个已物化且有效的 GameContract。`);
  }

  if (type === "scene_blueprint") {
    const compatibility = validateSceneBlueprintCompatibility(candidate as SceneBlueprint, current.gameContract.value);
    assertCompatibility("SceneBlueprint", compatibility);
    return;
  }

  if (!current.sceneBlueprint) {
    throw new Error("PlaytestContract 需要一个已物化且有效的 SceneBlueprint。");
  }
  const compatibility = validatePlaytestContractCompatibility(
    candidate as PlaytestContract,
    current.gameContract.value,
    current.sceneBlueprint.value
  );
  assertCompatibility("PlaytestContract", compatibility);
}

export function projectContractArtifactIsCompatible(kernel: StudioKernel, artifact: Artifact): boolean {
  if (!isContractArtifactType(artifact.type)) return true;
  const content = readArtifactContentForModel(kernel.project.projectId, artifact, 2_000_000);
  if (!content) return false;
  try {
    assertProjectContractCompatibility(kernel, artifact.type, content);
    return true;
  } catch {
    return false;
  }
}

function newestContractArtifacts(kernel: StudioKernel): Artifact[] {
  return kernel
    .listArtifacts()
    .filter((artifact) => isContractArtifactType(artifact.type) && !["rejected", "superseded"].includes(artifact.status))
    .sort((left, right) => right.version - left.version || right.updatedAt.localeCompare(left.updatedAt));
}

function assertCompatibility(
  name: string,
  result: { ok: true } | { ok: false; issues: ContractValidationIssue[] }
): void {
  if (result.ok) return;
  const details = result.issues.slice(0, 12).map((issue) => `${issue.path}: ${issue.message}`).join("；");
  throw new Error(`${name} 与上游契约不兼容：${details}`);
}

function contractName(type: Exclude<ContractArtifactType, "game_contract">): string {
  return type === "scene_blueprint" ? "SceneBlueprint" : "PlaytestContract";
}
