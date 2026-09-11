import ts from "typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { resolvePathWithinRoot } from "./pathSafety.js";

export interface ScriptComponent {
  className: string;
  exportName: string;
  importPath: string;
  sourcePath: string;
  defaultExport: boolean;
}

export function projectScriptPaths(projectRoot: string): string[] {
  const paths: string[] = [];
  const walk = (path: string): void => {
    const target = resolvePathWithinRoot(projectRoot, path, { allowMissing: true });
    if (!existsSync(target.absolutePath)) return;
    for (const entry of readdirSync(target.absolutePath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Script tree contains a symbolic link: ${path}/${entry.name}`);
      if (entry.isDirectory()) walk(`${path}/${entry.name}`);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) paths.push(`${path}/${entry.name}`);
      if (paths.length > 2000) throw new Error("Script tree exceeds 2000 source files.");
    }
  };
  walk("assets/scripts");
  return paths.sort();
}

/** Registration identity and TypeScript export identity are different. Never
 * silently discard additional components or choose a duplicate by file order. */
export function discoverScriptComponents(projectRoot: string): ScriptComponent[] {
  const components: ScriptComponent[] = [];
  const bootstrap = resolvePathWithinRoot(projectRoot, "assets/scripts/btp", { allowMissing: true }).absolutePath;
  for (const path of projectScriptPaths(projectRoot).filter((path) => !path.startsWith("assets/scripts/btp/"))) {
    const absolute = resolvePathWithinRoot(projectRoot, path, { allowMissing: false }).absolutePath;
    const source = ts.createSourceFile(path, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isClassDeclaration(node)) continue;
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
      const ccclass = decorators.map((decorator) => decorator.expression).find((expression) =>
        ts.isCallExpression(expression) &&
        (ts.isIdentifier(expression.expression) ? expression.expression.text === "ccclass" :
          ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "ccclass"));
      if (!ccclass || !ts.isCallExpression(ccclass)) continue;
      const name = ccclass.arguments[0];
      const modifiers = ts.getModifiers(node) ?? [];
      if (!name || !ts.isStringLiteral(name) || !name.text.trim()) throw new Error(`${path}: @ccclass requires a nonempty literal registration name.`);
      if (!node.name || !modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        throw new Error(`${path}: @ccclass(${name.text}) must be an exported named class for blueprint assembly.`);
      }
      if (components.some((component) => component.className === name.text)) throw new Error(`Duplicate @ccclass registration: ${name.text} (${path})`);
      const importPath = relative(bootstrap, absolute).split(sep).join("/").replace(/\.tsx?$/, "");
      components.push({ className: name.text, exportName: node.name.text, sourcePath: path,
        defaultExport: modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
        importPath: importPath.startsWith(".") ? importPath : `./${importPath}` });
    }
  }
  return components.sort((left, right) => left.className.localeCompare(right.className));
}
