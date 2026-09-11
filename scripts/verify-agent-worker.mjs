import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ModelRequestError } from "../apps/api/dist/modelClient.js";
import { runIsolatedModelChat } from "../apps/api/dist/isolatedModelWorker.js";

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.equal(request.headers.authorization, "Bearer worker-secret");
  if (body.messages?.at(-1)?.content === "wait") {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "worker-response",
    choices: [{ message: { content: "isolated worker ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3 }
  }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const provider = {
  providerId: "worker-test",
  label: "Worker Test",
  protocol: "openai-compatible",
  baseUrl: `http://127.0.0.1:${address.port}/v1`,
  defaultModel: "worker-model",
  apiKey: "worker-secret"
};

try {
  const activities = [];
  const result = await runIsolatedModelChat(provider, {
    systemPrompt: "system",
    userPrompt: "respond",
    model: "worker-model",
    timeoutMs: 5_000,
    stream: false,
    requestPurpose: "worker_smoke",
    onActivity: (activity) => activities.push(activity)
  }, { maxOldSpaceMb: 128 });
  assert.equal(result.content, "isolated worker ok");
  assert.equal(result.trace.requestPurpose, "worker_smoke");
  assert.deepEqual(activities.map((activity) => activity.type), [
    "request_started",
    "response_headers",
    "first_output",
    "response_completed"
  ]);

  const controller = new AbortController();
  const cancelled = runIsolatedModelChat(provider, {
    systemPrompt: "system",
    userPrompt: "wait",
    model: "worker-model",
    timeoutMs: 5_000,
    stream: false,
    abortSignal: controller.signal
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled, (error) => error instanceof ModelRequestError && error.kind === "cancelled");
} finally {
  server.close();
  await once(server, "close");
}

console.log("Agent worker passed: isolated model execution, activity forwarding, memory bound, and cancellation");
