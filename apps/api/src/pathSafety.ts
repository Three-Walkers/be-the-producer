import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type SafePathKind = "any" | "file" | "directory";

export interface ResolvePathWithinRootOptions {
  allowMissing?: boolean;
  allowRoot?: boolean;
  expectedKind?: SafePathKind;
  label?: string;
}

export interface SafeResolvedPath {
  rootPath: string;
  canonicalRootPath: string;
  relativePath: string;
  absolutePath: string;
  exists: boolean;
}

/**
 * Resolves a project-relative path without following symbolic links below the
 * supplied trust root. Every existing component is checked with lstat and each
 * existing real path must remain below the canonical root.
 *
 * This is the local, single-process filesystem boundary. It intentionally does
 * not claim to close hostile multi-process TOCTOU races (which would require an
 * openat/O_NOFOLLOW style native implementation), but all callers revalidate
 * after creating parent directories and before touching file contents.
 */
export function resolvePathWithinRoot(
  root: string,
  path: string,
  options: ResolvePathWithinRootOptions = {}
): SafeResolvedPath {
  const label = options.label ?? "路径";
  const rootPath = resolve(root);
  const relativePath = normalizeRelativePathWithinRoot(path, {
    allowRoot: options.allowRoot ?? false,
    label
  });
  const absolutePath = relativePath === "." ? rootPath : resolve(rootPath, relativePath);
  assertLexicallyContained(rootPath, absolutePath, label);

  const rootStats = lstatIfExists(rootPath);
  const rootExists = Boolean(rootStats);
  if (rootStats) {
    if (rootStats.isSymbolicLink()) {
      throw new Error(`${label}的根目录不能是符号链接：${rootPath}`);
    }
    if (!rootStats.isDirectory()) {
      throw new Error(`${label}的根路径不是目录：${rootPath}`);
    }
  }

  const canonicalRootPath = rootExists
    ? realpathSync(rootPath)
    : canonicalizeMissingPath(rootPath);
  let current = rootPath;
  let missingComponentSeen = !rootExists;
  const components = relativePath === "." ? [] : relativePath.split(sep);

  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const stats = lstatIfExists(current);
    if (!stats) {
      missingComponentSeen = true;
      continue;
    }
    if (missingComponentSeen) {
      // A descendant cannot exist below a missing ordinary directory. Treat an
      // inconsistent view as unsafe instead of attempting to recover.
      throw new Error(`${label}在校验期间发生变化，已拒绝：${relativePath}`);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label}包含符号链接，已拒绝：${relative(rootPath, current).split(sep).join("/")}`);
    }
    const isTarget = index === components.length - 1;
    if (!isTarget && !stats.isDirectory()) {
      throw new Error(`${label}的父路径不是目录：${relative(rootPath, current).split(sep).join("/")}`);
    }
    assertCanonicalContained(canonicalRootPath, realpathSync(current), label);
  }

  const targetStats = lstatIfExists(absolutePath);
  const targetExists = Boolean(targetStats);
  if (!targetExists && options.allowMissing === false) {
    throw new Error(`${label}不存在：${relativePath}`);
  }
  if (targetStats) {
    if (targetStats.isSymbolicLink()) {
      throw new Error(`${label}不能是符号链接：${relativePath}`);
    }
    const expectedKind = options.expectedKind ?? "any";
    if (expectedKind === "file" && !targetStats.isFile()) {
      throw new Error(`${label}不是普通文件：${relativePath}`);
    }
    if (expectedKind === "directory" && !targetStats.isDirectory()) {
      throw new Error(`${label}不是目录：${relativePath}`);
    }
    assertCanonicalContained(canonicalRootPath, realpathSync(absolutePath), label);
  }

  return {
    rootPath,
    canonicalRootPath,
    relativePath: relativePath.split(sep).join("/"),
    absolutePath,
    exists: targetExists
  };
}

export function normalizeRelativePathWithinRoot(
  path: string,
  options: { allowRoot?: boolean; label?: string } = {}
): string {
  const label = options.label ?? "路径";
  if (typeof path !== "string" || path.includes("\0")) {
    throw new Error(`${label}非法。`);
  }
  const cleaned = path.trim().replace(/^\.\/+/, "");
  const normalized = normalize(cleaned);
  if (
    !cleaned ||
    isAbsolute(cleaned) ||
    isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized.split(sep).includes("..")
  ) {
    throw new Error(`${label}不安全：${path}`);
  }
  if (normalized === "." && !options.allowRoot) {
    throw new Error(`${label}必须指向根目录内的具体目标。`);
  }
  return normalized;
}

export function assertSafePathSegment(value: string, label = "路径标识"): string {
  if (!value || value === "." || value === ".." || value.includes("\0") || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label}非法：${value}`);
  }
  return value;
}

export function assertSafeAbsoluteFile(path: string, label = "文件路径"): string {
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  return resolvePathWithinRoot(parent, basename(absolutePath), {
    allowMissing: false,
    expectedKind: "file",
    label
  }).absolutePath;
}

function canonicalizeMissingPath(path: string): string {
  let current = path;
  const missing: string[] = [];
  let currentStats = lstatIfExists(current);
  while (!currentStats) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`无法找到路径的现存父目录：${path}`);
    }
    missing.unshift(basename(current));
    current = parent;
    currentStats = lstatIfExists(current);
  }
  if (currentStats.isSymbolicLink()) {
    throw new Error(`路径的现存父目录不能是符号链接：${current}`);
  }
  if (!currentStats.isDirectory()) {
    throw new Error(`路径的现存父路径不是目录：${current}`);
  }
  return resolve(realpathSync(current), ...missing);
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertLexicallyContained(root: string, target: string, label: string): void {
  const child = relative(root, target);
  if (child === "" || child === ".") return;
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`${label}超出允许的根目录。`);
  }
}

function assertCanonicalContained(canonicalRoot: string, canonicalTarget: string, label: string): void {
  const child = relative(canonicalRoot, canonicalTarget);
  if (child === "" || child === ".") return;
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error(`${label}的真实路径超出允许的根目录。`);
  }
}
