import type {
  ContractJsonValue,
  SceneBlueprint,
  SceneComponentBlueprint,
  SceneEntityReference,
  SceneNodeBlueprint
} from "@game-pipeline/shared-schemas";

interface LegacyNodeDraft {
  node: SceneNodeBlueprint;
  legacyPath: string;
  legacyReferences: Record<string, string>;
}

/**
 * Explicit compatibility boundary for pre-contract SceneBlueprint documents.
 * New documents must use the versioned shared schema and never pass through
 * this adapter.
 */
export function adaptLegacySceneBlueprint(value: unknown): SceneBlueprint {
  if (!isRecord(value) || !looksLikeLegacyBlueprint(value)) {
    throw new Error("旧版 SceneBlueprint 缺少 scene、canvas、nodeHierarchy、root 或 nodes。请改用 versioned SceneBlueprint。");
  }

  const scene = isRecord(value.scene) ? value.scene : {};
  const sceneName = stringValue(value.scene_name ?? value.sceneName ?? scene.name) || "MainGame";
  const sceneId = stableIdentifier(sceneName, "main");
  const hierarchy = isRecord(value.nodeHierarchy) ? value.nodeHierarchy : {};
  const root = isRecord(hierarchy.root)
    ? hierarchy.root
    : isRecord(value.root)
      ? value.root
      : { name: "Canvas", children: Array.isArray(value.nodes) ? value.nodes : [] };
  const rootName = stringValue(root.name) || "Canvas";
  const rootChildren = recordArray(root.children);
  const roots = rootChildren.length > 0 ? rootChildren : [root];
  const usedNodeIds = new Set<string>();
  const drafts: LegacyNodeDraft[] = [];

  const visit = (candidate: Record<string, unknown>, parentNodeId: string | undefined, pathParts: string[]): void => {
    const name = stringValue(candidate.name ?? candidate.id) || "Node";
    const nodeId = uniqueIdentifier(stringValue(candidate.id) || name, "node", usedNodeIds);
    const legacyPath = [...pathParts, name].join("/");
    const componentNames = stringArray(candidate.components);
    const kind = legacyNodeKind(candidate, componentNames);
    const components = legacyComponents(candidate, componentNames, kind);
    const tags = stringArray(candidate.tags).map((tag) => stableIdentifier(tag, "tag"));
    drafts.push({
      node: {
        nodeId,
        testId: stableIdentifier(stringValue(candidate.testId ?? candidate.test_id) || nodeId, `test_${nodeId}`),
        name,
        kind,
        ...(parentNodeId ? { parentNodeId } : {}),
        transform: {
          position: pair(candidate.position, [0, 0]),
          rotation: finiteNumber(candidate.rotation, 0),
          scale: pair(candidate.scale, [1, 1]),
          size: legacySize(candidate)
        },
        components,
        tags: [...new Set(tags)]
      },
      legacyPath,
      legacyReferences: stringRecord(candidate.references)
    });
    for (const child of recordArray(candidate.children)) {
      visit(child, nodeId, [...pathParts, name]);
    }
  };

  for (const candidate of roots) {
    visit(candidate, undefined, rootChildren.length > 0 ? [rootName] : []);
  }

  const pathIndex = new Map<string, string>();
  const nameIndex = new Map<string, string[]>();
  for (const draft of drafts) {
    const normalizedPath = normalizeLegacyPath(draft.legacyPath);
    pathIndex.set(normalizedPath, draft.node.nodeId);
    pathIndex.set(stripFirstPathSegment(normalizedPath), draft.node.nodeId);
    const leaf = normalizedPath.split("/").at(-1) ?? normalizedPath;
    nameIndex.set(leaf, [...(nameIndex.get(leaf) ?? []), draft.node.nodeId]);
  }

  for (const draft of drafts) {
    const entries = Object.entries(draft.legacyReferences);
    if (entries.length === 0) continue;
    const target = draft.node.components.find((component) => !isBuiltInComponent(component.type))
      ?? draft.node.components[0];
    if (!target) {
      throw new Error(`旧版节点 ${draft.legacyPath} 声明了 references，但没有可绑定组件。`);
    }
    for (const [property, legacyTarget] of entries) {
      const normalizedTarget = normalizeLegacyPath(legacyTarget);
      const leaf = normalizedTarget.split("/").at(-1) ?? normalizedTarget;
      const candidates = nameIndex.get(leaf) ?? [];
      const referencedNodeId = pathIndex.get(normalizedTarget)
        ?? pathIndex.get(stripFirstPathSegment(normalizedTarget))
        ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!referencedNodeId) {
        throw new Error(`旧版 SceneBlueprint 引用无法解析：${draft.legacyPath}.${property} -> ${legacyTarget}`);
      }
      target.references.push({ property: stableIdentifier(property, "reference"), kind: "node", sceneId, nodeId: referencedNodeId });
    }
  }

  return {
    schemaVersion: "1.0.0",
    kind: "scene_blueprint",
    blueprintId: `legacy.${sceneId}.blueprint`,
    revision: 1,
    gameContract: { contractId: "legacy.game.contract", revision: 1 },
    entrySceneId: sceneId,
    prefabs: [],
    scenes: [{ sceneId, name: sceneName, role: "gameplay", nodes: drafts.map((draft) => draft.node) }]
  };
}

function legacyComponents(
  value: Record<string, unknown>,
  componentNames: string[],
  kind: SceneNodeBlueprint["kind"]
): SceneComponentBlueprint[] {
  const names = [...componentNames];
  if (kind === "label" && !names.some((name) => normalizeComponentType(name) === "label")) names.unshift("cc.Label");
  if ((kind === "sprite" || kind === "button") && !names.some((name) => normalizeComponentType(name) === "sprite")) names.unshift("cc.Sprite");
  if (kind === "button" && !names.some((name) => normalizeComponentType(name) === "button")) names.push("cc.Button");
  const usedComponentIds = new Set<string>();
  const components = names.map((type) => ({
    componentId: uniqueIdentifier(type, "component", usedComponentIds),
    type,
    properties: {} as Record<string, ContractJsonValue>,
    bindings: [],
    references: [] as SceneEntityReference[]
  }));
  const presentation = components.find((component) => {
    const normalized = normalizeComponentType(component.type);
    return normalized === "label" || normalized === "sprite";
  });
  const custom = components.find((component) => !isBuiltInComponent(component.type)) ?? components[0];
  const labelConfig = isRecord(value.labelConfig) ? value.labelConfig : {};
  const spriteConfig = isRecord(value.spriteConfig) ? value.spriteConfig : {};
  const colorConfig = isRecord(value.colorConfig) ? value.colorConfig : {};
  if (presentation) {
    const text = stringValue(value.text ?? labelConfig.defaultText);
    if (text) presentation.properties[kind === "label" ? "string" : "text"] = text;
    const fontSize = finiteNumberOrUndefined(labelConfig.fontSize);
    if (fontSize !== undefined) presentation.properties.fontSize = fontSize;
    const color = stringValue(labelConfig.color);
    if (color) presentation.properties.color = color;
    const assetKey = stringValue(value.asset_key ?? value.assetKey ?? spriteConfig.defaultAsset);
    if (assetKey) presentation.properties.assetKey = assetKey;
    const fallbackColor = stringValue(colorConfig.safe ?? colorConfig.default);
    if (fallbackColor) presentation.properties.fallbackColor = fallbackColor;
  }
  if (custom && isRecord(value.properties)) {
    for (const [key, entry] of Object.entries(value.properties)) {
      if (isJsonValue(entry)) custom.properties[key] = entry;
    }
  }
  if (custom && isRecord(value.poolConfig)) {
    for (const [key, entry] of Object.entries(value.poolConfig)) {
      if (isJsonValue(entry)) custom.properties[key] = entry;
    }
  }
  return components;
}

function legacyNodeKind(value: Record<string, unknown>, components: string[]): SceneNodeBlueprint["kind"] {
  const explicit = stringValue(value.type).toLowerCase();
  const normalizedComponents = new Set(components.map(normalizeComponentType));
  if (explicit === "label" || normalizedComponents.has("label")) return "label";
  if (explicit === "button" || normalizedComponents.has("button")) return "button";
  if (explicit === "sprite" || normalizedComponents.has("sprite")) return "sprite";
  if (explicit === "camera" || normalizedComponents.has("camera")) return "camera";
  if (explicit === "audio" || normalizedComponents.has("audiosource")) return "audio";
  return recordArray(value.children).length > 0 ? "container" : "custom";
}

function legacySize(value: Record<string, unknown>): [number, number] {
  const size = value.size;
  if (Array.isArray(size)) return [finiteNumber(size[0], 100), finiteNumber(size[1], 100)];
  if (isRecord(size)) return [finiteNumber(size.width, 100), finiteNumber(size.height, 100)];
  return [100, 100];
}

function pair(value: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(value)) return [finiteNumber(value[0], fallback[0]), finiteNumber(value[1], fallback[1])];
  if (isRecord(value)) return [finiteNumber(value.x, fallback[0]), finiteNumber(value.y, fallback[1])];
  return fallback;
}

function looksLikeLegacyBlueprint(value: Record<string, unknown>): boolean {
  return ["scene", "scene_name", "sceneName", "canvas", "nodeHierarchy", "root", "nodes"].some((key) => key in value);
}

function stableIdentifier(value: string, fallback: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/[._-]{2,}/g, "_")
    .replace(/[._-]+$/, "");
  return normalized || fallback;
}

function uniqueIdentifier(value: string, fallback: string, used: Set<string>): string {
  const base = stableIdentifier(value, fallback);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

function normalizeLegacyPath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).join("/").toLowerCase();
}

function stripFirstPathSegment(value: string): string {
  const segments = value.split("/");
  return segments.length > 1 ? segments.slice(1).join("/") : value;
}

function normalizeComponentType(value: string): string {
  return value.replace(/^cc\./i, "").toLowerCase();
}

function isBuiltInComponent(value: string): boolean {
  return ["label", "sprite", "button", "audiosource", "camera", "uitransform"].includes(normalizeComponentType(value));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is ContractJsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
