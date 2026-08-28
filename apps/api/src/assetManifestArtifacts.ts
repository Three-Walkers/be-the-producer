import {
  ASSET_MANIFEST_SCHEMA_VERSION,
  parseAssetManifest,
  type ParsedAssetManifest
} from "@game-pipeline/shared-schemas";

/** Parse a production Asset Manifest and reject legacy/empty declarations early. */
export function parseCurrentAssetManifestText(content: string): ParsedAssetManifest {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Asset Manifest 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = parseAssetManifest(value);
  if (manifest.migrationRequired || manifest.schemaVersion !== ASSET_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Asset Manifest 必须使用 schemaVersion=${ASSET_MANIFEST_SCHEMA_VERSION}，并为每个 runtimePath 显式声明 alphaPolicy。`
    );
  }
  if (manifest.runtimeAssets.length === 0) {
    throw new Error("Asset Manifest 至少要声明一个 runtimePath。");
  }
  return manifest;
}
