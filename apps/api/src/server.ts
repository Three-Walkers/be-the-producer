import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { modelSettingsStore, type SaveAgentModelAssignmentInput, type SaveModelProviderInput } from "./modelSettings.js";
import { claudeCliHarness } from "./claudeCliHarness.js";
import { cocosEngineSettingsStore, type SaveCocosEngineConfigInput } from "./cocosEngineSettings.js";
import { HttpError, studioStore, type CreateProjectInput, type PostMessageInput } from "./store.js";
import {
  ApiRequestError,
  assertRequestAuthorized,
  assertRequestOriginAllowed,
  loadApiSecurityConfig,
  readJsonBody,
  securityResponseHeaders,
  type ApiSecurityConfig
} from "./apiSecurity.js";
import { resolvePathWithinRoot } from "./pathSafety.js";
import { buildProjectMemoryView } from "./projectMemoryView.js";

const defaultPort = 8787;
const publicRoot = join(resolveRepoRoot(), "apps", "api", "public");

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body, null, 2));
}

async function sendStatic(response: ServerResponse, relativePath: string): Promise<void> {
  let target: string;
  try {
    target = resolvePathWithinRoot(publicRoot, relativePath, {
      allowMissing: false,
      expectedKind: "file",
      label: "静态资源路径"
    }).absolutePath;
  } catch {
    throw new HttpError(404, "Route not found");
  }
  const body = await readFile(target);
  response.writeHead(200, {
    "content-type": contentTypeFor(relativePath)
  });
  response.end(body);
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".html":
    default:
      return "text/html; charset=utf-8";
  }
}

function resolveRepoRoot(): string {
  if (process.env.INIT_CWD) {
    return process.env.INIT_CWD;
  }

  if (process.env.npm_package_json) {
    return join(dirname(process.env.npm_package_json), "..", "..");
  }

  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function routeProjectPath(pathname: string): { projectId: string; rest: string[] } | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "projects" || !parts[1]) {
    return undefined;
  }

  return {
    projectId: parts[1],
    rest: parts.slice(2)
  };
}

function routeSettingsPath(pathname: string): { resource: string; childId?: string } | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "settings" || !parts[1]) {
    return undefined;
  }

  return {
    resource: parts[1],
    ...(parts[2] ? { childId: decodeURIComponent(parts[2]) } : {})
  };
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  securityConfig: ApiSecurityConfig = loadApiSecurityConfig()
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const isStaticRequest =
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/dashboard-progress.js" || url.pathname === "/styles.css");
    const responseKind = request.method === "OPTIONS" ? "preflight" : isStaticRequest ? "static" : "api";

    const securityHeaders = securityResponseHeaders(request, securityConfig, responseKind);
    for (const [name, value] of Object.entries(securityHeaders)) {
      response.setHeader(name, value);
    }

    assertRequestOriginAllowed(request, securityConfig);
    assertRequestAuthorized(request, url.pathname, securityConfig);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" ||
        url.pathname === "/app.js" ||
        url.pathname === "/dashboard-progress.js" ||
        url.pathname === "/memory-dashboard.js" ||
        url.pathname === "/styles.css")
    ) {
      await sendStatic(response, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    const settingsRoute = routeSettingsPath(url.pathname);
    if (settingsRoute?.resource === "model-providers") {
      if (request.method === "GET" && !settingsRoute.childId) {
        sendJson(response, 200, {
          providers: modelSettingsStore.listPublic(),
          assignments: modelSettingsStore.listAgentAssignments()
        });
        return;
      }

      if (request.method === "POST" && !settingsRoute.childId) {
        const input = await readJsonBody<SaveModelProviderInput>(request, securityConfig);
        sendJson(response, 201, { provider: modelSettingsStore.createProvider(input) });
        return;
      }

      if (request.method === "PUT" && settingsRoute.childId) {
        const input = await readJsonBody<SaveModelProviderInput>(request, securityConfig);
        sendJson(response, 200, { provider: modelSettingsStore.saveProvider(settingsRoute.childId, input) });
        return;
      }

      if (request.method === "DELETE" && settingsRoute.childId) {
        sendJson(response, 200, { provider: modelSettingsStore.clearProviderKey(settingsRoute.childId) });
        return;
      }
    }

    if (settingsRoute?.resource === "model-provider-profiles") {
      if (request.method === "DELETE" && settingsRoute.childId) {
        modelSettingsStore.removeProvider(settingsRoute.childId);
        sendJson(response, 200, { ok: true });
        return;
      }
    }

    if (settingsRoute?.resource === "model-assignments") {
      if (request.method === "PUT" && settingsRoute.childId) {
        const input = await readJsonBody<SaveAgentModelAssignmentInput>(request, securityConfig);
        sendJson(response, 200, { assignment: modelSettingsStore.saveAgentAssignment(settingsRoute.childId, input) });
        return;
      }
    }

    if (settingsRoute?.resource === "model-provider-tests") {
      if (request.method === "POST" && settingsRoute.childId) {
        sendJson(response, 200, { result: await modelSettingsStore.testProvider(settingsRoute.childId) });
        return;
      }
    }

    if (settingsRoute?.resource === "agent-harnesses" && request.method === "GET") {
      sendJson(response, 200, { harnesses: [await claudeCliHarness.status()] });
      return;
    }

    if (settingsRoute?.resource === "agent-harness-tests" && request.method === "POST" && settingsRoute.childId === "claude-cli") {
      sendJson(response, 200, { result: await claudeCliHarness.status() });
      return;
    }

    if (settingsRoute?.resource === "cocos-engine") {
      if (request.method === "GET") {
        sendJson(response, 200, { config: cocosEngineSettingsStore.getPublic() });
        return;
      }
      if (request.method === "PUT") {
        const input = await readJsonBody<SaveCocosEngineConfigInput>(request, securityConfig);
        sendJson(response, 200, { config: cocosEngineSettingsStore.save(input) });
        return;
      }
    }

    if (settingsRoute?.resource === "cocos-engine-detect" && request.method === "POST") {
      sendJson(response, 200, { config: cocosEngineSettingsStore.autodetect() });
      return;
    }

    if (settingsRoute?.resource === "cocos-engine-test" && request.method === "POST") {
      sendJson(response, 200, { result: await cocosEngineSettingsStore.test() });
      return;
    }

    if (request.method === "GET" && url.pathname === "/projects") {
      sendJson(response, 200, { projects: studioStore.listProjects() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/projects") {
      const input = await readJsonBody<CreateProjectInput>(request, securityConfig);
      if (!input.name) {
        throw new HttpError(400, "name is required");
      }

      sendJson(response, 201, studioStore.createProject(input));
      return;
    }

    const projectRoute = routeProjectPath(url.pathname);
    if (!projectRoute) {
      throw new HttpError(404, "Route not found");
    }

    const kernel = studioStore.getKernel(projectRoute.projectId);
    const [resource, childId, nested] = projectRoute.rest;

    if (request.method === "GET" && !resource) {
      sendJson(response, 200, { project: kernel.project });
      return;
    }

    if (request.method === "DELETE" && !resource) {
      sendJson(response, 200, { deleted: studioStore.deleteProject(projectRoute.projectId) });
      return;
    }

    if (request.method === "POST" && resource === "start") {
      sendJson(response, 202, {
        ...(await studioStore.startProject(projectRoute.projectId)),
        taskBoard: studioStore.getKernel(projectRoute.projectId).buildTaskBoard()
      });
      return;
    }

    if (request.method === "POST" && resource === "pause") {
      sendJson(response, 200, {
        ...studioStore.pauseProject(projectRoute.projectId),
        taskBoard: studioStore.getKernel(projectRoute.projectId).buildTaskBoard()
      });
      return;
    }

    if (request.method === "GET" && resource === "agent-loop") {
      sendJson(response, 200, { agentLoop: studioStore.getAgentLoopState(projectRoute.projectId) });
      return;
    }

    if (request.method === "GET" && resource === "agent-sessions") {
      sendJson(response, 200, {
        sessions: kernel.listAgentSessions(),
        contextPackets: kernel.listContextPackets(),
        handoffCapsules: kernel.listHandoffCapsules()
      });
      return;
    }

    if (request.method === "POST" && resource === "agent-loop" && childId === "wake") {
      sendJson(response, 202, { agentLoop: studioStore.wakeAgentLoop(projectRoute.projectId) });
      return;
    }

    if (request.method === "GET" && resource === "rooms") {
      sendJson(response, 200, { rooms: kernel.listRooms() });
      return;
    }

    if (request.method === "PATCH" && resource === "rooms" && childId && nested === "participants") {
      const input = await readJsonBody<{ agentId?: string; action?: "invite" | "remove" }>(request, securityConfig);
      if (!input.agentId || (input.action !== "invite" && input.action !== "remove")) {
        throw new HttpError(400, "agentId and action=invite|remove are required");
      }
      sendJson(response, 200, studioStore.updateRoomParticipant(projectRoute.projectId, childId, input.agentId, input.action));
      return;
    }

    if (request.method === "GET" && resource === "messages") {
      sendJson(response, 200, { messages: kernel.listMessages() });
      return;
    }

    if (request.method === "GET" && resource === "activities") {
      sendJson(response, 200, { activities: kernel.listAgentActivities() });
      return;
    }

    if (request.method === "POST" && resource === "messages") {
      const input = await readJsonBody<PostMessageInput>(request, securityConfig);
      if (!input.content) {
        throw new HttpError(400, "content is required");
      }

      const result = await studioStore.postProducerMessage(projectRoute.projectId, input);
      sendJson(response, 202, {
        ...result,
        taskBoard: kernel.buildTaskBoard()
      });
      return;
    }

    if (request.method === "GET" && resource === "tasks" && childId && nested === "subtasks") {
      const subtasks = kernel.listTasks().filter((task) => task.parentTaskId === childId);
      sendJson(response, 200, { subtasks });
      return;
    }

    if (request.method === "PATCH" && resource === "tasks" && childId && nested === "status") {
      const input = await readJsonBody<{ status: Parameters<typeof kernel.updateTaskStatus>[1] }>(request, securityConfig);
      if (!input.status) {
        throw new HttpError(400, "status is required");
      }
      let task;
      try {
        task = kernel.updateTaskStatus(childId, input.status);
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "任务状态更新被证据门禁拦截。");
      }
      const workspace = studioStore.syncWorkspace(projectRoute.projectId);
      sendJson(response, 200, { task, taskBoard: kernel.buildTaskBoard(), workspace });
      return;
    }

    if (request.method === "GET" && resource === "tasks") {
      sendJson(response, 200, { tasks: kernel.listTasks() });
      return;
    }

    if (request.method === "GET" && resource === "task-board") {
      sendJson(response, 200, { taskBoard: kernel.buildTaskBoard() });
      return;
    }

    if (request.method === "GET" && resource === "workflow") {
      sendJson(response, 200, {
        workflow: kernel.getWorkflowSnapshot(),
        events: kernel.listWorkflowEvents()
      });
      return;
    }

    if (request.method === "GET" && resource === "workspace-tree") {
      sendJson(response, 200, studioStore.readWorkspaceTree(projectRoute.projectId));
      return;
    }

    if (request.method === "POST" && resource === "workspace" && childId === "open") {
      const input = await readJsonBody<{ path?: string; allowFallback?: boolean }>(request, securityConfig);
      if (!input.path) {
        throw new HttpError(400, "path is required");
      }
      sendJson(
        response,
        200,
        studioStore.openWorkspacePath(projectRoute.projectId, input.path, input.allowFallback === undefined ? {} : { allowFallback: input.allowFallback })
      );
      return;
    }

    if (request.method === "GET" && resource === "artifacts" && childId && nested === "preview") {
      sendJson(response, 200, studioStore.readArtifactPreview(projectRoute.projectId, childId));
      return;
    }

    if (request.method === "POST" && resource === "artifacts" && childId && nested === "open") {
      sendJson(response, 200, studioStore.openArtifactInFinder(projectRoute.projectId, childId));
      return;
    }

    if (request.method === "GET" && resource === "artifacts") {
      sendJson(response, 200, { artifacts: kernel.listArtifacts() });
      return;
    }

    if (request.method === "GET" && resource === "memory") {
      sendJson(response, 200, buildProjectMemoryView(kernel));
      return;
    }

    if (request.method === "GET" && resource === "audit-events") {
      sendJson(response, 200, { auditEvents: kernel.listAuditEvents() });
      return;
    }

    if (request.method === "GET" && resource === "production-audit") {
      const auditRuns = kernel.listProductionAuditRuns();
      const evidenceBundles = kernel.listEvidenceBundles();
      const latestRun = auditRuns.at(-1);
      sendJson(response, 200, {
        taskEpisodes: kernel.listTaskEpisodes(),
        evidenceBundles,
        findings: kernel.listProductionAuditFindings(),
        interventions: kernel.listInterventionLedger(),
        auditRuns,
        latestRun: latestRun ?? null,
        latestBundle: latestRun
          ? evidenceBundles.find((bundle) => bundle.bundleId === latestRun.bundleId) ?? null
          : null
      });
      return;
    }

    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.statusCode === 401) {
        response.setHeader("www-authenticate", "Bearer");
      }
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    if (error instanceof HttpError) {
      sendJson(response, error.statusCode, { error: error.message, ...(error.details ? { details: error.details } : {}) });
      return;
    }

    sendJson(response, 500, {
      error: "Internal server error"
    });
  }
}

export function startServer(port = Number(process.env.PORT ?? defaultPort), host = process.env.HOST ?? "127.0.0.1"): ReturnType<typeof createServer> {
  const securityConfig = loadApiSecurityConfig({ bindHost: host });
  const server = createServer((request, response) => {
    void handleRequest(request, response, securityConfig);
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Set PORT or run with --port to choose another port.`);
      process.exitCode = 1;
      return;
    }

    console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`Game Pipeline Agents API listening on http://${host}:${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
