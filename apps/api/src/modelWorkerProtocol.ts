import type { ModelChatInput, ModelChatResult, ModelRequestActivity, ModelRequestFailureKind, ModelRequestTrace } from "./modelClient.js";
import type { ModelProviderConfig } from "./modelSettings.js";

export type SerializableModelChatInput = Omit<ModelChatInput, "abortSignal" | "onActivity">;

export interface ModelWorkerRequest {
  protocolVersion: 1;
  requestId: string;
  provider: ModelProviderConfig;
  input: SerializableModelChatInput;
}

export type ModelWorkerEvent =
  | { type: "activity"; requestId: string; activity: ModelRequestActivity }
  | { type: "result"; requestId: string; result: ModelChatResult }
  | {
      type: "error";
      requestId: string;
      error: {
        name: string;
        message: string;
        kind?: ModelRequestFailureKind;
        trace?: ModelRequestTrace;
      };
    };

export function isModelWorkerRequest(value: unknown): value is ModelWorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ModelWorkerRequest>;
  return record.protocolVersion === 1
    && typeof record.requestId === "string"
    && Boolean(record.provider && typeof record.provider === "object")
    && Boolean(record.input && typeof record.input === "object");
}

export function isModelWorkerEvent(value: unknown): value is ModelWorkerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ModelWorkerEvent>;
  return typeof record.requestId === "string"
    && (record.type === "activity" || record.type === "result" || record.type === "error");
}
