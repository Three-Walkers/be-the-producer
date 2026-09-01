import assert from "node:assert/strict";
import {
  AgentExecutionPool,
  AgentWorkerQueueCancelledError,
  AgentWorkerQueueTimeoutError
} from "../apps/api/dist/agentExecutionPool.js";

const pool = new AgentExecutionPool({ concurrency: 2 });
let active = 0;
let peak = 0;
const releases = [];
const jobs = Array.from({ length: 4 }, (_, index) => pool.run({ queueTimeoutMs: 2_000 }, async () => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => releases.push(resolve));
  active -= 1;
  return index;
}));

await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(pool.activeCount, 2);
assert.equal(pool.queuedCount, 2);
assert.equal(peak, 2);
releases.splice(0).forEach((release) => release());
await new Promise((resolve) => setTimeout(resolve, 20));
releases.splice(0).forEach((release) => release());
assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);
assert.equal(pool.activeCount, 0);

const blocking = new AgentExecutionPool({ concurrency: 1 });
let unblock;
const first = blocking.run({}, () => new Promise((resolve) => { unblock = resolve; }));
await new Promise((resolve) => setTimeout(resolve, 10));
await assert.rejects(
  blocking.run({ queueTimeoutMs: 20 }, async () => "never"),
  (error) => error instanceof AgentWorkerQueueTimeoutError
);

const controller = new AbortController();
const cancelled = blocking.run({ abortSignal: controller.signal, queueTimeoutMs: 1_000 }, async () => "never");
controller.abort();
await assert.rejects(cancelled, (error) => error instanceof AgentWorkerQueueCancelledError);
unblock();
await first;

console.log("Agent execution pool passed: bounded concurrency, FIFO drain, queue timeout, and cancellation");
