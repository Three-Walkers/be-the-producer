const managedQaRoots = [
  "agents/qa/playtest-reports/",
  "agents/qa/playtest-runs/"
];

export function isQaHarnessManagedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return managedQaRoots.some((root) => normalized.startsWith(root));
}

export function assertQaEvidenceWriteAllowed(path: string, toolName: string): void {
  if (toolName !== "run_playtest" && isQaHarnessManagedPath(path)) {
    throw new Error(`QA 机器证据只能由 run_playtest 写入，${toolName} 无权修改：${path}`);
  }
}
