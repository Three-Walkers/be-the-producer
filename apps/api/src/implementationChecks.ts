import ts from "typescript";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseSceneBlueprint, type SceneDefinition } from "@game-pipeline/shared-schemas";
import { resolvePathWithinRoot } from "./pathSafety.js";
import { discoverScriptComponents, projectScriptPaths } from "./cocosScriptComponents.js";

export const implementationCheckVersion = "1.0.0";
export const implementationBlueprintPath = "agents/engineering/cocos-scene-blueprints/main.scene-blueprint.json";
export interface ImplementationFinding {
  code: string;
  severity: "error" | "warning";
  path: string;
  line?: number;
  details: string;
  ownerAgentId: "gameplay_programmer" | "cocos_tech_lead" | "cocos_automation";
}
export interface ImplementationCheckResult {
  version: string;
  fingerprint: string;
  status: "pass" | "fail" | "blocked";
  scope: "static_integration_only";
  files: Array<{ path: string; hash: string }>;
  findings: ImplementationFinding[];
}

/** Uses installed Creator declarations, never a project-authored fake cc stub. */
export function creatorDeclarationPath(executable: string): string | undefined {
  if (!executable) return undefined;
  return [join(dirname(executable), "../Resources/resources/3d/engine/bin/.declarations/cc.d.ts"),
    join(dirname(executable), "resources/resources/3d/engine/bin/.declarations/cc.d.ts")].find(existsSync);
}

export function implementationFingerprint(projectRoot: string, declarationPath?: string): {
  fingerprint: string; files: ImplementationCheckResult["files"];
} {
  // Bridge-generated bootstrap is a build output, not an author input. Including
  // it would invalidate the self-check during the very build it authorizes.
  const paths = [...projectScriptPaths(projectRoot).filter((path) => !path.startsWith("assets/scripts/btp/")), implementationBlueprintPath];
  const files = paths.map((path) => {
    const target = resolvePathWithinRoot(projectRoot, path, { allowMissing: true });
    return { path, hash: existsSync(target.absolutePath) ? hash(readFileSync(target.absolutePath)) : "missing" };
  });
  const engineHash = declarationPath && existsSync(declarationPath) ? hash(readFileSync(declarationPath)) : "missing";
  return { files, fingerprint: hash(JSON.stringify({ version: implementationCheckVersion, files, engineHash })) };
}

const checkCache = new Map<string, ImplementationCheckResult>();

export function runImplementationChecks(projectRoot: string, executable: string): ImplementationCheckResult {
  const declarations = creatorDeclarationPath(executable);
  const { fingerprint, files } = implementationFingerprint(projectRoot, declarations);
  const cached = checkCache.get(fingerprint);
  if (cached) return structuredClone(cached);
  const findings: ImplementationFinding[] = [];
  const scripts = files.filter((file) => /\.tsx?$/.test(file.path));
  if (scripts.length === 0) findings.push({ code: "missing_source", severity: "error", path: "assets/scripts",
    ownerAgentId: "gameplay_programmer", details: "No implementation TypeScript source exists." });
  if (!declarations) findings.push({ code: "missing_creator_types", severity: "error", path: "assets/scripts",
    ownerAgentId: "cocos_automation", details: "Installed Creator cc.d.ts is unavailable; semantic type checking is blocked, not passed." });
  else {
    const roots = scripts.map((file) => resolvePathWithinRoot(projectRoot, file.path, { allowMissing: false }).absolutePath);
    const program = ts.createProgram([...roots, declarations], {
      noEmit: true, strict: true, skipLibCheck: true, experimentalDecorators: true,
      useDefineForClassFields: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], allowJs: false,
      paths: { cc: [declarations] }
    });
    for (const diagnostic of ts.getPreEmitDiagnostics(program).filter((d) => d.category === ts.DiagnosticCategory.Error)) {
      const path = diagnostic.file ? relative(projectRoot, diagnostic.file.fileName).split("\\").join("/") : "assets/scripts";
      findings.push({ code: `TS${diagnostic.code}`, severity: "error", path,
        ...(diagnostic.file && diagnostic.start !== undefined ? { line: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 } : {}),
        ownerAgentId: path.startsWith("assets/scripts/btp/") ? "cocos_automation" : "gameplay_programmer",
        details: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") });
    }
  }
  try {
    const components = discoverScriptComponents(projectRoot);
    const blueprint = parseSceneBlueprint(JSON.parse(readFileSync(resolvePathWithinRoot(projectRoot, implementationBlueprintPath, { allowMissing: false }).absolutePath, "utf8")));
    const available = new Set([...components.map((component) => component.className), "Label", "Sprite", "Button", "AudioSource", "Camera", "UITransform"]);
    for (const scene of blueprint.scenes) {
      for (const node of scene.nodes) for (const component of node.components) {
        const type = component.type.replace(/^cc\./, "");
        if (!available.has(type)) findings.push({ code: "missing_component", severity: "error", path: implementationBlueprintPath,
          ownerAgentId: "gameplay_programmer", details: `${scene.sceneId}/${node.nodeId}: blueprint requires unimplemented @ccclass ${component.type}.` });
        if (type === "Sprite" && !component.properties.assetKey) findings.push({ code: "sprite_without_asset", severity: "warning", path: implementationBlueprintPath,
          ownerAgentId: "cocos_tech_lead", details: `${scene.sceneId}/${node.nodeId}: Sprite has no assetKey; QA must verify real runtime texture loading, not assume a colored placeholder is finished art.` });
      }
      inspectInitialLayout(scene, findings);
    }
  } catch (error) {
    findings.push({ code: "assembly_contract", severity: "error", path: implementationBlueprintPath,
      ownerAgentId: "cocos_tech_lead", details: error instanceof Error ? error.message : String(error) });
  }
  const result: ImplementationCheckResult = { version: implementationCheckVersion, fingerprint, files, scope: "static_integration_only",
    status: !declarations ? "blocked" : findings.some((finding) => finding.severity === "error") ? "fail" : "pass", findings };
  if (checkCache.size > 24) checkCache.clear();
  checkCache.set(fingerprint, result);
  return structuredClone(result);
}

function inspectInitialLayout(scene: SceneDefinition, findings: ImplementationFinding[]): void {
  const resolution = scene.nodes.map((node) => node.transform.size).filter((size): size is [number, number] => !!size)
    .sort((left, right) => right[0] * right[1] - left[0] * left[1])[0];
  if (!resolution) return;
  const nodes = new Map(scene.nodes.map((node) => [node.nodeId, node]));
  for (const node of scene.nodes.filter((node) => node.components.some((component) => component.type.replace(/^cc\./, "") === "Button"))) {
    let x = 0, y = 0, cursor: typeof node | undefined = node;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.nodeId)) {
      visited.add(cursor.nodeId);
      if (cursor.transform.rotation !== 0 || cursor.transform.scale.some((value) => value !== 1)) break;
      x += cursor.transform.position[0]; y += cursor.transform.position[1];
      cursor = cursor.parentNodeId ? nodes.get(cursor.parentNodeId) : undefined;
    }
    if (!cursor && (Math.abs(x) > resolution[0] / 2 || Math.abs(y) > resolution[1] / 2)) {
      findings.push({ code: "button_outside_initial_viewport", severity: "warning", path: implementationBlueprintPath,
        ownerAgentId: "cocos_tech_lead", details: `${scene.sceneId}/${node.nodeId} (${node.testId}): initial world center (${x}, ${y}) is outside ${resolution[0]}×${resolution[1]}. Independently verify visibility/reachability in the intended state; hidden animated panels may be intentional.` });
    }
  }
}

function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
