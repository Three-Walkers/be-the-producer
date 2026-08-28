/**
 * Compatibility-normalized runtime asset declarations.
 *
 * Asset manifests historically had no schema version and nested runtimePath
 * entries under arbitrary category objects.  Version 2 keeps that nesting for
 * compatibility but makes alpha intent explicit per runtime asset.  An
 * unversioned/v1 manifest is accepted as legacy input and a missing policy is
 * migrated to `optional`; v2 never guesses and rejects a missing policy.
 */

export const ASSET_MANIFEST_SCHEMA_VERSION = "2.0.0" as const;

export type AssetAlphaPolicy = "required" | "opaque" | "optional";
export type AssetAlphaPolicySource = "declared" | "legacy_default_optional";

export interface RuntimeAssetManifestEntry {
  id: string;
  runtimePath: string;
  alphaPolicy: AssetAlphaPolicy;
  alphaPolicySource: AssetAlphaPolicySource;
}

export interface ParsedAssetManifest {
  schemaVersion: typeof ASSET_MANIFEST_SCHEMA_VERSION | "legacy";
  migrationRequired: boolean;
  runtimeAssets: RuntimeAssetManifestEntry[];
}

export class AssetManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetManifestValidationError";
  }
}

export function parseAssetManifest(value: unknown): ParsedAssetManifest {
  if (!isRecord(value)) {
    throw new AssetManifestValidationError("Asset manifest 根节点必须是对象。");
  }
  const schemaVersion = parseSchemaVersion(value.schemaVersion ?? value.schema_version);
  const current = schemaVersion === ASSET_MANIFEST_SCHEMA_VERSION;
  const runtimeAssets: RuntimeAssetManifestEntry[] = [];

  const visit = (candidate: unknown, location: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${location}[${index}]`));
      return;
    }
    if (!isRecord(candidate)) return;

    const rawPath = firstDefined(candidate.runtimePath, candidate.runtime_path, candidate.cocosPath, candidate.cocos_path);
    if (rawPath !== undefined) {
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        throw new AssetManifestValidationError(`${location}.runtimePath 必须是非空字符串。`);
      }
      const runtimePath = normalizeRuntimePath(rawPath, location);
      const rawPolicy = firstDefined(candidate.alphaPolicy, candidate.alpha_policy);
      let alphaPolicy: AssetAlphaPolicy;
      let alphaPolicySource: AssetAlphaPolicySource;
      if (rawPolicy === undefined) {
        if (current) {
          throw new AssetManifestValidationError(
            `${location}.alphaPolicy 在 ${ASSET_MANIFEST_SCHEMA_VERSION} 清单中为必填项。`
          );
        }
        alphaPolicy = "optional";
        alphaPolicySource = "legacy_default_optional";
      } else if (rawPolicy === "required" || rawPolicy === "opaque" || rawPolicy === "optional") {
        alphaPolicy = rawPolicy;
        alphaPolicySource = "declared";
      } else {
        throw new AssetManifestValidationError(
          `${location}.alphaPolicy 必须是 required、opaque 或 optional。`
        );
      }
      const rawId = firstDefined(candidate.id, candidate.assetId, candidate.asset_id);
      const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : defaultAssetId(runtimePath);
      runtimeAssets.push({ id, runtimePath, alphaPolicy, alphaPolicySource });
      return;
    }
    for (const [key, entry] of Object.entries(candidate)) {
      if (location === "$" && (key === "schemaVersion" || key === "schema_version")) continue;
      visit(entry, `${location}.${key}`);
    }
  };

  visit(value, "$");
  const seenPaths = new Set<string>();
  for (const asset of runtimeAssets) {
    if (seenPaths.has(asset.runtimePath)) {
      throw new AssetManifestValidationError(`Asset manifest runtimePath 重复：${asset.runtimePath}`);
    }
    seenPaths.add(asset.runtimePath);
  }
  return {
    schemaVersion: current ? ASSET_MANIFEST_SCHEMA_VERSION : "legacy",
    migrationRequired: !current,
    runtimeAssets
  };
}

function parseSchemaVersion(value: unknown): typeof ASSET_MANIFEST_SCHEMA_VERSION | "legacy" {
  if (value === undefined || value === 1 || value === "1" || value === "1.0.0") return "legacy";
  if (value === 2 || value === "2" || value === ASSET_MANIFEST_SCHEMA_VERSION) {
    return ASSET_MANIFEST_SCHEMA_VERSION;
  }
  throw new AssetManifestValidationError(`不支持的 asset manifest schemaVersion：${String(value)}`);
}

function normalizeRuntimePath(value: string, location: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.split("/").some((segment) => segment === ".." || segment === "." || !segment)
  ) {
    throw new AssetManifestValidationError(`${location}.runtimePath 必须是规范的项目相对路径。`);
  }
  return path;
}

function defaultAssetId(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
