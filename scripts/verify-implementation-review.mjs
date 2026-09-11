import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createStudioKernel, createStudioKernelFromSnapshot, defaultAgentContracts } from "../packages/agent-runtime/dist/index.js";
import { captureWorkspaceSnapshot, recordHarnessWorkspaceChanges } from "../apps/api/dist/harnessWorkspaceEvidence.js";
import { parseToolOperations } from "../apps/api/dist/claudeCliHarness.js";
import { artifactReadyForConsumption, taskOutputsVerified } from "../apps/api/dist/taskOutputEvidence.js";
import { resumeSupersededImplementationTasks } from "../apps/api/dist/agentLoop.js";
import { captureCurrentStageReviewOutputEvidence, reconcileCurrentStageReviewOutputEvidence } from "../apps/api/dist/evidenceReconciliation.js";
import { executeAgentToolRequests } from "../apps/api/dist/toolExecutor.js";
import { createIsolatedWorkspace, stageWorkspaceCommit } from "../apps/api/dist/isolatedWorkspace.js";
import { syncProjectWorkspace } from "../apps/api/dist/workspaceWriter.js";
import { runImplementationChecks, implementationBlueprintPath } from "../apps/api/dist/implementationChecks.js";
import { discoverScriptComponents } from "../apps/api/dist/cocosScriptComponents.js";
import { validateImplementationReview, reviewFacets, selfCheckPath, implementationReviewPath, applyImplementationReviewFeedback } from "../apps/api/dist/implementationReview.js";
import { sceneBlueprintExample } from "../apps/api/dist/engineeringContractGuide.js";

const root = mkdtempSync(join(tmpdir(), "btp-implementation-verification-"));
const project = join(root, "project");
const executable = join(root, "Creator.app/Contents/MacOS/CocosCreator");
const sourcePath = "assets/scripts/gameplay/Controller.ts";
const baselinePath = "agents/design/gdd/00_overview.md";
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
const source = "import { Component, _decorator } from 'cc';\nconst { ccclass } = _decorator;\n@ccclass('ProjectController')\nexport class ActualController extends Component { amount: number = 10; }\n@ccclass('Enemy')\nexport class DifferentName extends Component {}\n";
try {
  // Deliberately tiny engine double: these tests exercise the checker, not a game build.
  write(join(root, "Creator.app/Contents/Resources/resources/3d/engine/bin/.declarations/cc.d.ts"), "declare module 'cc' { export class Component {} export const _decorator: { ccclass(name: string): ClassDecorator }; }");
  write(join(project, sourcePath), source);
  write(join(project, implementationBlueprintPath), JSON.stringify(sceneBlueprintExample));
  write(join(project, baselinePath), "Initial amount must be 10. Core loop input changes amount. Save progress locally.");
  const components = discoverScriptComponents(project);
  assert.equal(components.length, 2, "every class in a module is discoverable");
  assert.equal(components.find((component) => component.className === "ProjectController").exportName, "ActualController");
  const passing = runImplementationChecks(project, executable);
  assert.equal(passing.status, "pass", JSON.stringify(passing.findings));
  write(join(project, sourcePath), source.replace("= 10", "= 'wrong'"));
  const broken = runImplementationChecks(project, executable);
  assert.equal(broken.status, "fail");
  assert.ok(broken.findings.some((finding) => finding.code === "TS2322" && finding.line === 4), "semantic error that transpileModule misses is detected with a line number");
  assert.notEqual(broken.fingerprint, passing.fingerprint);
  write(join(project, sourcePath), source);
  write(join(project, "assets/scripts/btp/Generated.ts"), "export const generated = true;");
  assert.equal(runImplementationChecks(project, executable).fingerprint, passing.fingerprint, "build output must not invalidate author input gate");
  assert.equal(runImplementationChecks(project, "").status, "blocked", "missing engine types never passes");
  write(join(project, "assets/scripts/gameplay/duplicate.ts"), "import { Component, _decorator } from 'cc'; const { ccclass } = _decorator; @ccclass('Enemy') export class Duplicate extends Component {}");
  assert.throws(() => discoverScriptComponents(project), /Duplicate/);
  rmSync(join(project, "assets/scripts/gameplay/duplicate.ts"));
  const baseline = { path: baselinePath, quote: "Initial amount must be 10." };
  const implementation = { path: sourcePath, quote: "amount: number = 10" };
  const document = { schemaVersion: 1, kind: "implementation_review", verdict: "pass",
    coverage: reviewFacets.map((facet) => ({ facet, verdict: "pass", reason: "Fixture evidence", baseline, implementation })), issues: [] };
  const review = validateImplementationReview(project, document, passing);
  const rangeDocument = structuredClone(document);
  for (const coverage of rangeDocument.coverage) coverage.implementation = { path: sourcePath, lineStart: 4, lineEnd: 4 };
  const extractedReview = validateImplementationReview(project, rangeDocument, passing);
  assert.equal(extractedReview.coverage[0].implementation.quote, source.split("\n")[3], "citation ranges use server-extracted source, not retyped model text");
  rangeDocument.coverage[0].implementation = { path: sourcePath, lineStart: 4, lineEnd: 500 };
  assert.throws(() => validateImplementationReview(project, rangeDocument, passing), /line range/);
  assert.equal(review.checks.scope, "static_integration_only");
  assert.throws(() => validateImplementationReview(project, document, broken), /verdict conflicts/);
  assert.throws(() => validateImplementationReview(project, { ...document, coverage: document.coverage.slice(1) }, passing), /each facet/);
  assert.throws(() => validateImplementationReview(project, { ...document, issues: [{ title: "Fake", expected: "10", actual: "9", baseline, implementation: { ...implementation, quote: "amount = 9" } }] }, passing), /does not match/);
  const requests = (agentId, outputs, calls) => {
    const authorization = { mode: "task", taskId: "fixture", inputArtifactIds: [], outputArtifactIds: outputs.map((o) => o.artifactId), artifacts: outputs.map((o) => ({ ...o, sourceTaskId: "fixture", ownerAgentId: agentId })), readRoots: ["assets/scripts", "agents/design", "agents/engineering"], serviceReadPaths: [], serviceWritePaths: [] };
    const result = spawnSync(process.execPath, [resolve("apps/api/dist/harnessMcpServer.js")], { encoding: "utf8",
      env: { ...process.env, BTP_PROJECT_ROOT: project, BTP_AGENT_ID: agentId, BTP_TOOL_MODE: "task", BTP_COCOS_EXECUTABLE: executable,
        BTP_AUTHORIZATION: JSON.stringify(authorization), BTP_CONTROL_PATH: join(root, "control.json"), BTP_OPERATION_LOG_PATH: join(root, "operations.jsonl") },
      input: calls.map((call, i) => JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: call })).join("\n") + "\n" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").map((line) => JSON.parse(line).result);
  };
  let results = requests("gameplay_programmer", [{ artifactId: "self", type: "bug_report", path: selfCheckPath }], [
    { name: "write_artifact", arguments: { path: selfCheckPath, document: passing } },
    { name: "report_task_status", arguments: { status: "ready_for_review", reason: "claims ready without checking" } },
    { name: "run_implementation_checks", arguments: {} },
    { name: "report_task_status", arguments: { status: "ready_for_review", reason: "checked current bytes" } }
  ]);
  assert.equal(results[0].isError, true, "author cannot forge a self-check");
  assert.equal(results[1].isError, true, "self-declared completion cannot skip checks");
  assert.equal(results[2].structuredContent.status, "pass");
  assert.equal(results[3].isError, undefined);
  assert.equal(JSON.parse(readFileSync(join(project, selfCheckPath))).fingerprint, passing.fingerprint);
  results = requests("qa_evaluator", [{ artifactId: "review", type: "bug_report", path: implementationReviewPath }], [
    { name: "write_artifact", arguments: { path: sourcePath, content: "QA must not repair code" } },
    { name: "write_artifact", arguments: { path: implementationReviewPath, document } },
    { name: "run_implementation_checks", arguments: {} },
    { name: "write_artifact", arguments: { path: implementationReviewPath, document } }
  ]);
  assert.equal(results[0].isError, true, "QA remains read-only on implementation");
  assert.equal(results[1].isError, true, "QA cannot skip its own tool run");
  assert.equal(results[3].isError, undefined, JSON.stringify(results[3]));
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const edits = requests("gameplay_programmer", [{ artifactId: "code", type: "source_code", path: sourcePath }], [
    { name: "read_file", arguments: { path: sourcePath, lineStart: 1, lineEnd: 2 } },
    { name: "edit_code", arguments: { path: sourcePath, expectedHash: "0".repeat(64), oldText: "amount: number = 10", newText: "amount: number = 12" } },
    { name: "edit_code", arguments: { path: sourcePath, expectedHash: sourceHash, oldText: "export class", newText: "export abstract class" } },
    { name: "edit_code", arguments: { path: sourcePath, expectedHash: sourceHash, oldText: "amount: number = 10", newText: "amount: number = 12" } }
  ]);
  assert.equal(edits[0].structuredContent.hash, sourceHash, "partial read returns the full-file hash for compare-and-swap edits");
  assert.equal(edits[1].isError, true, "stale code edit rejected");
  assert.equal(edits[2].isError, true, "ambiguous code replacement rejected");
  assert.equal(edits[3].isError, undefined);
  assert.equal(readFileSync(join(project, sourcePath), "utf8"), source.replace("= 10", "= 12"), "precise edit preserves the rest of the module");
  const resubmittedBytes = readFileSync(join(project, sourcePath));
  const resubmittedHash = createHash("sha256").update(resubmittedBytes).digest("hex");
  const submissions = requests("gameplay_programmer", [{ artifactId: "code", type: "source_code", path: sourcePath }], [
    { name: "resubmit_source", arguments: { path: sourcePath, expectedHash: sourceHash, reason: "Platform-only change; source independently checked." } },
    { name: "resubmit_source", arguments: { path: "assets/scripts/btp/BtpRuntimeBootstrap.ts", expectedHash: resubmittedHash, reason: "Must not access generated bridge source." } },
    { name: "resubmit_source", arguments: { path: selfCheckPath, expectedHash: resubmittedHash, reason: "Must not forge server reports." } },
    { name: "resubmit_source", arguments: { path: sourcePath, expectedHash: resubmittedHash, reason: "Platform-only change; source independently checked." } }
  ]);
  assert.equal(submissions[0].isError, true, "stale hash cannot resubmit source");
  assert.equal(submissions[1].isError, true);
  assert.equal(submissions[2].isError, true);
  assert.equal(submissions[3].isError, undefined, JSON.stringify(submissions[3]));
  assert.deepEqual(readFileSync(join(project, sourcePath)), resubmittedBytes);
  assert.equal(parseToolOperations(join(root, "operations.jsonl")).at(-1).resubmissionReason, "Platform-only change; source independently checked.");
  write(join(project, sourcePath), source);
  process.env.STUDIO_WORKSPACE_ROOT = root;
  const longSource = source + "// fixture padding\n".repeat(400);
  write(join(project, sourcePath), longSource);
  const paginated = requests("gameplay_programmer", [{artifactId: "code", type: "source_code", path: sourcePath}], [
    {name: "read_file", arguments: {path: sourcePath}},
    {name: "read_file", arguments: {path: sourcePath, lineStart: 201, withLineNumbers: true}},
    {name: "edit_artifact", arguments: {path: sourcePath, expectedHash: createHash("sha256").update(longSource).digest("hex"),
      edits: [{oldText: "amount: number = 10", newText: "amount: number = 11"}, {oldText: "never-present-fixture", newText: "bad"}]}}
  ]);
  assert.equal(paginated[0].structuredContent.truncated, true);
  assert.equal(paginated[0].structuredContent.nextLineStart, 201);
  assert.equal(paginated[1].structuredContent.lineStart, 201);
  assert.equal(paginated[2].isError, true);
  assert.equal(readFileSync(join(project, sourcePath), "utf8"), longSource, "failed multi-edit saves no partial edit");
  const patched = requests("gameplay_programmer", [{artifactId: "code", type: "source_code", path: sourcePath}], [
    {name: "edit_artifact", arguments: {path: sourcePath, expectedHash: createHash("sha256").update(longSource).digest("hex"),
      edits: [{oldText: "amount: number = 10", newText: "amount: number = 11"}]}}
  ]);
  assert.equal(patched[0].isError, undefined);
  assert.equal(readFileSync(join(project, sourcePath), "utf8"), longSource.replace("= 10", "= 11"));
  const longLine = "//" + "a".repeat(13000);
  write(join(project, sourcePath), longLine);
  const chunks = requests("gameplay_programmer", [{artifactId: "code", type: "source_code", path: sourcePath}], [
    {name: "read_file", arguments: {path: sourcePath}},
    {name: "read_file", arguments: {path: sourcePath, characterOffset: 0}},
    {name: "read_file", arguments: {path: sourcePath, characterOffset: 6000}}
  ]);
  assert.equal(chunks[0].isError, true);
  assert.equal(chunks[1].structuredContent.nextCharacterOffset, 6000);
  assert.equal(chunks[1].structuredContent.text + chunks[2].structuredContent.text, longLine.slice(0,12000));
  write(join(project, sourcePath), source);
  process.env.BTP_COCOS_EXECUTABLE = executable;
  const real = createStudioKernel("project", "Isolated test", "producer_fixture", "test");
  const now = new Date().toISOString();
  const programmerId = "task_stage_2_cocos_implementation", reviewerId = "task_stage_2_qa_implementation_review";
  for (const [taskId, ownerAgentId, outputArtifacts, inputArtifacts] of [
    [programmerId, "gameplay_programmer", ["artifact_gameplay_source", "artifact_implementation_self_check"], []],
    [reviewerId, "qa_evaluator", ["artifact_implementation_review"], ["artifact_gameplay_source"]]
  ]) real.addTask({ taskId, projectId: "project", stageId: real.project.currentStage, taskLevel: "task", ownerAgentId,
    title: "Fixture", description: "Fixture", status: "doing", priority: 1, sortOrder: 1, inputArtifacts, outputArtifacts,
    acceptanceCriteria: [], blockers: [], createdAt: now, updatedAt: now });
  for (const [artifactId, path, ownerAgentId, sourceTaskId, type] of [
    ["artifact_gameplay_source", sourcePath, "gameplay_programmer", programmerId, "source_code"],
    ["artifact_implementation_self_check", selfCheckPath, "gameplay_programmer", programmerId, "bug_report"],
    ["artifact_implementation_review", implementationReviewPath, "qa_evaluator", reviewerId, "bug_report"]
  ]) real.addArtifact({ artifactId, projectId: "project", type, path, ownerAgentId, sourceTaskId,
    stageId: real.project.currentStage, status: "submitted", version: 1, sourceDecisionIds: [], metadata: { toolExecutedAt: now }, createdAt: now, updatedAt: now });
  const bytes = readFileSync(join(project, sourcePath));
  real.recordArtifactMaterialization("artifact_gameplay_source", { path: sourcePath, hash: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, materializedAt: now });
  assert.equal(taskOutputsVerified(real, real.findTask(programmerId)), false, "source alone does not satisfy the new programmer task");
  const apiMessage = { messageId: "api_check_fixture", projectId: "project", roomId: real.getRoom("engineering-room").roomId,
    senderType: "agent", senderId: "gameplay_programmer", messageType: "progress_update", mentions: [], relatedTaskIds: [programmerId], relatedArtifactIds: [], metadata: {}, createdAt: now,
    content: "```json\n" + JSON.stringify({ toolRequests: [{ tool: "run_implementation_checks", taskId: programmerId }] }) + "\n```" };
  const apiResults = await executeAgentToolRequests(real, [apiMessage]);
  assert.equal(apiResults[0]?.status, "completed", JSON.stringify(apiResults));
  assert.equal(artifactReadyForConsumption(real, "artifact_implementation_self_check"), true, "API and MCP share the same immutable self-check gate");
  syncProjectWorkspace(real);
  assert.equal(artifactReadyForConsumption(real, "artifact_implementation_self_check"), true, "checkpoint must not replace service evidence with a placeholder");
  assert.equal(taskOutputsVerified(real, real.findTask(programmerId)), true);
  rmSync(join(project, implementationReviewPath));
  const beforeReview = captureWorkspaceSnapshot(project);
  results = requests("qa_evaluator", [{ artifactId: "review", type: "bug_report", path: implementationReviewPath }], [
    { name: "run_implementation_checks", arguments: {} },
    { name: "submit_implementation_review", arguments: document }
  ]);
  assert.equal(results[1].isError, undefined, JSON.stringify(results[1]));
  const materialized = recordHarnessWorkspaceChanges(real, real.findTask(reviewerId), defaultAgentContracts.find((agent) => agent.agentId === "qa_evaluator"), beforeReview, captureWorkspaceSnapshot(project), "qa-fixture", [implementationReviewPath], parseToolOperations(join(root, "operations.jsonl")));
  assert.deepEqual(materialized.violations, []);
  assert.equal(artifactReadyForConsumption(real, "artifact_implementation_review"), true);
  write(join(project, "assets/scripts/gameplay/Helper.ts"), "export const changedDependency = 1;");
  assert.equal(artifactReadyForConsumption(real, "artifact_implementation_self_check"), false, "changing even an auxiliary source invalidates author proof");
  assert.equal(artifactReadyForConsumption(real, "artifact_implementation_review"), false, "changing an auxiliary source also invalidates independent QA review");
  real.updateTask(programmerId, {status: "review"});
  real.updateTask(reviewerId, {status: "blocked", blockers: ["Agent Loop：Agent 请求评审，但任务输出尚未全部通过 Artifact Ledger 验证。"]});
  resumeSupersededImplementationTasks(real);
  assert.equal(real.findTask(programmerId).status, "doing", "authentic superseded self-check requeues author");
  assert.equal(real.findTask(reviewerId).status, "doing", "author changes automatically requeue the independent reviewer");
  assert.deepEqual(real.findTask(reviewerId).blockers, []);
  real.updateTask(reviewerId, {status: "blocked", blockers: ["等待制作人确认范围"]});
  resumeSupersededImplementationTasks(real);
  assert.equal(real.findTask(reviewerId).status, "blocked", "supersession must not erase a real product decision wait");
  real.updateTask(reviewerId, {status: "doing", blockers: []});
  rmSync(join(project, "assets/scripts/gameplay/Helper.ts"));
  const beforeNegativeReview = captureWorkspaceSnapshot(project);
  const negativeDocument = { ...document, verdict: "change_requested", issues: [{title: "Fixture mismatch", expected: "Expected behavior", actual: "Incorrect behavior", baseline, implementation}] };
  results = requests("qa_evaluator", [{ artifactId: "review", type: "bug_report", path: implementationReviewPath }], [
    {name: "run_implementation_checks", arguments: {}}, {name: "submit_implementation_review", arguments: negativeDocument}
  ]);
  assert.equal(results[1].isError, undefined, JSON.stringify(results[1]));
  recordHarnessWorkspaceChanges(real, real.findTask(reviewerId), defaultAgentContracts.find((agent) => agent.agentId === "qa_evaluator"), beforeNegativeReview, captureWorkspaceSnapshot(project), "qa-negative-fixture", [implementationReviewPath], parseToolOperations(join(root, "operations.jsonl")));
  assert.equal(taskOutputsVerified(real, real.findTask(reviewerId)), true, "negative review must remain complete after its own author feedback");
  assert.equal(artifactReadyForConsumption(real, "artifact_implementation_review"), false, "review completion is not build approval");
  real.updateTask(reviewerId, {status: "review", blockers: []});
  const negativeBaseline = captureCurrentStageReviewOutputEvidence(real);
  syncProjectWorkspace(real);
  assert.equal(reconcileCurrentStageReviewOutputEvidence(real, negativeBaseline).changed, false,
    "checkpoint must not destroy a legitimate QA rejection merely because the build cannot consume it");
  const historical = createStudioKernelFromSnapshot(structuredClone(real.toSnapshot()));
  const historicalReport = historical.listArtifacts().find(a => a.artifactId === "artifact_implementation_review");
  historical.upsertArtifact({ ...historicalReport, status: "change_requested" });
  assert.equal(taskOutputsVerified(historical, historical.findTask(reviewerId)), false,
    "explicitly reopened review cannot auto-complete by reusing unchanged old receipt bytes");
  historical.upsertArtifact({...historicalReport, version: historicalReport.version + 1, status: "change_requested",
    metadata: {...historicalReport.metadata, toolExecutedAt: undefined, filesystemEvidenceInvalidationReason: "review_output_not_current_after_workspace_sync"}});
  historical.updateTask(reviewerId, {status: "blocked", blockers: ["Agent Loop：Agent 请求评审，但任务输出尚未全部通过 Artifact Ledger 验证。"]});
  // The original author has not resubmitted yet; do not run review early.
  resumeSupersededImplementationTasks(historical);
  assert.equal(historical.findTask(reviewerId).status, "blocked");
  const historicalSource = historical.listArtifacts().find(a => a.artifactId === "artifact_gameplay_source");
  historical.upsertArtifact({...historicalSource, status: "submitted"});
  resumeSupersededImplementationTasks(historical);
  assert.equal(historical.findTask(reviewerId).status, "doing", "previously invalidated authentic QA evidence requeues review without fabricating a ledger");
  assert.equal(artifactReadyForConsumption(historical, "artifact_implementation_review"), false);
  assert.equal(historical.listArtifactLedger().find(l => l.artifactId === "artifact_implementation_review").status, "pending");
  const staging = createIsolatedWorkspace(project, "implementation-regression");
  try {
    const before = captureWorkspaceSnapshot(staging.root);
    write(join(staging.root, sourcePath), source.replace("= 10", "= 12"));
    const intermediateCheck = runImplementationChecks(staging.root, executable);
    write(join(staging.root, selfCheckPath), JSON.stringify(intermediateCheck, null, 2) + "\n");
    // Author repairs another line but forgets to rerun. Keep that code; only the
    // old proof must fail, not the entire isolated transaction.
    write(join(staging.root, sourcePath), source.replace("= 10", "= 13"));
    const after = captureWorkspaceSnapshot(staging.root);
    const operations = [sourcePath, selfCheckPath].map((path) => ({ toolName: path === selfCheckPath ? "run_implementation_checks" : "write_artifact", path,
      access: "write", status: "completed", hash: after.get(path).hash, sizeBytes: after.get(path).sizeBytes }));
    const programmer = defaultAgentContracts.find((agent) => agent.agentId === "gameplay_programmer");
    const preview = recordHarnessWorkspaceChanges(createStudioKernelFromSnapshot(real.toSnapshot()), real.findTask(programmerId), programmer,
      before, after, "preview", [sourcePath, selfCheckPath], operations, { authoritativeWorkspace: true, validationWorkspaceRoot: staging.root });
    assert.deepEqual(preview.violations, []);
    const transaction = stageWorkspaceCommit(project, staging.root, [sourcePath, selfCheckPath]);
    recordHarnessWorkspaceChanges(real, real.findTask(programmerId), programmer, before, after, "commit", [sourcePath, selfCheckPath], operations, { authoritativeWorkspace: true });
    transaction.finalize();
    assert.match(readFileSync(join(project, sourcePath), "utf8"), /amount: number = 13/);
    assert.equal(taskOutputsVerified(real, real.findTask(programmerId)), false, "retaining repaired source must not bless stale self-checks");
  } finally { staging.dispose(); }
  // Bounded kernel double proves routing and idempotence without importing the live store.
  const task = { taskId: "task_stage_2_cocos_implementation", ownerAgentId: "gameplay_programmer", description: "Original task", outputArtifacts: ["source"], blockers: ["old error"] };
  const output = { artifactId: "source", path: sourcePath, status: "submitted" };
  const messages = [];
  const kernel = { project: { projectId: "fixture" }, findTask: (id) => id === task.taskId ? task : undefined,
    updateTask: (_, patch) => Object.assign(task, patch), listArtifacts: () => [output], upsertArtifact: (next) => Object.assign(output, next),
    updateAgentLoopAgent: () => {}, getRoom: () => ({ roomId: "engineering" }), recordMessage: (message) => messages.push(message) };
  const failed = { ...review, verdict: "change_requested", issues: [{ title: "Rule mismatch", expected: "10", actual: "wrong behavior", baseline, implementation }] };
  applyImplementationReviewFeedback(kernel, { artifactId: "review", version: 1 }, failed);
  applyImplementationReviewFeedback(kernel, { artifactId: "review", version: 1 }, failed);
  assert.equal(messages.length, 1);
  assert.equal(task.status, "doing");
  assert.equal(task.blockers.length, 0, "actionable repair feedback must not make the author unschedulable");
  assert.equal(output.status, "change_requested");
  console.log("Independent implementation verification passed: semantic checking, component identities, byte invalidation, unforgeable MCP self-check, grounded review, QA isolation, automatic idempotent repair routing.");
} finally { rmSync(root, { recursive: true, force: true }); }
