import { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

import {
  AssignTaskInput,
  CreateProjectWorktreeInput,
  CreateTaskInput,
  CreateWorkerInput,
  ListWorkersInput,
  RegisterProjectInput,
  SyncWorkerBranchInput,
  WorkerHeartbeatInput,
} from "../domain/types.js";
import { AppError } from "../application/appError.js";
import { ControllerService } from "../application/controllerService.js";
import { readJsonBody, redirect, sendJson, sendText } from "../utils/http.js";

const DASHBOARD_ASSET_DIR = path.resolve(process.cwd(), "public");
const DASHBOARD_ASSETS: Record<string, { fileName: string; contentType: string }> = {
  "/dashboard": { fileName: "dashboard.html", contentType: "text/html; charset=utf-8" },
  "/dashboard.css": { fileName: "dashboard.css", contentType: "text/css; charset=utf-8" },
  "/dashboard.js": { fileName: "dashboard.js", contentType: "text/javascript; charset=utf-8" },
};

export class ApiRouter {
  constructor(private readonly controllerService: ControllerService) {}

  private async serveDashboardAsset(response: ServerResponse, pathname: string): Promise<void> {
    const asset = DASHBOARD_ASSETS[pathname];

    if (!asset) {
      throw new AppError(404, "DASHBOARD_ASSET_NOT_FOUND", `Dashboard asset not found: ${pathname}`);
    }

    try {
      const content = await readFile(path.join(DASHBOARD_ASSET_DIR, asset.fileName), "utf8");
      sendText(response, 200, asset.contentType, content);
    } catch {
      throw new AppError(404, "DASHBOARD_ASSET_NOT_FOUND", `Dashboard asset not found: ${pathname}`);
    }
  }

  private parseBooleanParam(value: string | null, fieldName: string): boolean | undefined {
    if (value === null) {
      return undefined;
    }

    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }

    throw new AppError(400, "INVALID_QUERY_PARAM", `${fieldName} must be true or false.`);
  }

  private parseIntegerParam(value: string | null, fieldName: string): number | undefined {
    if (value === null) {
      return undefined;
    }

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new AppError(400, "INVALID_QUERY_PARAM", `${fieldName} must be a non-negative integer.`);
    }

    return parsed;
  }

  private parseListWorkersQuery(url: URL): ListWorkersInput {
    const status = url.searchParams.get("status");
    const hasChanges = this.parseBooleanParam(url.searchParams.get("hasChanges"), "hasChanges");
    const isStale = this.parseBooleanParam(url.searchParams.get("isStale"), "isStale");
    const includeDiff = this.parseBooleanParam(url.searchParams.get("includeDiff"), "includeDiff");
    const taskId = url.searchParams.get("taskId");
    const branch = url.searchParams.get("branch");
    const lastSyncStatus = url.searchParams.get("lastSyncStatus");
    const sortBy = url.searchParams.get("sortBy");
    const sortOrder = url.searchParams.get("sortOrder");
    const limit = this.parseIntegerParam(url.searchParams.get("limit"), "limit");
    const offset = this.parseIntegerParam(url.searchParams.get("offset"), "offset");

    if (status && !["idle", "active", "blocked", "offline"].includes(status)) {
      throw new AppError(400, "INVALID_QUERY_PARAM", "status must be idle, active, blocked, or offline.");
    }

    if (sortBy && !["name", "status", "lastSeenAt", "heartbeatAgeMs", "changedFileCount"].includes(sortBy)) {
      throw new AppError(
        400,
        "INVALID_QUERY_PARAM",
        "sortBy must be name, status, lastSeenAt, heartbeatAgeMs, or changedFileCount.",
      );
    }

    if (sortOrder && !["asc", "desc"].includes(sortOrder)) {
      throw new AppError(400, "INVALID_QUERY_PARAM", "sortOrder must be asc or desc.");
    }

    if (lastSyncStatus && !["synced", "conflicted"].includes(lastSyncStatus)) {
      throw new AppError(400, "INVALID_QUERY_PARAM", "lastSyncStatus must be synced or conflicted.");
    }

    const query: ListWorkersInput = {};

    if (status) {
      const statusValue: NonNullable<ListWorkersInput["status"]> = status as NonNullable<ListWorkersInput["status"]>;
      query.status = statusValue;
    }

    if (hasChanges !== undefined) {
      query.hasChanges = hasChanges;
    }

    if (isStale !== undefined) {
      query.isStale = isStale;
    }

    if (includeDiff !== undefined) {
      query.includeDiff = includeDiff;
    }

    if (taskId) {
      query.taskId = taskId;
    }

    if (branch) {
      query.branch = branch;
    }

    if (lastSyncStatus) {
      const lastSyncStatusValue: NonNullable<ListWorkersInput["lastSyncStatus"]> =
        lastSyncStatus as NonNullable<ListWorkersInput["lastSyncStatus"]>;
      query.lastSyncStatus = lastSyncStatusValue;
    }

    if (sortBy) {
      const sortByValue: NonNullable<ListWorkersInput["sortBy"]> =
        sortBy as NonNullable<ListWorkersInput["sortBy"]>;
      query.sortBy = sortByValue;
    }

    if (sortOrder) {
      const sortOrderValue: NonNullable<ListWorkersInput["sortOrder"]> =
        sortOrder as NonNullable<ListWorkersInput["sortOrder"]>;
      query.sortOrder = sortOrderValue;
    }

    if (limit !== undefined) {
      query.limit = limit;
    }

    if (offset !== undefined) {
      query.offset = offset;
    }

    return query;
  }

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

    if (method === "GET" && url.pathname === "/") {
      redirect(response, "/dashboard");
      return;
    }

    if (method === "GET" && url.pathname in DASHBOARD_ASSETS) {
      await this.serveDashboardAsset(response, url.pathname);
      return;
    }

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
      sendJson(response, 200, await this.controllerService.listWorkers(this.parseListWorkersQuery(url)));
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

    if (method === "POST" && /^\/api\/workers\/[^/]+\/heartbeat$/.test(url.pathname)) {
      const workerId = this.getPathParam(url.pathname, 3);
      const body = await readJsonBody<WorkerHeartbeatInput>(request);
      const worker = await this.controllerService.heartbeatWorker(workerId, body);
      sendJson(response, 200, worker);
      return;
    }

    if (method === "POST" && /^\/api\/workers\/[^/]+\/sync$/.test(url.pathname)) {
      const workerId = this.getPathParam(url.pathname, 3);
      const body = await readJsonBody<SyncWorkerBranchInput>(request);
      const result = await this.controllerService.syncWorkerBranch(workerId, body);
      sendJson(response, 200, result);
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
