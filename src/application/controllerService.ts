import {
  AssignTaskInput,
  CreateProjectWorktreeInput,
  CreateTaskInput,
  CreateWorkerInput,
  Project,
  RegisterProjectInput,
  TaskDetail,
  Task,
  Worker,
  WorkerDiffSummary,
} from "../domain/types.js";
import { buildTaskDetail } from "../queries/taskQueries.js";
import { buildWorkerSummaries } from "../queries/workerQueries.js";
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

  listWorkers() {
    return buildWorkerSummaries(this.stateStore.getState());
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

  async assignTask(input: AssignTaskInput) {
    const worker = this.stateStore.getWorkerById(input.workerId);
    if (!worker) {
      throw new AppError(404, "WORKER_NOT_FOUND", `Worker ${input.workerId} not found.`);
    }

    const task = this.stateStore.getTaskById(input.taskId);
    if (!task) {
      throw new AppError(404, "TASK_NOT_FOUND", `Task ${input.taskId} not found.`);
    }

    if (worker.assignedTaskId && worker.assignedTaskId !== input.taskId) {
      throw new AppError(409, "WORKER_BUSY", `Worker ${worker.id} already has an active task.`);
    }

    return this.stateStore.assignTask(input);
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
}