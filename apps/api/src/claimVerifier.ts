import { createHash } from "node:crypto";
import { dirname, normalize, sep } from "node:path";
import type { ArtifactLedgerEntry, ClaimType, ClaimVerification, StudioMessage } from "@game-pipeline/shared-schemas";
import type { StudioKernel } from "@game-pipeline/agent-runtime";
import { artifactFilePath, resolveWorkspacePathTarget } from "./workspaceWriter.js";

const completionClaimPattern =
  /(已完成|已经完成|完成了|已生成|已经生成|已更新|已经更新|已提交|已经提交|已创建|已经创建|已写入|已经写入|写入了|已固化|已经固化)/;
const artifactCompletionPattern =
  /(产物|文件|文档|报告|代码|脚本|资产|构建|清单|manifest|artifact)/i;
const claimVerificationExcludedGenerators = new Set(["claim_repair_guardian"]);

const workspacePathPattern =
  /(?:\.\/)?(?:agents|shared|docs|assets|artifacts|outputs|builds|release|releases|intermediate|cocos|settings|workspace)\/[A-Za-z0-9._~@%+\-/]+|(?:\.\/)?[A-Za-z0-9._~@%+-]+\/[A-Za-z0-9._~@%+\-/]*[A-Za-z0-9._~@%+-]\.[A-Za-z0-9]{2,10}/g;

export function verifyProjectClaims(kernel: StudioKernel): ClaimVerification[] {
  const verifiedClaims: ClaimVerification[] = [];
  for (const message of kernel.listMessages()) {
    if (message.senderType !== "agent" || shouldSkipClaimVerification(message)) {
      kernel.setMessageClaimVerifications(message.messageId, []);
      continue;
    }

    const claims = verifyMessageClaims(kernel, message);
    for (const claim of claims) {
      kernel.recordClaimVerification(claim);
      verifiedClaims.push(claim);
    }
    kernel.setMessageClaimVerifications(message.messageId, claims);
  }

  return verifiedClaims;
}

function verifyMessageClaims(kernel: StudioKernel, message: StudioMessage): ClaimVerification[] {
  const paths = extractWorkspacePaths(message.content);
  const hasCompletionClaim = completionClaimPattern.test(message.content);
  const claims: ClaimVerification[] = [];
  const relatedArtifactIds = message.relatedArtifactIds ?? [];

  if (paths.length > 0) {
    for (const path of paths) {
      claims.push(verifyPathClaim(kernel, message, path.path, path.completionClaim ? "artifact_written" : "path_reference"));
    }
  }

  if (
    hasCompletionClaim &&
    paths.length === 0 &&
    (relatedArtifactIds.length > 0 || artifactCompletionPattern.test(message.content))
  ) {
    claims.push(verifyCompletionClaim(kernel, message, relatedArtifactIds));
  }

  return claims;
}

function verifyPathClaim(
  kernel: StudioKernel,
  message: StudioMessage,
  claimedPath: string,
  claimType: ClaimType
): ClaimVerification {
  const checkedAt = new Date().toISOString();
  const normalizedPath = normalizeWorkspacePath(claimedPath);
  const ledger = findLedgerForPath(kernel, normalizedPath);
  const artifactIds = ledger ? [ledger.artifactId] : matchingArtifactIds(kernel, normalizedPath);

  try {
    const target = resolveWorkspacePathTarget(kernel.project.projectId, normalizedPath);
    if (!target.exists) {
      const nearest = nearestMaterializedArtifact(kernel, normalizedPath, message.senderId);
      const nearestText = nearest ? `最近实际产物是 ${nearest.path}。` : "没有找到同目录的已登记产物。";
      return buildClaim(kernel, message, {
        claimType,
        claimedPath: normalizedPath,
        relatedArtifactIds: artifactIds,
        verdict: "mismatch",
        reason: `${normalizedPath} 不存在。${nearestText}`,
        evidenceRefs: nearest ? [nearest.sourceOperationId] : [],
        resolver: "filesystem",
        checkedAt,
        metadata: nearest ? { nearestArtifactPath: nearest.path } : {}
      });
    }

    if (claimType === "path_reference") {
      return buildClaim(kernel, message, {
        claimType,
        claimedPath: normalizedPath,
        relatedArtifactIds: artifactIds,
        verdict: "verified",
        reason: `${normalizedPath} 路径引用存在。`,
        evidenceRefs: ledger ? [ledger.sourceOperationId] : [],
        resolver: "filesystem",
        checkedAt,
        metadata: {
          pathType: target.type,
          sizeBytes: target.sizeBytes,
          referenceOnly: true
        }
      });
    }

    if (!ledger) {
      return buildClaim(kernel, message, {
        claimType,
        claimedPath: normalizedPath,
        relatedArtifactIds: artifactIds,
        verdict: "insufficient",
        reason: `${normalizedPath} 存在，但没有 artifact ledger 记录，不能证明它由 Agent 工具写入。`,
        evidenceRefs: [],
        resolver: "filesystem",
        checkedAt,
        metadata: {
          pathType: target.type,
          sizeBytes: target.sizeBytes
        }
      });
    }

    if (ledger.ownerAgentId !== message.senderId && !canReportDelegatedEvidence(message)) {
      return buildClaim(kernel, message, {
        claimType,
        claimedPath: normalizedPath,
        relatedArtifactIds: [ledger.artifactId],
        verdict: "mismatch",
        reason: `${normalizedPath} 的登记 owner 是 ${ledger.ownerAgentId}，不是当前发言 Agent ${message.senderId}。`,
        evidenceRefs: [ledger.sourceOperationId],
        resolver: "artifact_ledger",
        checkedAt,
        metadata: {
          ledgerStatus: ledger.status
        }
      });
    }

    if (ledger.status !== "verified" || !ledger.hash || !ledger.sizeBytes) {
      return buildClaim(kernel, message, {
        claimType,
        claimedPath: normalizedPath,
        relatedArtifactIds: [ledger.artifactId],
        verdict: "insufficient",
        reason: `${normalizedPath} 已登记，但文件 hash/size 证据尚未完成。`,
        evidenceRefs: [ledger.sourceOperationId],
        resolver: "artifact_ledger",
        checkedAt,
        metadata: {
          ledgerStatus: ledger.status
        }
      });
    }

    const freshnessIssue = ledgerFreshnessIssue(kernel, ledger);
    if (freshnessIssue) {
      return buildClaim(kernel, message, {
        claimType,
        claimedPath: normalizedPath,
        relatedArtifactIds: [ledger.artifactId],
        verdict: "insufficient",
        reason: freshnessIssue,
        evidenceRefs: [ledger.sourceOperationId],
        resolver: "artifact_ledger",
        checkedAt,
        metadata: {
          hash: ledger.hash,
          sizeBytes: ledger.sizeBytes,
          materializedAt: ledger.materializedAt
        }
      });
    }

    return buildClaim(kernel, message, {
      claimType,
      claimedPath: normalizedPath,
      relatedArtifactIds: [ledger.artifactId],
      verdict: "verified",
      reason:
        ledger.ownerAgentId === message.senderId
          ? `${normalizedPath} 已由 ${message.senderId} 的 artifact 写入工具物化，hash/size 已登记。`
          : `${normalizedPath} 已由 ${ledger.ownerAgentId} 的工具物化；总控 Agent 的项目状态转述已核对 ledger。`,
      evidenceRefs: [ledger.sourceOperationId, ledger.artifactId],
      resolver: "artifact_ledger",
      checkedAt,
      metadata: {
        hash: ledger.hash,
        sizeBytes: ledger.sizeBytes,
        materializedAt: ledger.materializedAt
      }
    });
  } catch (error) {
    return buildClaim(kernel, message, {
      claimType,
      claimedPath: normalizedPath,
      relatedArtifactIds: artifactIds,
      verdict: "mismatch",
      reason: error instanceof Error ? error.message : "路径验证失败。",
      evidenceRefs: [],
      resolver: "filesystem",
      checkedAt,
      metadata: {}
    });
  }
}

function verifyCompletionClaim(kernel: StudioKernel, message: StudioMessage, relatedArtifactIds: string[]): ClaimVerification {
  const checkedAt = new Date().toISOString();
  if (relatedArtifactIds.length === 0) {
    const relatedTaskIds = message.relatedTaskIds ?? [];
    if (relatedTaskIds.length > 0) {
      const missingTasks = relatedTaskIds.filter((taskId) => !kernel.findTask(taskId));
      return buildClaim(kernel, message, {
        claimType: "completion",
        relatedArtifactIds: [],
        verdict: missingTasks.length === 0 ? "verified" : "mismatch",
        reason:
          missingTasks.length === 0
            ? `完成声明已绑定 ${relatedTaskIds.length} 个任务记录。`
            : `完成声明绑定的任务不存在：${missingTasks.join("、")}。`,
        evidenceRefs: relatedTaskIds,
        resolver: "message_metadata",
        checkedAt,
        metadata: {
          relatedTaskIds
        }
      });
    }

    return buildClaim(kernel, message, {
      claimType: "completion",
      relatedArtifactIds: [],
      verdict: "insufficient",
      reason: "Agent 使用了完成类表述，但消息没有绑定 relatedArtifactIds 或路径证据。",
      evidenceRefs: [],
      resolver: "message_metadata",
      checkedAt,
      metadata: {}
    });
  }

  const ledgers = relatedArtifactIds.map((artifactId) => kernel.listArtifactLedger().find((entry) => entry.artifactId === artifactId));
  const missing = relatedArtifactIds.filter((_, index) => !ledgers[index]);
  if (missing.length > 0) {
    return buildClaim(kernel, message, {
      claimType: "completion",
      relatedArtifactIds,
      verdict: "insufficient",
      reason: `消息绑定的产物缺少 ledger 记录：${missing.join("、")}。`,
      evidenceRefs: [],
      resolver: "artifact_ledger",
      checkedAt,
      metadata: {}
    });
  }

  const existingLedgers = ledgers.filter((entry): entry is ArtifactLedgerEntry => entry !== undefined);
  const wrongOwner = existingLedgers.filter(
    (entry) => entry.ownerAgentId !== message.senderId && !canReportDelegatedEvidence(message)
  );
  if (wrongOwner.length > 0) {
    return buildClaim(kernel, message, {
      claimType: "completion",
      relatedArtifactIds,
      verdict: "mismatch",
      reason: `消息绑定的产物 owner 与发言 Agent 不一致：${wrongOwner.map((entry) => `${entry.artifactId}:${entry.ownerAgentId}`).join("、")}。`,
      evidenceRefs: wrongOwner.map((entry) => entry.sourceOperationId),
      resolver: "artifact_ledger",
      checkedAt,
      metadata: {}
    });
  }

  const unverified = existingLedgers.filter((entry) => entry.status !== "verified" || !entry.hash || !entry.sizeBytes);
  if (unverified.length > 0) {
    return buildClaim(kernel, message, {
      claimType: "completion",
      relatedArtifactIds,
      verdict: "insufficient",
      reason: `消息绑定的产物尚未完成文件证据：${unverified.map((entry) => entry.artifactId).join("、")}。`,
      evidenceRefs: unverified.map((entry) => entry.sourceOperationId),
      resolver: "artifact_ledger",
      checkedAt,
      metadata: {}
    });
  }

  const verifiedLedgers = existingLedgers;
  const staleLedgers = verifiedLedgers
    .map((entry) => ({ entry, issue: ledgerFreshnessIssue(kernel, entry) }))
    .filter((item): item is { entry: ArtifactLedgerEntry; issue: string } => Boolean(item.issue));
  if (staleLedgers.length > 0) {
    return buildClaim(kernel, message, {
      claimType: "completion",
      relatedArtifactIds,
      verdict: "insufficient",
      reason: staleLedgers.map((item) => item.issue).join("；"),
      evidenceRefs: staleLedgers.map((item) => item.entry.sourceOperationId),
      resolver: "artifact_ledger",
      checkedAt,
      metadata: {}
    });
  }

  return buildClaim(kernel, message, {
    claimType: "completion",
    relatedArtifactIds,
    verdict: "verified",
    reason: `完成声明已绑定 ${verifiedLedgers.length} 个已验证产物。`,
    evidenceRefs: verifiedLedgers.flatMap((entry) => [entry.sourceOperationId, entry.artifactId]),
    resolver: "artifact_ledger",
    checkedAt,
    metadata: {
      paths: verifiedLedgers.map((entry) => entry.path)
    }
  });
}

function ledgerFreshnessIssue(kernel: StudioKernel, ledger: ArtifactLedgerEntry): string | undefined {
  const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === ledger.artifactId);
  const task = artifact?.sourceTaskId ? kernel.findTask(artifact.sourceTaskId) : undefined;
  if (!task || !ledger.materializedAt) {
    return undefined;
  }

  if (new Date(ledger.materializedAt).getTime() < new Date(task.createdAt).getTime()) {
    return `${ledger.path} 的文件证据早于任务创建时间，不能作为当前任务完成证据。`;
  }

  return undefined;
}

function buildClaim(
  kernel: StudioKernel,
  message: StudioMessage,
  input: Omit<ClaimVerification, "claimId" | "projectId" | "messageId" | "agentId">
): ClaimVerification {
  return {
    claimId: stableClaimId(message.messageId, input.claimType, input.claimedPath ?? input.relatedArtifactIds.join(",")),
    projectId: kernel.project.projectId,
    messageId: message.messageId,
    agentId: message.senderId,
    ...input
  };
}

function extractWorkspacePaths(content: string): Array<{ path: string; completionClaim: boolean }> {
  const paths = new Map<string, boolean>();
  const text = String(content ?? "");
  for (const match of text.matchAll(workspacePathPattern)) {
    const candidate = normalizeWorkspacePathCandidate(match[0]);
    if (candidate) {
      const completionClaim = isCompletionClaimForOccurrence(text, match.index ?? 0);
      paths.set(candidate, Boolean(paths.get(candidate)) || completionClaim);
    }
  }
  return [...paths].map(([path, completionClaim]) => ({ path, completionClaim }));
}

function isCompletionClaimForOccurrence(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const lineEndCandidate = content.indexOf("\n", index);
  const lineEnd = lineEndCandidate === -1 ? content.length : lineEndCandidate;
  const line = content.slice(lineStart, lineEnd);
  if (completionClaimPattern.test(line)) {
    return true;
  }

  const previousLineEnd = Math.max(0, lineStart - 1);
  const previousLineStart = content.lastIndexOf("\n", Math.max(0, previousLineEnd - 1)) + 1;
  const previousLine = content.slice(previousLineStart, previousLineEnd).trim();
  return completionClaimPattern.test(previousLine) && /(?:文件|产物|输出|清单|报告)[：:]?\s*$/.test(previousLine);
}

function shouldSkipClaimVerification(message: StudioMessage): boolean {
  const generatedBy = message.metadata?.generatedBy;
  if (typeof generatedBy === "string" && claimVerificationExcludedGenerators.has(generatedBy)) {
    return true;
  }
  return generatedBy === "local_agent_runtime" && message.senderId === "studio_orchestrator";
}

function canReportDelegatedEvidence(message: StudioMessage): boolean {
  return message.senderId === "studio_orchestrator";
}

function normalizeWorkspacePathCandidate(value: string): string | undefined {
  let candidate = String(value ?? "").trim();
  if (!candidate || candidate.includes("://") || candidate.startsWith("/") || candidate.includes("..")) {
    return undefined;
  }

  candidate = candidate.replace(/^\.\/+/, "");
  const trimmed = candidate.replace(/[，。；、,;:!?！？)\]}>）】》”’]+$/g, "");
  if (!trimmed || !trimmed.includes("/") || trimmed.includes("..")) {
    return undefined;
  }

  return normalizeWorkspacePath(trimmed);
}

function normalizeWorkspacePath(path: string): string {
  return normalize(path).split(sep).join("/");
}

function findLedgerForPath(kernel: StudioKernel, path: string): ArtifactLedgerEntry | undefined {
  return kernel.listArtifactLedger().find((entry) => {
    const ledgerPath = normalizeWorkspacePath(entry.path);
    const artifact = kernel.listArtifacts().find((candidate) => candidate.artifactId === entry.artifactId);
    const artifactPath = artifact ? normalizeWorkspacePath(artifact.path) : "";
    const materializedArtifactPath = artifact ? normalizeWorkspacePath(artifactFilePath(artifact)) : "";
    return (
      ledgerPath === path ||
      artifactPath === path ||
      materializedArtifactPath === path ||
      (artifactPath === path.replace(/\/$/, "") && ledgerPath.startsWith(`${artifactPath}/`))
    );
  });
}

function matchingArtifactIds(kernel: StudioKernel, path: string): string[] {
  return kernel
    .listArtifacts()
    .filter((artifact) => {
      const artifactPath = normalizeWorkspacePath(artifact.path);
      const materializedPath = normalizeWorkspacePath(artifactFilePath(artifact));
      return artifactPath === path || materializedPath === path;
    })
    .map((artifact) => artifact.artifactId);
}

function nearestMaterializedArtifact(kernel: StudioKernel, path: string, agentId: string): ArtifactLedgerEntry | undefined {
  const requestedDir = dirname(path);
  const verified = kernel
    .listArtifactLedger()
    .filter((entry) => entry.status === "verified")
    .sort((left, right) => {
      const leftSameOwner = left.ownerAgentId === agentId ? 0 : 1;
      const rightSameOwner = right.ownerAgentId === agentId ? 0 : 1;
      if (leftSameOwner !== rightSameOwner) {
        return leftSameOwner - rightSameOwner;
      }
      const leftSameDir = dirname(left.path) === requestedDir ? 0 : 1;
      const rightSameDir = dirname(right.path) === requestedDir ? 0 : 1;
      if (leftSameDir !== rightSameDir) {
        return leftSameDir - rightSameDir;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  return verified[0];
}

function stableClaimId(messageId: string, claimType: ClaimType, value: string): string {
  return `claim_${messageId}_${createHash("sha1").update(`${claimType}:${value}`).digest("hex").slice(0, 10)}`;
}
