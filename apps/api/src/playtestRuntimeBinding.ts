import { existsSync } from "node:fs";
import { loadPlaytestContract } from "./playtestContractLoader.js";
import { resolvePathWithinRoot } from "./pathSafety.js";

export const playtestRuntimeBindingPath = "assets/resources/btp/playtest-binding.json";

/** Build-owned identity only: never supplies state, signals or a test verdict. */
export function readPlaytestRuntimeBinding(projectRoot: string) {
  const loaded = loadPlaytestContract(projectRoot);
  if (!loaded) {
    const previous = resolvePathWithinRoot(projectRoot, playtestRuntimeBindingPath, {
      allowMissing: true, expectedKind: "file", label: "Playtest runtime binding"
    });
    if (existsSync(previous.absolutePath)) throw new Error("PlaytestContract 已缺失，但工程残留运行时契约绑定；拒绝构建旧绑定。");
    return undefined;
  }
  return {
    protocolVersion: "1.0.0" as const,
    playtestId: loaded.contract.playtestId,
    revision: loaded.contract.revision,
    contractHash: loaded.hash
  };
}
