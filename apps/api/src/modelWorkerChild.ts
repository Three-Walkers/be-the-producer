import { generateModelChat, ModelRequestError } from "./modelClient.js";
import { isModelWorkerRequest, type ModelWorkerEvent } from "./modelWorkerProtocol.js";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (input.length > 16 * 1024 * 1024) {
    writeEvent({
      type: "error",
      requestId: "unknown",
      error: { name: "WorkerProtocolError", message: "Agent Worker 请求超过 16MB 限制。" }
    });
    process.exitCode = 1;
    process.stdin.destroy();
  }
});

process.stdin.on("end", () => {
  void run();
});

async function run(): Promise<void> {
  let requestId = "unknown";
  try {
    const request: unknown = JSON.parse(input);
    if (!isModelWorkerRequest(request)) {
      throw new Error("Agent Worker 收到无效的协议请求。");
    }
    requestId = request.requestId;
    const result = await generateModelChat(request.provider, {
      ...request.input,
      onActivity: (activity) => writeEvent({ type: "activity", requestId, activity })
    });
    writeEvent({ type: "result", requestId, result });
  } catch (error) {
    writeEvent({
      type: "error",
      requestId,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ModelRequestError ? { kind: error.kind, trace: error.trace } : {})
      }
    });
    process.exitCode = 1;
  }
}

function writeEvent(event: ModelWorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
