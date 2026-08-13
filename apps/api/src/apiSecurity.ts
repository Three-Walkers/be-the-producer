import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const defaultJsonBodyLimitBytes = 1024 * 1024;
const maximumJsonBodyLimitBytes = 10 * 1024 * 1024;

export interface ApiSecurityConfig {
  bindHost: string;
  apiToken: string | undefined;
  allowedOrigins: ReadonlySet<string>;
  jsonBodyLimitBytes: number;
}

export class ApiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function loadApiSecurityConfig(options: {
  bindHost?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ApiSecurityConfig {
  const env = options.env ?? process.env;
  const bindHost = options.bindHost ?? env.HOST ?? "127.0.0.1";
  const apiToken = parseApiToken(env.BTP_API_TOKEN);
  const config: ApiSecurityConfig = {
    bindHost,
    apiToken,
    allowedOrigins: parseAllowedOrigins(env.BTP_ALLOWED_ORIGINS),
    jsonBodyLimitBytes: parseJsonBodyLimit(env.BTP_JSON_BODY_LIMIT_BYTES)
  };

  assertSecureBindConfiguration(config);
  return config;
}

export function assertSecureBindConfiguration(config: Pick<ApiSecurityConfig, "bindHost" | "apiToken">): void {
  if (!isLoopbackHost(config.bindHost) && !config.apiToken) {
    throw new Error("Refusing to bind the API to a non-loopback host without BTP_API_TOKEN.");
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isIpv4Loopback(normalized.slice("::ffff:".length));
  }

  return isIpv4Loopback(normalized);
}

export function assertRequestOriginAllowed(request: IncomingMessage, config: ApiSecurityConfig): void {
  assertSafeLoopbackHost(request, config);
  const origin = singleHeader(request, "origin");
  if (!origin) {
    return;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin || !isAllowedOrigin(request, normalizedOrigin, config)) {
    throw new ApiRequestError(403, "Origin is not allowed");
  }
}

function assertSafeLoopbackHost(request: IncomingMessage, config: ApiSecurityConfig): void {
  if (config.apiToken || !isLoopbackHost(config.bindHost)) {
    return;
  }
  const host = singleHeader(request, "host");
  if (!host) {
    throw new ApiRequestError(400, "Host header is required");
  }
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    throw new ApiRequestError(400, "Host header is invalid");
  }
  if (!isLoopbackHost(hostname)) {
    throw new ApiRequestError(403, "Loopback API requires a loopback Host header");
  }
}

export function assertRequestAuthorized(request: IncomingMessage, pathname: string, config: ApiSecurityConfig): void {
  if (!config.apiToken || isPublicRoute(request.method, pathname)) {
    return;
  }

  const authorization = singleHeader(request, "authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1] || !constantTimeEqual(match[1], config.apiToken)) {
    throw new ApiRequestError(401, "Authentication required");
  }
}

export async function readJsonBody<T>(request: IncomingMessage, config: ApiSecurityConfig): Promise<T> {
  const contentType = singleHeader(request, "content-type");
  if (!contentType || !isJsonContentType(contentType)) {
    throw new ApiRequestError(415, "Content-Type must be application/json");
  }

  const contentEncoding = singleHeader(request, "content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    throw new ApiRequestError(415, "Encoded request bodies are not supported");
  }

  const declaredLength = parseContentLength(singleHeader(request, "content-length"));
  if (declaredLength !== undefined && declaredLength > config.jsonBodyLimitBytes) {
    throw new ApiRequestError(413, "JSON request body is too large");
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.byteLength;
    if (receivedBytes > config.jsonBodyLimitBytes) {
      throw new ApiRequestError(413, "JSON request body is too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks, receivedBytes).toString("utf8")) as T;
  } catch {
    throw new ApiRequestError(400, "Malformed JSON request body");
  }
}

export function securityResponseHeaders(
  request: IncomingMessage,
  config: ApiSecurityConfig | undefined,
  kind: "api" | "static" | "preflight"
): Record<string, string> {
  const headers: Record<string, string> = {
    "cache-control": kind === "static" ? "no-cache" : "no-store",
    "content-security-policy": "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  };

  const origin = singleHeader(request, "origin");
  const normalizedOrigin = origin ? normalizeOrigin(origin) : undefined;
  if (config && normalizedOrigin && isAllowedOrigin(request, normalizedOrigin, config)) {
    headers["access-control-allow-origin"] = normalizedOrigin;
    headers.vary = "Origin";
  }

  if (kind === "preflight") {
    headers["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    headers["access-control-allow-headers"] = "authorization,content-type";
    headers["access-control-max-age"] = "600";
  }

  return headers;
}

function isPublicRoute(method: string | undefined, pathname: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }

  if (method !== "GET") {
    return false;
  }

  return pathname === "/health" || pathname === "/" || pathname === "/app.js" || pathname === "/dashboard-progress.js" || pathname === "/styles.css";
}

function isAllowedOrigin(request: IncomingMessage, origin: string, config: ApiSecurityConfig): boolean {
  return origin === requestSameOrigin(request) || config.allowedOrigins.has(origin);
}

function requestSameOrigin(request: IncomingMessage): string | undefined {
  const host = singleHeader(request, "host");
  if (!host) {
    return undefined;
  }

  const encrypted = Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
  try {
    return new URL(`${encrypted ? "https" : "http"}://${host}`).origin;
  } catch {
    return undefined;
  }
}

function parseApiToken(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (!value.trim() || /\s/.test(value)) {
    throw new Error("BTP_API_TOKEN must be a non-empty token without whitespace.");
  }
  return value;
}

function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const candidate of value?.split(",") ?? []) {
    if (!candidate.trim()) {
      continue;
    }
    const origin = normalizeOrigin(candidate.trim());
    if (!origin || origin === "null") {
      throw new Error("BTP_ALLOWED_ORIGINS must contain only absolute http(s) origins.");
    }
    origins.add(origin);
  }
  return origins;
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null" || url.username || url.password) {
      return undefined;
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function parseJsonBodyLimit(value: string | undefined): number {
  if (value === undefined || value === "") {
    return defaultJsonBodyLimitBytes;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("BTP_JSON_BODY_LIMIT_BYTES must be an integer between 1 and 10485760.");
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > maximumJsonBodyLimitBytes) {
    throw new Error("BTP_JSON_BODY_LIMIT_BYTES must be an integer between 1 and 10485760.");
  }
  return bytes;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new ApiRequestError(400, "Invalid Content-Length header");
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) {
    throw new ApiRequestError(400, "Invalid Content-Length header");
  }
  return bytes;
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function isIpv4Loopback(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
    return false;
  }
  return Number(octets[0]) === 127;
}
