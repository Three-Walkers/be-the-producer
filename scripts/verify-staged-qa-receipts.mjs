import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIsolatedWorkspace, stageWorkspaceCommit } from "../apps/api/dist/isolatedWorkspace.js";
import { writeQaPlaytestReceipt, readVerifiedQaPlaytestReceipts, verifiedQaReceiptCommitPaths } from "../apps/api/dist/qaPlaytestReceipt.js";
import { renderPlaytestMarker } from "../apps/api/dist/playtestEvidence.js";

const root = mkdtempSync(join(tmpdir(), "btp-staged-qa-"));
const project = join(root, "project");
mkdirSync(project);
const staging = createIsolatedWorkspace(project, "qa-fixture");
try {
  const path = "agents/qa/playtest-reports/first-playable.md";
  const result = {
    schemaVersion: 1, operationId: "playtest_fixture", verdict: "fail", completedAt: new Date().toISOString(),
    checks: [{ checkId: "launch", status: "failed", label: "Launch", details: "Fixture game fails to launch" }],
    defects: [], evidencePaths: [path], runtime: { consoleErrorCount: 1, durationMs: 100 }
  };
  const body = renderPlaytestMarker(result);
  mkdirSync(join(staging.root, "agents/qa/playtest-reports"), { recursive: true });
  writeFileSync(join(staging.root, path), body);
  const file = { path, hash: createHash("sha256").update(body).digest("hex"), sizeBytes: Buffer.byteLength(body) };
  writeQaPlaytestReceipt(staging.root, path, result, [file]);
  const operation = { ...file, toolName: "run_playtest", operationType: "playtest", operationId: result.operationId, status: "completed" };
  assert.deepEqual(verifiedQaReceiptCommitPaths(staging.root, [path], []), []);
  assert.deepEqual(verifiedQaReceiptCommitPaths(staging.root, [path], [{ ...operation, hash: "f".repeat(64) }]), []);
  assert.deepEqual(verifiedQaReceiptCommitPaths(staging.root, [path], [{ ...operation, toolName: "write_artifact" }]), []);
  assert.deepEqual(verifiedQaReceiptCommitPaths(staging.root, ["other.md"], [operation]), []);
  const receipts = verifiedQaReceiptCommitPaths(staging.root, [path], [operation]);
  assert.equal(receipts.length, 1);
  const rollback = stageWorkspaceCommit(project, staging.root, [path, ...receipts]);
  assert.equal(readVerifiedQaPlaytestReceipts(project)[0]?.result.verdict, "fail");
  rollback.rollback();
  assert.equal(readVerifiedQaPlaytestReceipts(project).length, 0);
  stageWorkspaceCommit(project, staging.root, [path, ...receipts]).finalize();
  staging.dispose();
  assert.equal(readVerifiedQaPlaytestReceipts(project)[0]?.result.verdict, "fail", "failure evidence survives worker disposal without becoming a pass");
  assert.equal(readFileSync(join(project, path), "utf8"), body);
  console.log("Staged QA receipts passed: trusted byte-bound promotion, failure preservation, atomic rollback, no private directory copying.");
} finally {
  staging.dispose();
  rmSync(root, { recursive: true, force: true });
}
