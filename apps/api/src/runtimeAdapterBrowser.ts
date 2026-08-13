import type { PlaytestAction } from "@game-pipeline/shared-schemas";
import type { Page } from "playwright-core";
import {
  assertRuntimeSnapshot,
  type RuntimeAdapter,
  type RuntimeAdapterActionResult,
  type RuntimeAdapterHandshake,
  type RuntimeAdapterSnapshot
} from "./runtimeAdapter.js";

interface BrowserRuntimeApiShape {
  protocolVersion?: unknown;
  playtestId?: unknown;
  revision?: unknown;
  contractHash?: unknown;
  getHandshake?: unknown;
  getSnapshot?: unknown;
  perform?: unknown;
}

/** Browser-side client for the explicit `globalThis.__BTP_PLAYTEST__` API. */
export class BrowserRuntimeAdapter implements RuntimeAdapter {
  private constructor(private readonly page: Page) {}

  static async connect(page: Page, timeoutMs = 15_000): Promise<BrowserRuntimeAdapter> {
    await page.waitForFunction(() => {
      const api = (globalThis as unknown as { __BTP_PLAYTEST__?: BrowserRuntimeApiShape }).__BTP_PLAYTEST__;
      return Boolean(api && typeof api.getSnapshot === "function" && typeof api.perform === "function");
    }, undefined, { timeout: timeoutMs });
    return new BrowserRuntimeAdapter(page);
  }

  async getHandshake(): Promise<RuntimeAdapterHandshake> {
    const value = await this.page.evaluate(async () => {
      const api = (globalThis as unknown as { __BTP_PLAYTEST__?: BrowserRuntimeApiShape }).__BTP_PLAYTEST__;
      if (!api) throw new Error("缺少 globalThis.__BTP_PLAYTEST__。");
      if (typeof api.getHandshake === "function") {
        return await (api.getHandshake as () => unknown | Promise<unknown>)();
      }
      return {
        protocolVersion: api.protocolVersion,
        playtestId: api.playtestId,
        revision: api.revision,
        contractHash: api.contractHash
      };
    });
    if (!isRecord(value) || typeof value.protocolVersion !== "string" || typeof value.playtestId !== "string" ||
      !Number.isInteger(value.revision) || Number(value.revision) <= 0) {
      throw new Error("运行时 __BTP_PLAYTEST__ 握手格式无效。");
    }
    return {
      protocolVersion: value.protocolVersion as RuntimeAdapterHandshake["protocolVersion"],
      playtestId: value.playtestId,
      revision: Number(value.revision),
      ...(typeof value.contractHash === "string" && value.contractHash ? { contractHash: value.contractHash } : {})
    };
  }

  async getSnapshot(): Promise<RuntimeAdapterSnapshot> {
    const value = await this.page.evaluate(async () => {
      const api = (globalThis as unknown as { __BTP_PLAYTEST__?: BrowserRuntimeApiShape }).__BTP_PLAYTEST__;
      if (!api || typeof api.getSnapshot !== "function") throw new Error("运行时适配器缺少 getSnapshot()。");
      return await (api.getSnapshot as () => unknown | Promise<unknown>)();
    });
    return assertRuntimeSnapshot(value);
  }

  async perform(action: PlaytestAction): Promise<RuntimeAdapterActionResult> {
    if (action.type === "wait") {
      await this.wait(action.durationMs);
      return { ok: true };
    }
    const value = await this.page.evaluate(async (runtimeAction) => {
      const api = (globalThis as unknown as { __BTP_PLAYTEST__?: BrowserRuntimeApiShape }).__BTP_PLAYTEST__;
      if (!api || typeof api.perform !== "function") throw new Error("运行时适配器缺少 perform()。");
      return await (api.perform as (input: PlaytestAction) => unknown | Promise<unknown>)(runtimeAction);
    }, action);
    if (value === undefined || value === true) return { ok: true };
    if (value === false) return { ok: false, details: "运行时拒绝执行动作。" };
    if (!isRecord(value) || typeof value.ok !== "boolean") {
      throw new Error("运行时 perform() 必须返回 boolean、void 或 { ok, details? }。");
    }
    return {
      ok: value.ok,
      ...(typeof value.details === "string" ? { details: value.details } : {})
    };
  }

  async wait(durationMs: number): Promise<void> {
    await this.page.waitForTimeout(durationMs);
  }

  async reset(): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await this.page.waitForFunction(() => {
      const api = (globalThis as unknown as { __BTP_PLAYTEST__?: BrowserRuntimeApiShape }).__BTP_PLAYTEST__;
      return Boolean(api && typeof api.getSnapshot === "function" && typeof api.perform === "function");
    }, undefined, { timeout: 15_000 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
