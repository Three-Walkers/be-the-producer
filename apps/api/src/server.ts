import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import { modelSettingsStore, type SaveModelProviderInput } from "./modelSettings.js";
import { HttpError, studioStore, type CreateProjectInput, type PostMessageInput } from "./store.js";

const defaultPort = 8787;
const publicRoot = join(resolveRepoRoot(), "apps", "api", "public");

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(body, null, 2));
}

async function sendStatic(response: ServerResponse, relativePath: string): Promise<void> {
  const safePath = normalize(relativePath);
  if (safePath.startsWith("..") || safePath.includes(`${sep}..${sep}`)) {
    throw new HttpError(404, "Route not found");
  }

  const body = await readFile(join(publicRoot, safePath));
  response.writeHead(200, {
    "content-type": contentTypeFor(safePath)
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
    ...(parts[2] ? { childId: parts[2] } : {})
  };
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method === "OPTIONS") {
      sendJson(response, 204, {});
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app.js" || url.pathname === "/styles.css")) {
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
        sendJson(response, 200, { providers: modelSettingsStore.listPublic() });
        return;
      }

      if (request.method === "PUT" && settingsRoute.childId) {
        const input = await readJson<SaveModelProviderInput>(request);
        sendJson(response, 200, { provider: modelSettingsStore.saveProvider(settingsRoute.childId, input) });
        return;
      }

      if (request.method === "DELETE" && settingsRoute.childId) {
        sendJson(response, 200, { provider: modelSettingsStore.clearProviderKey(settingsRoute.childId) });
        return;
      }
    }

    if (request.method === "GET" && url.pathname === "/projects") {
      sendJson(response, 200, { projects: studioStore.listProjects() });
      return;
    }

    if (request.method === "POST" && url.pathname === "/projects") {
      const input = await readJson<CreateProjectInput>(request);
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
        ...studioStore.startProject(projectRoute.projectId),
        taskBoard: studioStore.getKernel(projectRoute.projectId).buildTaskBoard()
      });
      return;
    }

    if (request.method === "GET" && resource === "rooms") {
      sendJson(response, 200, { rooms: kernel.listRooms() });
      return;
    }

    if (request.method === "GET" && resource === "messages") {
      sendJson(response, 200, { messages: kernel.listMessages() });
      return;
    }

    if (request.method === "POST" && resource === "messages") {
      const input = await readJson<PostMessageInput>(request);
      if (!input.content) {
        throw new HttpError(400, "content is required");
      }

      const result = studioStore.postProducerMessage(projectRoute.projectId, input);
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
      const input = await readJson<{ status: Parameters<typeof kernel.updateTaskStatus>[1] }>(request);
      if (!input.status) {
        throw new HttpError(400, "status is required");
      }
      const task = kernel.updateTaskStatus(childId, input.status);
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

    if (request.method === "GET" && resource === "workspace-tree") {
      sendJson(response, 200, studioStore.readWorkspaceTree(projectRoute.projectId));
      return;
    }

    if (request.method === "GET" && resource === "artifacts") {
      sendJson(response, 200, { artifacts: kernel.listArtifacts() });
      return;
    }

    if (request.method === "GET" && resource === "memory") {
      sendJson(response, 200, {
        memory: kernel.memory.query({
          projectId: projectRoute.projectId,
          status: ["active", "draft", "superseded", "rejected"]
        })
      });
      return;
    }

    if (request.method === "GET" && resource === "audit-events") {
      sendJson(response, 200, { auditEvents: kernel.listAuditEvents() });
      return;
    }

    throw new HttpError(404, "Route not found");
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(response, error.statusCode, { error: error.message });
      return;
    }

    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

export function startServer(port = Number(process.env.PORT ?? defaultPort), host = process.env.HOST ?? "127.0.0.1"): ReturnType<typeof createServer> {
  const server = createServer((request, response) => {
    void handleRequest(request, response);
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
    console.log(`Game Pipeline Agents API listening on http://localhost:${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
