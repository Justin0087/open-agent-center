import {
  AssignTaskInput,
  CreateProjectWorktreeInput,
  CreateTaskInput,
  CreateWorkerInput,
  ListWorkersInput,
  ListWorkersResult,
  Project,
  ReportedWorkerStatus,
  RegisterProjectInput,
  SyncWorkerBranchInput,
  TaskDetail,
  TaskReviewInput,
  Task,
  TaskTransitionInput,
  Worker,
  WorkerHeartbeatInput,
  WorkerDiffSummary,
  WorkerSyncSummary,
} from "../domain/types.js";
import { buildWorkerSummaries } from "../queries/workerQueries.js";
import { buildTaskDetail } from "../queries/taskQueries.js";
import { DiffService } from "../services/diffService.js";
import { StateStore } from "../services/stateStore.js";
import { WindowManager } from "../services/windowManager.js";
import { WorktreeManager } from "../services/worktreeManager.js";
import { AppError } from "./appError.js";

export class ControllerService {
  constructor(
    private readonly stateStore: StateStore,
    private readonly windowManager: WindowManager,
    private readonly worktreeManager: WorktreeManager,
    private readonly diffService: DiffService,
  ) {}

  getState() {
    return this.stateStore.getState();
  }

  listProjects(): Project[] {
    return this.stateStore.listProjects();
  }

  async listWorkers(input: ListWorkersInput = {}): Promise<ListWorkersResult> {
    const state = this.stateStore.getState();
    const includesDiffMetrics =
      input.includeDiff !== false || input.hasChanges !== undefined || input.sortBy === "changedFileCount";

    const metricsEntries = includesDiffMetrics
      ? await Promise.all(
          state.workers.map(async (worker) => {
            try {
              const diff = await this.diffService.getWorkerDiff(worker);
              return [
                worker.id,
                {
                  changedFileCount: diff.totals.filesChanged,
                  hasChanges: diff.hasChanges,
                },
              ] as const;
            } catch {
              return [worker.id, {}] as const;
            }
          }),
        )
      : [];

    const summaries = buildWorkerSummaries(state, Object.fromEntries(metricsEntries));

    const filtered = summaries.filter((worker) => {
      if (input.status && worker.status !== input.status) {
        return false;
      }

      if (input.hasChanges !== undefined && worker.hasChanges !== input.hasChanges) {
        return false;
      }

      if (input.isStale !== undefined && worker.isStale !== input.isStale) {
        return false;
      }

      if (input.taskId && worker.taskId !== input.taskId) {
        return false;
      }

      if (input.branch && worker.branch !== input.branch) {
        return false;
      }

      if (input.lastSyncStatus && worker.lastSyncStatus !== input.lastSyncStatus) {
        return false;
      }

      return true;
    });

    const sortBy = input.sortBy ?? "lastSeenAt";
    const sortOrder = input.sortOrder ?? "desc";
    const direction = sortOrder === "asc" ? 1 : -1;

    filtered.sort((left, right) => {
      switch (sortBy) {
        case "name":
          return direction * left.workerName.localeCompare(right.workerName);
        case "status":
          return direction * left.status.localeCompare(right.status);
        case "heartbeatAgeMs":
          return direction * (left.heartbeatAgeMs - right.heartbeatAgeMs);
        case "changedFileCount":
          return direction * ((left.changedFileCount ?? -1) - (right.changedFileCount ?? -1));
        case "lastSeenAt":
        default:
          return direction * left.lastSeenAt.localeCompare(right.lastSeenAt);
      }
    });

    const total = filtered.length;
    const offset = Math.max(0, input.offset ?? 0);
    const defaultLimit = total > 0 ? total : 1;
    const limit = Math.max(1, input.limit ?? defaultLimit);
    const items = filtered.slice(offset, offset + limit);

    return {
      items,
      includesDiffMetrics,
      pagination: {
        total,
        limit,
        offset,
        count: items.length,
        hasMore: offset + items.length < total,
      },
    };
  }

  listTasks(): Task[] {
    return this.stateStore.listTasks();
  }

  getTaskDetail(taskId: string): TaskDetail {
    const detail = buildTaskDetail(this.stateStore.getState(), taskId);

    if (!detail) {
      throw new AppError(404, "TASK_NOT_FOUND", `Task ${taskId} not found.`);
    }

    return detail;
  }

  async registerProject(input: RegisterProjectInput): Promise<Project> {
    if (!input.name?.trim()) {
      throw new AppError(400, "PROJECT_NAME_REQUIRED", "Project name is required.");
    }

    if (!input.repoPath?.trim()) {
      throw new AppError(400, "PROJECT_REPO_PATH_REQUIRED", "Project repoPath is required.");
    }

    return this.stateStore.registerProject(input);
  }

  async createWorker(input: CreateWorkerInput): Promise<Worker> {
    if (!input.name?.trim()) {
      throw new AppError(400, "WORKER_NAME_REQUIRED", "Worker name is required.");
    }

    if (!input.worktreePath?.trim()) {
      throw new AppError(400, "WORKTREE_PATH_REQUIRED", "Worker worktreePath is required.");
    }

    if (!input.assignedBranch?.trim()) {
      throw new AppError(400, "WORKER_BRANCH_REQUIRED", "Worker assignedBranch is required.");
    }

    return this.stateStore.createWorker(input);
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.title?.trim()) {
      throw new AppError(400, "TASK_TITLE_REQUIRED", "Task title is required.");
    }

    if (!input.description?.trim()) {
      throw new AppError(400, "TASK_DESCRIPTION_REQUIRED", "Task description is required.");
    }

    return this.stateStore.createTask(input);
  }

  async heartbeatWorker(workerId: string, input: WorkerHeartbeatInput = {}) {
    const worker = this.stateStore.getWorkerById(workerId);
    if (!worker) {
      throw new AppError(404, "WORKER_NOT_FOUND", `Worker ${workerId} not found.`);
    }

    if (input.status && !["idle", "active", "blocked"].includes(input.status)) {
      throw new AppError(400, "WORKER_STATUS_INVALID", "Heartbeat status must be idle, active, or blocked.");
    }

    const updatedWorker = await this.stateStore.recordWorkerHeartbeat(
      workerId,
      input.status as ReportedWorkerStatus | undefined,
    );

    const state = this.stateStore.getState();
    const summary = buildWorkerSummaries({
      ...state,
      workers: state.workers.map((entry) => (entry.id === updatedWorker.id ? updatedWorker : entry)),
    }).find((entry) => entry.workerId === workerId);

    if (!summary) {
      throw new AppError(500, "WORKER_HEARTBEAT_FAILED", `Worker ${workerId} could not be summarized.`);
    }

    return summary;
  }

  async assignTask(input: AssignTaskInput) {
    const worker = this.stateStore.getWorkerById(input.workerId);
    if (!worker) {
      throw new AppError(404, "WORKER_NOT_FOUND", `Worker ${input.workerId} not found.`);
    }

    const task = this.stateStore.getTaskById(input.taskId);
    if (!task) {
      throw new AppError(404, "TASK_NOT_FOUND", `Task ${input.taskId} not found.`);
    }

    if (task.assignedWorkerId && task.assignedWorkerId !== worker.id) {
      throw new AppError(409, "TASK_ALREADY_ASSIGNED", `Task ${task.id} is already assigned.`);
    }

    if (["done", "canceled", "review"].includes(task.status)) {
      throw new AppError(409, "TASK_STATUS_INVALID", `Task ${task.id} cannot be assigned from status ${task.status}.`);
    }

    if (worker.assignedTaskId && worker.assignedTaskId !== input.taskId) {
      throw new AppError(409, "WORKER_BUSY", `Worker ${worker.id} already has an active task.`);
    }

    return this.stateStore.assignTask(input);
  }

  async transitionTask(taskId: string, input: TaskTransitionInput) {
    const task = this.stateStore.getTaskById(taskId);
    if (!task) {
      throw new AppError(404, "TASK_NOT_FOUND", `Task ${taskId} not found.`);
    }

    if (!input.action || !["unassign", "block", "review", "complete", "cancel"].includes(input.action)) {
      throw new AppError(400, "TASK_TRANSITION_INVALID", "Task action must be unassign, block, review, complete, or cancel.");
    }

    if (input.result && !["success", "needs_review", "failed"].includes(input.result)) {
      throw new AppError(400, "RUN_RESULT_INVALID", "Task result must be success, needs_review, or failed.");
    }

    try {
      return await this.stateStore.transitionTask(taskId, input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Task transition failed.";
      throw new AppError(409, "TASK_TRANSITION_CONFLICT", reason);
    }
  }

  async reviewTask(taskId: string, input: TaskReviewInput) {
    const task = this.stateStore.getTaskById(taskId);
    if (!task) {
      throw new AppError(404, "TASK_NOT_FOUND", `Task ${taskId} not found.`);
    }

    if (!input.action || !["approve", "request_changes", "integrate"].includes(input.action)) {
      throw new AppError(400, "TASK_REVIEW_INVALID", "Task review action must be approve, request_changes, or integrate.");
    }

    try {
      if (input.action === "integrate") {
        const detail = this.getTaskDetail(taskId);
        const latestRun = [...detail.runs].reverse().find((run) => typeof run.workerId === "string");

        if (!latestRun) {
          throw new AppError(409, "TASK_REVIEW_CONFLICT", `Task ${taskId} has no worker run available for integration.`);
        }

        const worker = this.stateStore.getWorkerById(latestRun.workerId);
        if (!worker) {
          throw new AppError(409, "WORKER_NOT_FOUND", `Worker ${latestRun.workerId} not found for integration.`);
        }

        const project = this.resolveProjectForWorker(worker);
        const integration = await this.worktreeManager.integrate(worker, project?.defaultBranch);
        return await this.stateStore.reviewTask(taskId, input, integration);
      }

      return await this.stateStore.reviewTask(taskId, input);
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : "Task review failed.";
      throw new AppError(409, "TASK_REVIEW_CONFLICT", reason);
    }
  }

  async launchWorker(workerId: string): Promise<Worker> {
    const worker = this.stateStore.getWorkerById(workerId);
    if (!worker) {
      throw new AppError(404, "WORKER_NOT_FOUND", `Worker ${workerId} not found.`);
    }

    try {
      const launchResult = this.windowManager.launch(worker.worktreePath);
      return await this.stateStore.markWorkerLaunched(worker.id, launchResult.processId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown launch failure.";
      await this.stateStore.markWorkerLaunchFailed(worker.id, reason);
      throw new AppError(422, "WORKER_LAUNCH_FAILED", reason);
    }
  }

  async getWorkerDiff(workerId: string): Promise<WorkerDiffSummary> {
    const worker = this.stateStore.getWorkerById(workerId);
    if (!worker) {
      throw new AppError(404, "WORKER_NOT_FOUND", `Worker ${workerId} not found.`);
    }

    try {
      return await this.diffService.getWorkerDiff(worker);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Failed to inspect worker diff.";
      throw new AppError(422, "WORKER_DIFF_FAILED", reason);
    }
  }

  async syncWorkerBranch(workerId: string, input: SyncWorkerBranchInput = {}): Promise<WorkerSyncSummary> {
    const worker = this.stateStore.getWorkerById(workerId);
    if (!worker) {
      throw new AppError(404, "WORKER_NOT_FOUND", `Worker ${workerId} not found.`);
    }

    await this.stateStore.recordEvent({
      type: "BranchSyncRequested",
      entityType: "worker",
      entityId: worker.id,
      payload: {
        targetBranch: input.targetBranch,
      },
    });

    try {
      const result = await this.worktreeManager.sync(worker, input.targetBranch);
      await this.stateStore.recordEvent({
        type: result.status === "synced" ? "BranchSynced" : "BranchSyncFailed",
        entityType: "worker",
        entityId: worker.id,
        payload: result,
      });
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Failed to sync worker branch.";
      await this.stateStore.recordEvent({
        type: "BranchSyncFailed",
        entityType: "worker",
        entityId: worker.id,
        payload: {
          targetBranch: input.targetBranch,
          reason,
        },
      });
      throw new AppError(422, "WORKER_SYNC_FAILED", reason);
    }
  }

  async createProjectWorktree(projectId: string, input: CreateProjectWorktreeInput) {
    const project = this.stateStore.getProjectById(projectId);
    if (!project) {
      throw new AppError(404, "PROJECT_NOT_FOUND", `Project ${projectId} not found.`);
    }

    if (!input.workerName?.trim()) {
      throw new AppError(400, "WORKER_NAME_REQUIRED", "workerName is required.");
    }

    const worktree = await this.worktreeManager.create(project, input.workerName, input.branchBase);
    const worker = await this.stateStore.createWorker({
      name: input.workerName,
      worktreePath: worktree.worktreePath,
      assignedBranch: worktree.branchName,
    });

    let assignment: Awaited<ReturnType<StateStore["assignTask"]>> | undefined;
    if (input.taskId) {
      assignment = await this.assignTask({ taskId: input.taskId, workerId: worker.id });
    }

    return {
      project,
      worker: assignment?.worker ?? worker,
      task: assignment?.task,
      run: assignment?.run,
      worktree,
    };
  }

  private resolveProjectForWorker(worker: Worker): Project | undefined {
    const projects = this.stateStore.listProjects();
    return projects.find((project) => {
      const worktreeRoot = `${project.repoPath}.worktrees`;
      return worker.worktreePath === project.repoPath || worker.worktreePath.startsWith(`${worktreeRoot}${requirePathSeparator(worktreeRoot)}`) || worker.worktreePath.startsWith(worktreeRoot);
    });
  }
}

function requirePathSeparator(value: string): string {
  return value.endsWith("\\") || value.endsWith("/") ? "" : "\\";
}