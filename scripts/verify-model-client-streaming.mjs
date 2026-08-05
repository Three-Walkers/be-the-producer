import assert from "node:assert/strict";
import { createServer } from "node:http";

const requests = [];
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push({
    path: request.url,
    headers: request.headers,
    body: JSON.parse(body)
  });

  if (request.url?.endsWith("/messages") && requests.filter((item) => item.path?.endsWith("/messages")).length === 1) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-request-id": "req_anthropic_stream"
    });
    response.flushHeaders();
    setTimeout(() => {
      response.write('data: {"type":"message_start","message":{"id":"msg_stream","usage":{"input_tokens":12}}}\n\n');
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"流式"}}\n\n');
      response.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"回复"}}\n\n');
      response.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n');
      response.end('data: {"type":"message_stop"}\n\n');
    }, 25);
    return;
  }

  if (request.url?.endsWith("/chat/completions")) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "x-dashscope-request-id": "req_openai_stream"
    });
    response.flushHeaders();
    response.write('data: {"id":"chat_stream","choices":[{"delta":{"content":"房间"}}]}\n\n');
    response.end('data: {"id":"chat_stream","choices":[{"delta":{"content":"回复"},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream" });
  response.flushHeaders();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

const { generateModelChat, ModelRequestError } = await import("../apps/api/dist/modelClient.js");

const anthropic = await generateModelChat({
  providerId: "dashscope-anthropic-qwen",
  label: "test-anthropic",
  protocol: "anthropic",
  baseUrl,
  defaultModel: "qwen3.7-plus",
  apiKey: "test-only"
}, {
  systemPrompt: "system",
  userPrompt: "user",
  model: "qwen3.7-plus",
  stream: true,
  thinkingMode: "disabled",
  timeoutMs: 3_000,
  idleTimeoutMs: 1_000,
  requestPurpose: "stream-test"
});

assert.equal(anthropic.content, "流式回复");
assert.equal(anthropic.trace.providerRequestId, "req_anthropic_stream");
assert.equal(anthropic.trace.responseId, "msg_stream");
assert.equal(anthropic.trace.thinkingMode, "disabled");
assert.ok((anthropic.trace.firstChunkMs ?? -1) >= 0);
assert.equal(requests[0].body.stream, true);
assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
assert.equal(requests[0].headers["x-btp-operation-id"], anthropic.trace.operationId);

const openai = await generateModelChat({
  providerId: "dashscope",
  label: "test-openai",
  protocol: "openai-compatible",
  baseUrl,
  defaultModel: "qwen3.7-plus",
  apiKey: "test-only"
}, {
  systemPrompt: "system",
  userPrompt: "user",
  model: "qwen3.7-plus",
  stream: true,
  thinkingMode: "disabled",
  queueWaitTimeoutMs: 30_000,
  timeoutMs: 3_000,
  idleTimeoutMs: 1_000
});

assert.equal(openai.content, "房间回复");
assert.equal(openai.trace.providerRequestId, "req_openai_stream");
assert.equal(requests[1].body.enable_thinking, false);
assert.equal(requests[1].body.stream, true);
assert.equal(requests[1].headers["x-dashscope-wait-timeout"], "30");

await assert.rejects(
  generateModelChat({
    providerId: "dashscope-anthropic-qwen",
    label: "test-idle",
    protocol: "anthropic",
    baseUrl,
    defaultModel: "qwen3.7-plus",
    apiKey: "test-only"
  }, {
    systemPrompt: "system",
    userPrompt: "user",
    model: "qwen3.7-plus",
    stream: true,
    thinkingMode: "disabled",
    timeoutMs: 3_000,
    idleTimeoutMs: 1_000
  }),
  (error) => error instanceof ModelRequestError && error.kind === "timeout_idle" && error.trace.totalMs >= 1_000
);

await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
process.stdout.write("Model client streaming smoke passed: thinking control, SSE trace, queue header, idle timeout\n");
