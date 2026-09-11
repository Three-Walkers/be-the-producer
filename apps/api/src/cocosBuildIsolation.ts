import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePathWithinRoot } from "./pathSafety.js";

/** Creator imports mutate editor-only state throughout a project, even during
 * a command-line build. Keep those side effects inside the native invocation:
 * artifacts in the build output remain, while authored metadata/configuration
 * are restored byte-for-byte. Other source mutations remain visible to the
 * outer workspace guard, which will reject them normally. */
export function withIsolatedCreatorMetadata<T>(projectRoot: string, run: () => T): T {
  const before = snapshotMetadata(projectRoot);
  try {
    return run();
  } finally {
    const after = snapshotMetadata(projectRoot);
    for (const path of after.keys()) {
      if (!before.has(path)) {
        const target = resolvePathWithinRoot(projectRoot, path, { allowMissing: false, expectedKind: "file", label: "Creator 临时元数据" });
        unlinkSync(target.absolutePath);
      }
    }
    for (const [path, bytes] of before) {
      if (after.get(path)?.equals(bytes)) continue;
      const target = resolvePathWithinRoot(projectRoot, path, { allowMissing: true, expectedKind: "file", label: "Creator 原始元数据" });
      mkdirSync(dirname(target.absolutePath), { recursive: true });
      writeFileSync(target.absolutePath, bytes);
    }
  }
}

function snapshotMetadata(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (path: string, onlyMeta = false): void => {
    const target = resolvePathWithinRoot(root, path, { allowMissing: true, label: "Creator 构建元数据" });
    if (!existsSync(target.absolutePath)) return;
    for (const entry of readdirSync(target.absolutePath, { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Creator 元数据拒绝符号链接：${child}`);
      if (entry.isDirectory()) visit(child, onlyMeta);
      else if (entry.isFile() && (!onlyMeta || child.endsWith(".meta"))) {
        const file = resolvePathWithinRoot(root, child, { allowMissing: false, expectedKind: "file", label: "Creator 元数据文件" });
        files.set(child, readFileSync(file.absolutePath));
      }
    }
  };
  const manifest = resolvePathWithinRoot(root, "package.json", { allowMissing: true, expectedKind: "file", label: "Creator 项目配置" });
  if (existsSync(manifest.absolutePath)) files.set("package.json", readFileSync(manifest.absolutePath));
  visit("assets", true);
  visit("settings");
  visit("profiles");
  return files;
}
