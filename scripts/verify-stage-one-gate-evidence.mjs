import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "btp-stage-one-gate-evidence-"));
process.env.STUDIO_WORKSPACE_ROOT = join(tempRoot, "studio");
process.env.GAME_PIPELINE_DATA_ROOT = join(tempRoot, "data");

const { createStudioKernel } = await import("@game-pipeline/agent-runtime");
const { apiGateEvidencePolicy } = await import("../apps/api/dist/gateEvidencePolicy.js");
const { artifactReadyForConsumption } = await import("../apps/api/dist/taskOutputEvidence.js");

const canonicalGdd = {
  artifactId: "artifact_gdd_baseline_draft",
  type: "gdd",
  path: "agents/design/gdd/00_overview.md",
  ownerAgentId: "game_designer",
  sourceTaskId: "task_stage_1_design_clarification"
};
const canonicalGameContract = {
  artifactId: "artifact_game_contract_draft",
  type: "game_contract",
  path: "agents/design/contracts/game-contract.json",
  ownerAgentId: "game_designer",
  sourceTaskId: "task_stage_1_design_clarification"
};

try {
  const valid = createVerifiedFixture("valid", canonicalGdd, "# Canonical GDD\n\nVerified content.\n");
  assert.equal(artifactReadyForConsumption(valid.kernel, canonicalGdd.artifactId), true);
  assert.doesNotThrow(() => assertStageOneGate(valid.kernel, canonicalGdd.artifactId));

  const wrongType = createVerifiedFixture(
    "wrong_type",
    { ...canonicalGameContract, type: "gdd" },
    "{}\n"
  );
  assertCanonicalIdentityRejected(
    wrongType.kernel,
    canonicalGameContract.artifactId,
    "canonical GameContract ID mislabeled as gdd must not bypass the contract parser"
  );

  const wrongPath = createVerifiedFixture(
    "wrong_path",
    { ...canonicalGdd, path: "agents/design/gdd/non-canonical-overview.md" },
    "# Wrong path with otherwise verified evidence\n"
  );
  assertCanonicalIdentityRejected(
    wrongPath.kernel,
    canonicalGdd.artifactId,
    "a verified file at a non-canonical path must not satisfy the Stage 1 ID"
  );

  const wrongOwner = createVerifiedFixture("wrong_owner", canonicalGdd, "# Wrong owner fixture\n");
  wrongOwner.artifact.ownerAgentId = "art_director";
  assertCanonicalIdentityRejected(
    wrongOwner.kernel,
    canonicalGdd.artifactId,
    "a verified canonical ID owned by another role must not be consumable"
  );

  const wrongSource = createVerifiedFixture(
    "wrong_source",
    canonicalGdd,
    "# Wrong source task fixture\n",
    { addAlternateSourceTask: true }
  );
  wrongSource.artifact.sourceTaskId = "task_alternate_design";
  assertCanonicalIdentityRejected(
    wrongSource.kernel,
    canonicalGdd.artifactId,
    "a verified canonical ID bound to another task must not be consumable"
  );

  process.stdout.write("Stage 1 gate evidence passed: canonical type/path/owner/sourceTask enforced before consumption\n");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function createVerifiedFixture(name, identity, content, options = {}) {
  const projectId = `stage_one_gate_${name}`;
  const kernel = createStudioKernel(projectId, `Stage One Gate ${name}`, "producer_test", "gate identity regression");
  const now = new Date().toISOString();
  addTask(kernel, identity.sourceTaskId, identity.ownerAgentId, [identity.artifactId], now);
  if (options.addAlternateSourceTask) {
    addTask(kernel, "task_alternate_design", identity.ownerAgentId, [], now);
  }
  kernel.addArtifact({
    ...identity,
    projectId,
    stageId: "concept_discussion",
    status: "submitted",
    version: 1,
    sourceDecisionIds: [],
    metadata: {
      generatedBy: "stage_one_gate_evidence_fixture",
      toolExecutedAt: now,
      toolName: "write_artifact"
    },
    createdAt: now,
    updatedAt: now
  });

  const absolutePath = join(process.env.STUDIO_WORKSPACE_ROOT, projectId, identity.path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
  const stats = statSync(absolutePath);
  kernel.recordArtifactMaterialization(identity.artifactId, {
    path: identity.path,
    hash: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
    sizeBytes: stats.size,
    materializedAt: stats.mtime.toISOString()
  });
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === identity.artifactId);
  assert.ok(artifact);
  assert.equal(
    kernel.listArtifactLedger().find((entry) => entry.artifactId === identity.artifactId)?.status,
    "verified",
    "the adversarial fixture must have a verified ledger before identity rejection"
  );
  return { kernel, artifact };
}

function addTask(kernel, taskId, ownerAgentId, outputArtifacts, now) {
  kernel.addTask({
    taskId,
    projectId: kernel.project.projectId,
    stageId: "concept_discussion",
    roomId: kernel.getRoom(ownerAgentId === "art_director" ? "art-room" : "design-room").roomId,
    taskLevel: "task",
    title: taskId,
    description: "Stage 1 canonical identity regression fixture",
    ownerAgentId,
    participantAgentIds: [],
    status: "doing",
    priority: 1,
    sortOrder: 1,
    progressPercent: 0,
    blockers: [],
    inputArtifacts: [],
    outputArtifacts,
    acceptanceCriteria: ["canonical artifact identity must match"],
    createdAt: now,
    updatedAt: now
  });
}

function assertCanonicalIdentityRejected(kernel, artifactId, message) {
  assert.equal(artifactReadyForConsumption(kernel, artifactId), false, message);
  assert.throws(
    () => assertStageOneGate(kernel, artifactId),
    (error) => /Stage 1 canonical 产物身份不匹配/.test(error?.message ?? "") &&
      (error?.message ?? "").includes(artifactId),
    message
  );
}

function assertStageOneGate(kernel, artifactId) {
  apiGateEvidencePolicy.assertGateEvidence(kernel, {
    gateActionId: "stage1",
    phase: "review",
    requiredArtifactIds: [artifactId]
  });
}
