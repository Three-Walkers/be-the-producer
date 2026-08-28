import type { StudioKernel } from "@game-pipeline/agent-runtime";
import type { Artifact } from "@game-pipeline/shared-schemas";

const mediaEvidenceVersion = 1;

export interface MediaGenerationMaterializationInput {
  hash: string;
  sizeBytes: number;
  provider: string;
  model: string;
  requestId: string;
  promptHash: string;
}

/**
 * Metadata written to the immutable StudioKernel artifact operation.  Unlike
 * Artifact.metadata, an Agent tool request cannot supply or overwrite this
 * record, so it is the authority for whether the current materialization was
 * produced by generate_raster_asset.
 */
export function mediaGenerationOperationMetadata(
  input: MediaGenerationMaterializationInput
): Record<string, unknown> {
  return {
    mediaEvidenceVersion,
    materializationToolName: "generate_raster_asset",
    materializationHash: input.hash,
    materializationSizeBytes: input.sizeBytes,
    mediaProvider: input.provider,
    mediaModel: input.model,
    mediaRequestId: input.requestId,
    mediaPromptHash: input.promptHash
  };
}

/** Bind the mutable Artifact view back to the exact current ledger operation. */
export function bindMediaGenerationArtifactMetadata(
  metadata: Record<string, unknown>,
  operationId: string,
  input: Pick<MediaGenerationMaterializationInput, "hash" | "sizeBytes">
): Record<string, unknown> {
  return {
    ...metadata,
    mediaEvidenceVersion,
    mediaMaterializationOperationId: operationId,
    mediaMaterializationHash: input.hash,
    mediaMaterializationSizeBytes: input.sizeBytes
  };
}

/**
 * A fresh non-generation write must not inherit a previous provider, vision,
 * or bridge receipt.  The new operation can add its own server receipts after
 * this sanitization step.
 */
export function stripPrivilegedMaterializationMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (
      key.startsWith("media") ||
      key.startsWith("vision") ||
      key.startsWith("bridgeOperation") ||
      key === "bridgeOk" ||
      key === "bridgeReportPath" ||
      key === "bridgeResult" ||
      key === "nativeHarnessManaged" ||
      key === "harnessInvocationId" ||
      key === "harnessToolName" ||
      key === "harnessToolError"
    ) {
      continue;
    }
    if (key === "generatedBy" && value === "dashscope_multimodal_art_provider") {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

/** Copy only a vision receipt that the caller has already server-validated. */
export function pickVisionReceiptMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) =>
      key.startsWith("visionInspection") || key.startsWith("visionInspected") || key.startsWith("visionAuthoritative") ||
      key === "visionRequestSemanticHash"
    )
  );
}

export function artifactClaimsMediaGeneration(artifact: Artifact): boolean {
  return (
    artifact.metadata.generatedBy === "dashscope_multimodal_art_provider" ||
    Object.keys(artifact.metadata).some((key) => key.startsWith("media"))
  );
}

/**
 * Proves that provider metadata belongs to the current Artifact version and
 * current ledger bytes, rather than being inherited from an older write.
 */
export function hasCurrentGenerateRasterAssetReceipt(
  kernel: StudioKernel,
  artifact: Artifact
): boolean {
  const metadata = artifact.metadata;
  const ledger = kernel.listArtifactLedger().find((entry) => entry.artifactId === artifact.artifactId);
  if (
    ledger?.status !== "verified" ||
    !ledger.hash ||
    ledger.sizeBytes === undefined ||
    metadata.mediaEvidenceVersion !== mediaEvidenceVersion ||
    metadata.mediaMaterializationOperationId !== ledger.sourceOperationId ||
    metadata.mediaMaterializationHash !== ledger.hash ||
    metadata.mediaMaterializationSizeBytes !== ledger.sizeBytes
  ) {
    return false;
  }

  const directReceipt = metadata.toolName === "generate_raster_asset";
  const harnessReceipt =
    metadata.harnessToolName === "generate_raster_asset" &&
    (metadata.toolName === undefined || metadata.toolName === "generate_raster_asset") &&
    metadata.bridgeOperationType === "image_generation" &&
    nonEmptyString(metadata.bridgeOperationId);
  if (!directReceipt && !harnessReceipt) return false;

  if (
    metadata.generatedBy !== "dashscope_multimodal_art_provider" ||
    !nonEmptyString(metadata.mediaProvider) ||
    !nonEmptyString(metadata.mediaModel) ||
    !nonEmptyString(metadata.mediaRequestId) ||
    !sha256(metadata.mediaPromptHash) ||
    metadata.mediaMime !== "image/png" ||
    !positiveInteger(metadata.mediaWidth) ||
    !positiveInteger(metadata.mediaHeight)
  ) {
    return false;
  }

  const operation = kernel.listArtifactOperations().find((entry) => entry.operationId === ledger.sourceOperationId);
  return Boolean(
    operation &&
    operation.status === "completed" &&
    operation.artifactId === artifact.artifactId &&
    operation.agentId === artifact.ownerAgentId &&
    operation.taskId === artifact.sourceTaskId &&
    operation.path === ledger.path &&
    operation.metadata.mediaEvidenceVersion === mediaEvidenceVersion &&
    operation.metadata.materializationToolName === "generate_raster_asset" &&
    operation.metadata.materializationHash === ledger.hash &&
    operation.metadata.materializationSizeBytes === ledger.sizeBytes &&
    operation.metadata.mediaProvider === metadata.mediaProvider &&
    operation.metadata.mediaModel === metadata.mediaModel &&
    operation.metadata.mediaRequestId === metadata.mediaRequestId &&
    operation.metadata.mediaPromptHash === metadata.mediaPromptHash
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
