import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
const root = mkdtempSync(join(tmpdir(), "btp-contact-sheet-"));
process.env.STUDIO_WORKSPACE_ROOT = join(root, "studio");
const { createStudioKernel, defaultAgentContracts } = await import("../packages/agent-runtime/dist/index.js");
const { composeAssetContactSheet } = await import("../apps/api/dist/assetContactSheet.js");
const { captureWorkspaceSnapshot, recordHarnessWorkspaceChanges } = await import("../apps/api/dist/harnessWorkspaceEvidence.js");
const { resolveProjectWorkspaceRoot } = await import("../apps/api/dist/workspaceWriter.js");
const { hasCurrentComposedContactSheetReceipt } = await import("../apps/api/dist/mediaArtifactEvidence.js");
const { artifactReadyForConsumption } = await import("../apps/api/dist/taskOutputEvidence.js");
const { engineeringContractGuide } = await import("../apps/api/dist/engineeringContractGuide.js");
const { parseContractArtifactText } = await import("../apps/api/dist/contractArtifacts.js");
const { parseToolOperations } = await import("../apps/api/dist/claudeCliHarness.js");
try {
  assert.equal(engineeringContractGuide(["scene_blueprint", "playtest_contract"]).length, 10);
  assert.throws(() => parseContractArtifactText("scene_blueprint", '{}'), /节点是扁平/);
  const k = createStudioKernel("contact_fixture", "Contact", "producer", "fixture");
  const now = new Date().toISOString(), taskId = "task_stage_2_asset_pipeline";
  k.addTask({ taskId, projectId: k.project.projectId, ownerAgentId: "asset_production", taskLevel: "task",
    stageId: k.project.currentStage, roomId: k.getRoom("art-room").roomId, title: "Contact fixture", description: "fixture",
    status: "doing", priority: 1, sortOrder: 1, inputArtifacts: [], outputArtifacts: ["runtime", "artifact_asset_contact_sheet"],
    acceptanceCriteria: [], blockers: [], createdAt: now, updatedAt: now });
  const task = k.findTask(taskId), agent = defaultAgentContracts.find((a) => a.agentId === "asset_production");
  const workspace = resolveProjectWorkspaceRoot(k.project.projectId);
  mkdirSync(workspace, { recursive: true });
  const sourcePath = "assets/art/first-playable/hero.png", sheetPath = "agents/art/processed-assets/first-playable-contact-sheet.png";
  for (const [id, path] of [["runtime", sourcePath], ["artifact_asset_contact_sheet", sheetPath]]) k.addArtifact({
    artifactId: id, path, type: "asset", projectId: k.project.projectId, ownerAgentId: agent.agentId,
    sourceTaskId: taskId, stageId: k.project.currentStage, status: "draft", version: 1, sourceDecisionIds: [], metadata: {}, createdAt: now, updatedAt: now
  });
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([255, 0, 0, 255], i);
  const bytes = PNG.sync.write(png);
  const before = captureWorkspaceSnapshot(workspace);
  mkdirSync(dirname(join(workspace, sourcePath)), { recursive: true });
  writeFileSync(join(workspace, sourcePath), bytes);
  const generatedOp = { toolName: "generate_raster_asset", path: sourcePath, access: "write", status: "completed",
    hash: hash(bytes), sizeBytes: bytes.length, operationId: "request", operationType: "image_generation",
    providerId: "fixture", model: "fixture", requestId: "request", promptHash: "a".repeat(64), width: 4, height: 4, mime: "image/png" };
  const generated = recordHarnessWorkspaceChanges(k, task, agent, before, captureWorkspaceSnapshot(workspace), "inv1", [sourcePath], [generatedOp]);
  assert.deepEqual(generated.violations, []);
  const sheet = composeAssetContactSheet([{ path: sourcePath, label: "速射塔 <actual>", buffer: bytes }], "Contact test");
  const decoded = PNG.sync.read(sheet.buffer);
  const offset = (190 * decoded.width + 120) * 4;
  assert.deepEqual([...decoded.data.subarray(offset, offset + 4)], [255,0,0,255], "actual source pixels must be composed, not redrawn");
  const beforeSheet = captureWorkspaceSnapshot(workspace);
  mkdirSync(dirname(join(workspace, sheetPath)), { recursive: true });
  writeFileSync(join(workspace, sheetPath), sheet.buffer);
  const op = { toolName: "compose_asset_contact_sheet", path: sheetPath, access: "write", status: "completed",
    operationType: "asset_contact_sheet", operationId: sheet.receipt.outputHash, hash: sheet.receipt.outputHash,
    sizeBytes: sheet.buffer.length, contactSheetReceipt: sheet.receipt };
  // Exercise the real IPC serialization boundary, not only an in-memory receipt.
  const operationLog = join(root, "operations.jsonl");
  writeFileSync(operationLog, JSON.stringify(op) + "\n");
  const parsedOperations = parseToolOperations(operationLog);
  assert.deepEqual(parsedOperations[0].contactSheetReceipt, op.contactSheetReceipt);
  const composed = recordHarnessWorkspaceChanges(k, task, agent, beforeSheet, captureWorkspaceSnapshot(workspace), "inv2", [sheetPath], parsedOperations);
  assert.deepEqual(composed.violations, []);
  const artifact = k.listArtifacts().find((a) => a.artifactId === "artifact_asset_contact_sheet");
  assert.equal(hasCurrentComposedContactSheetReceipt(k, artifact), true);
  assert.equal(artifactReadyForConsumption(k, artifact.artifactId), true);
  const runtime = k.listArtifacts().find((a) => a.artifactId === "runtime");
  const originalLedger = structuredClone(k.listArtifactLedger().find((l) => l.artifactId === "runtime"));
  runtime.status = "change_requested";
  assert.equal(artifactReadyForConsumption(k, runtime.artifactId), false);
  const resubmit = { toolName: "resubmit_existing_asset", path: sourcePath, access: "write", status: "completed",
    hash: hash(bytes), sizeBytes: bytes.length, resubmissionReason: "Only contact sheet changed; sprite pixels remain the reviewed candidate." };
  const unchanged = captureWorkspaceSnapshot(workspace);
  const resubmitted = recordHarnessWorkspaceChanges(k, task, agent, unchanged, unchanged, "inv3", [sourcePath], [resubmit], { authoritativeWorkspace: true });
  assert.deepEqual(resubmitted.violations, []);
  assert.equal(runtime.status, "submitted");
  assert.equal(artifactReadyForConsumption(k, runtime.artifactId), true);
  assert.deepEqual(k.listArtifactLedger().find((l) => l.artifactId === "runtime"), originalLedger, "resubmission must not invent a new generation receipt");
  assert.throws(() => recordHarnessWorkspaceChanges(k, task, agent, unchanged, unchanged, "bad", [sourcePath], [{ ...resubmit, hash: "f".repeat(64) }], { authoritativeWorkspace: true }), /lacks unchanged/);
  assert.throws(() => recordHarnessWorkspaceChanges(k, task, agent, unchanged, unchanged, "bad", [sourcePath], [{ ...resubmit, resubmissionReason: "" }], { authoritativeWorkspace: true }), /lacks unchanged/);
  const originalTool = artifact.metadata.harnessToolName;
  artifact.metadata.harnessToolName = "write_artifact";
  assert.equal(hasCurrentComposedContactSheetReceipt(k, artifact), false);
  artifact.metadata.harnessToolName = originalTool;
  const beforeRegeneration = captureWorkspaceSnapshot(workspace);
  for (let i = 0; i < png.data.length; i += 4) png.data.set([0, 255, 0, 255], i);
  const regeneratedBytes = PNG.sync.write(png);
  writeFileSync(join(workspace, sourcePath), regeneratedBytes);
  const newGeneration = {...generatedOp, operationId: "request-new", requestId: "request-new", hash: hash(regeneratedBytes), sizeBytes: regeneratedBytes.length};
  const repeatedSubmission = {...resubmit, hash: newGeneration.hash, sizeBytes: newGeneration.sizeBytes};
  const afterRegeneration = captureWorkspaceSnapshot(workspace);
  const combined = recordHarnessWorkspaceChanges(k, task, agent, beforeRegeneration, afterRegeneration, "inv4", [sourcePath], [newGeneration, repeatedSubmission], {authoritativeWorkspace: true});
  assert.deepEqual(combined.violations, []);
  assert.equal(runtime.metadata.harnessToolName, "generate_raster_asset", "resubmission cannot hide the immediately preceding genuine generation");
  assert.equal(artifactReadyForConsumption(k, runtime.artifactId), true);
  assert.throws(() => recordHarnessWorkspaceChanges(k, task, agent, beforeRegeneration, afterRegeneration, "bad-intervening-write", [sourcePath],
    [newGeneration, {...newGeneration, toolName: "write_artifact"}, repeatedSubmission], {authoritativeWorkspace: true}), /lacks unchanged/,
    "never search past an intervening unauthorized/manual rewrite to recover a generation claim");
  writeFileSync(join(workspace, sourcePath), Buffer.from("mutated"));
  assert.equal(hasCurrentComposedContactSheetReceipt(k, artifact), false, "changing source bytes invalidates the composition chain");
  assert.equal(artifactReadyForConsumption(k, artifact.artifactId), false);
  assert.throws(() => composeAssetContactSheet([], "empty"));
  console.log("Contact sheet passed: actual pixel composition, source-bound immutable evidence, mutation/forgery rejected, engineering templates validated.");
} finally { rmSync(root, { recursive: true, force: true }); }
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
