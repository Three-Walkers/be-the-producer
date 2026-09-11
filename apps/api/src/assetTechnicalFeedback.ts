import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { workflowTaskStages, type StudioKernel } from "@game-pipeline/agent-runtime";
import { parseAssetManifest, type AgentId } from "@game-pipeline/shared-schemas";
import { assertPngAlphaPolicy, inspectPngAlpha } from "./imageAssetValidation.js";
import { readArtifactContentForModel, resolveWorkspacePathTarget } from "./workspaceWriter.js";

const marker = "ASSET_TECHNICAL_REPAIR";
const section = /\n\[ASSET_TECHNICAL_REPAIR\][\s\S]*?\[\/ASSET_TECHNICAL_REPAIR\]/g;

/** Machine failures belong to the author, not another visual-model retry.
 * Keep real receipts untouched and never convert these checks into approval. */
export function reconcileAssetTechnicalFailures(kernel: StudioKernel, now = new Date().toISOString()): AgentId[] {
  const activeStages = new Set(workflowTaskStages(kernel.project.currentStage));
  const queued = new Set<AgentId>();
  for (const manifest of kernel.listArtifacts().filter((artifact) => artifact.type === "asset_manifest")) {
    const task = manifest.sourceTaskId ? kernel.findTask(manifest.sourceTaskId) : undefined;
    if (!task || task.ownerAgentId !== "asset_production" || !activeStages.has(task.stageId) ||
        task.status === "cancelled" || !task.outputArtifacts.includes(manifest.artifactId) || !manifest.metadata.toolExecutedAt) continue;
    const content = readArtifactContentForModel(kernel.project.projectId, manifest, 2_000_000);
    if (!content) continue;
    const failures: Array<{ path: string; hash?: string; policy?: string; reason: string }> = [];
    try {
      const parsed = parseAssetManifest(JSON.parse(content));
      if (parsed.migrationRequired) throw new Error("Asset Manifest 必须使用 schemaVersion=2.0.0 并显式声明每个 runtimePath 的 alphaPolicy。");
      for (const asset of parsed.runtimeAssets) {
        let hash: string | undefined;
        try {
          if (!asset.runtimePath.toLowerCase().endsWith(".png")) throw new Error("运行资产必须为 PNG。");
          const target = resolveWorkspacePathTarget(kernel.project.projectId, asset.runtimePath);
          if (!target.exists || target.type !== "file") throw new Error("运行资产文件不存在。");
          const bytes = readFileSync(target.absolutePath);
          hash = createHash("sha256").update(bytes).digest("hex");
          assertPngAlphaPolicy(inspectPngAlpha(bytes, asset.runtimePath), asset.alphaPolicy, asset.runtimePath);
        } catch (error) {
          failures.push({ path: asset.runtimePath, ...(hash ? { hash } : {}), policy: asset.alphaPolicy, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      failures.push({ path: manifest.path, hash: createHash("sha256").update(content).digest("hex"), reason: error instanceof Error ? error.message : String(error) });
    }
    // Stop downstream reviewers/builders even if a model writes another
    // nominally submitted manifest for the exact same invalid image bytes.
    if (failures.length && manifest.status !== "change_requested") {
      kernel.upsertArtifact({ ...manifest, status: "change_requested", updatedAt: now });
    }
    // Use immutable server messages for deduplication, not author-editable
    // artifact metadata. A new failure after a verified recovery is a new cycle.
    const previous = kernel.listMessages().filter((message) => message.metadata.generatedBy === "asset_technical_validation" &&
      message.metadata.manifestArtifactId === manifest.artifactId).at(-1);
    const fingerprint = failures.length ? createHash("sha256").update(JSON.stringify(failures)).digest("hex") : "resolved";
    const blockers = task.blockers.filter((blocker) => !/^Agent Loop：/.test(blocker) ||
      /越权|删除操作|项目根目录之外/.test(blocker) ||
      (blocker.includes("等待制作人") && !/门禁|阶段|评审|验收/.test(blocker)));
    const newlyDispatchable = failures.length > 0 && previous?.metadata.repairDispatched !== true && blockers.length === 0;
    if ((previous?.metadata.fingerprint === fingerprint && !newlyDispatchable) || (!previous && !failures.length)) continue;
    const details = failures.map((failure) => `${failure.path}${failure.hash ? ` [sha256:${failure.hash}]` : ""}：${failure.reason}`).join("\n");
    if (failures.length) {
      // Only clear retry exhaustion owned by this loop; preserve manual,
      // authorization, dependency, and genuine producer-question blockers.
      // An agent waiting for stage approval despite invalid outputs is stale;
      // real producer gates and project pause remain independently enforced.
      kernel.updateTask(task.taskId, {
        status: blockers.length ? "blocked" : "doing", blockers, progressPercent: Math.min(task.progressPercent ?? 50, 80), updatedAt: now,
        description: `${task.description.replace(section, "")}\n[${marker}]\n服务端逐文件技术校验未通过：\n${details}\n修复本任务拥有的真实资产，重建联系表并提交 manifest，再交独立视觉复检。禁止用改低 alphaPolicy 或重复声明通过代替修复。\n[/${marker}]`
      });
      if (!blockers.length) {
        queued.add(task.ownerAgentId);
        kernel.updateAgentLoopAgent(task.ownerAgentId, { status: "queued", taskId: task.taskId, lastError: undefined, updatedAt: now });
      }
    } else {
      kernel.updateTask(task.taskId, { description: task.description.replace(section, ""), updatedAt: now });
    }
    kernel.recordMessage({
      messageId: `msg_asset_technical_${randomUUID()}`, projectId: kernel.project.projectId, roomId: task.roomId ?? kernel.getRoom("art-room").roomId,
      senderType: "agent", senderId: "studio_orchestrator", messageType: failures.length ? "change_request" : "progress_update",
      content: failures.length ? `服务端素材技术校验发现 ${failures.length} 个问题，已交回资产原任务修复：\n${details}\n完成后须重新提交联系表、manifest 并独立复检，不代表制作人批准。` : "本轮素材技术问题已消除；仅表示像素技术检查通过，仍需独立视觉审查和真实 Cocos 构建/试玩。",
      mentions: [task.ownerAgentId], relatedTaskIds: [task.taskId], relatedArtifactIds: [manifest.artifactId],
      metadata: { generatedBy: "asset_technical_validation", manifestArtifactId: manifest.artifactId, fingerprint, failures,
        repairDispatched: failures.length > 0 && blockers.length === 0 }, createdAt: now
    });
  }
  return [...queued];
}
