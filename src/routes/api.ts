import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import {
  AssignTaskInput,
  CreateProjectWorktreeInput,
  CreateTaskInput,
  CreateWorkerInput,
  RegisterProjectInput,
} from "../domain/types.js";
import { AppError } from "../application/appError.js";
import { ControllerService } from "../application/controllerService.js";
import { readJsonBody, sendJson } from "../utils/http.js";

export class ApiRouter {
  constructor(private readonly controllerService: ControllerService) {}

  private getPathParam(pathname: string, index: number): string {
    const value = pathname.split("/")[index];

    if (!value) {
      throw new AppError(400, "INVALID_ROUTE_PARAM", `Route parameter ${index} is missing.`);
    }

    return value;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");

    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, service: "open-agent-center" });
      return;
    }

    if (method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, this.controllerService.getState());
      return;
    }

    if (method === "GET" && url.pathname === "/api/projects") {
      sendJson(response, 200, this.controllerService.listProjects());
      return;
    }

    if (method === "GET" && url.pathname === "/api/workers") {
      sendJson(response, 200, this.controllerService.listWorkers());
      return;
    }

    if (method === "GET" && /^\/api\/workers\/[^/]+\/diff$/.test(url.pathname)) {
      const workerId = this.getPathParam(url.pathname, 3);
      const diff = await this.controllerService.getWorkerDiff(workerId);
      sendJson(response, 200, diff);
      return;
    }

    if (method === "GET" && /^\/api\/tasks\/[^/]+$/.test(url.pathname)) {
      const taskId = this.getPathParam(url.pathname, 3);
      const detail = this.controllerService.getTaskDetail(taskId);
      sendJson(response, 200, detail);
      return;
    }

    if (method === "GET" && url.pathname === "/api/tasks") {
      sendJson(response, 200, this.controllerService.listTasks());
      return;
    }

    if (method === "POST" && url.pathname === "/api/projects") {
      const body = await readJsonBody<RegisterProjectInput>(request);
      const project = await this.controllerService.registerProject(body);
      sendJson(response, 201, project);
      return;
    }

    if (method === "POST" && /^\/api\/projects\/[^/]+\/worktrees$/.test(url.pathname)) {
      const projectId = this.getPathParam(url.pathname, 3);
      const body = await readJsonBody<CreateProjectWorktreeInput>(request);
      const result = await this.controllerService.createProjectWorktree(projectId, body);
      sendJson(response, 201, result);
      return;
    }

    if (method === "POST" && url.pathname === "/api/workers") {
      const body = await readJsonBody<CreateWorkerInput>(request);
      const worker = await this.controllerService.createWorker(body);
      sendJson(response, 201, worker);
      return;
    }

    if (method === "POST" && url.pathname === "/api/tasks") {
      const body = await readJsonBody<CreateTaskInput>(request);
      const task = await this.controllerService.createTask(body);
      sendJson(response, 201, task);
      return;
    }

    if (method === "POST" && url.pathname === "/api/assignments") {
      const body = await readJsonBody<AssignTaskInput>(request);
      const assignment = await this.controllerService.assignTask(body);
      sendJson(response, 201, assignment);
      return;
    }

    if (method === "POST" && url.pathname.startsWith("/api/workers/") && url.pathname.endsWith("/launch")) {
      const workerId = this.getPathParam(url.pathname, 3);
      const updatedWorker = await this.controllerService.launchWorker(workerId);
      sendJson(response, 200, updatedWorker);
      return;
    }

    sendJson(response, 404, {
      error: `Route not found: ${method} ${url.pathname}`,
    });
  }

  handleError(response: ServerResponse, error: unknown): void {
    if (error instanceof AppError) {
      sendJson(response, error.statusCode, {
        error: error.message,
        errorCode: error.errorCode,
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected server error.";
    sendJson(response, 500, {
      error: message,
      errorCode: "INTERNAL_SERVER_ERROR",
    });
  }
}
