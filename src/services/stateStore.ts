import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentRuntimeKind,
  AppState,
  ArchiveProjectResult,
  Artifact,
  AssignTaskInput,
  CleanupWorkerResult,
  CreateTaskInput,
  CreateWorkerInput,
  EventRecord,
  Project,
  ProjectArchiveSummary,
  DEFAULT_AGENT_RUNTIME_KIND,
  ReportedWorkerStatus,
  RegisterProjectInput,
  Run,
  Task,
  TaskIntegrationSummary,
  TaskReviewInput,
  TaskReviewResult,
  TaskTransitionInput,
  TaskTransitionResult,
  Worker,
  WorkerCleanupSummary,
} from "../domain/types.js";
import { createId, nowIso } from "../utils/ids.js";

const DATA_DIR = path.resolve(process.cwd(), ".data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const EMPTY_STATE: AppState = {
  projects: [],
  workers: [],
  tasks: [],
  runs: [],
  artifacts: [],
  events: [],
};

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class StateStore {
  private state: AppState = cloneState(EMPTY_STATE);

  private normalizeState(): boolean {
    let changed = false;

    this.state.workers = this.state.workers.map((worker) => {
      if (worker.runtimeKind) {
        return worker;
      }

      changed = true;
      return {
        ...worker,
        runtimeKind: DEFAULT_AGENT_RUNTIME_KIND,
      };
    });

    return changed;
  }

  private getProjectRecord(projectId: string): Project | undefined {
    return this.state.projects.find((entry) => entry.id === projectId);
  }

  private ensureProjectAcceptsChanges(projectId: string | undefined): void {
    if (!projectId) {
      return;
    }

    const project = this.getProjectRecord(projectId);
    if (project?.archivedAt) {
      throw new Error(`Project ${project.id} is archived and cannot accept new work.`);
    }
  }

  private getActiveRunForTask(taskId: string): Run | undefined {
    return [...this.state.runs]
      .reverse()
      .find((entry) => entry.taskId === taskId && !entry.endAt);
  }

  private releaseWorker(worker: Worker, timestamp: string): void {
    delete worker.assignedTaskId;
    worker.status = "idle";
    worker.lastSeenAt = timestamp;
  }

  private closeRun(run: Run | undefined, timestamp: string, result?: Run["result"], notes?: string): Run | undefined {
    if (!run) {
      return undefined;
    }

    run.endAt = timestamp;
    if (result) {
      run.result = result;
    }
    if (notes?.trim()) {
      run.notes = notes.trim();
    }

    return run;
  }

  private appendArtifactRecord(taskId: string, type: Artifact["type"], pathOrText: string, createdAt = nowIso()): Artifact {
    const artifact: Artifact = {
      id: createId(),
      taskId,
      type,
      pathOrText,
      createdAt,
    };

    this.state.artifacts.push(artifact);
    this.appendEvent({
      type: type === "diff" ? "DiffSummarized" : "WorkerProducedChanges",
      entityType: "artifact",
      entityId: artifact.id,
      payload: artifact,
    });

    return artifact;
  }

  async initialize(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });

    try {
      const raw = await readFile(STATE_FILE, "utf8");
      this.state = JSON.parse(raw) as AppState;
      if (this.normalizeState()) {
        await this.persist();
      }
    } catch {
      await this.persist();
    }
  }

  getState(): AppState {
    return cloneState(this.state);
  }

  listProjects(): Project[] {
    return cloneState(this.state.projects);
  }

  listWorkers(): Worker[] {
    return cloneState(this.state.workers);
  }

  listTasks(): Task[] {
    return cloneState(this.state.tasks);
  }

  getProjectById(projectId: string): Project | undefined {
    const project = this.state.projects.find((entry) => entry.id === projectId);
    return project ? cloneState(project) : undefined;
  }

  getWorkerById(workerId: string): Worker | undefined {
    const worker = this.state.workers.find((entry) => entry.id === workerId);
    return worker ? cloneState(worker) : undefined;
  }

  getTaskById(taskId: string): Task | undefined {
    const task = this.state.tasks.find((entry) => entry.id === taskId);
    return task ? cloneState(task) : undefined;
  }

  async registerProject(input: RegisterProjectInput): Promise<Project> {
    const project: Project = {
      id: createId(),
      name: input.name,
      repoPath: input.repoPath,
      defaultBranch: input.defaultBranch ?? "main",
      createdAt: nowIso(),
    };

    this.state.projects.push(project);
    this.appendEvent({
      type: "ProjectRegistered",
      entityType: "project",
      entityId: project.id,
      payload: project,
    });
    await this.persist();
    return project;
  }

  async createWorker(input: CreateWorkerInput): Promise<Worker> {
    this.ensureProjectAcceptsChanges(input.projectId);

    const worker: Worker = {
      id: createId(),
      name: input.name,
      runtimeKind: normalizeRuntimeKind(input.runtimeKind),
      status: "idle",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      worktreePath: input.worktreePath,
      assignedBranch: input.assignedBranch,
      lastSeenAt: nowIso(),
      createdAt: nowIso(),
    };

    this.state.workers.push(worker);
    this.appendEvent({
      type: "WorkerCreated",
      entityType: "worker",
      entityId: worker.id,
      payload: worker,
    });
    await this.persist();
    return worker;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    this.ensureProjectAcceptsChanges(input.projectId);

    const task: Task = {
      id: createId(),
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
      ...(input.projectId ? { projectId: input.projectId } : {}),
      status: "queued",
      targetPaths: input.targetPaths ?? [],
      acceptanceChecks: input.acceptanceChecks ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.state.tasks.push(task);
    this.appendEvent({
      type: "TaskCreated",
      entityType: "task",
      entityId: task.id,
      payload: task,
    });
    await this.persist();
    return task;
  }

  async assignTask(input: AssignTaskInput): Promise<{ task: Task; worker: Worker; run: Run }> {
    const task = this.state.tasks.find((entry) => entry.id === input.taskId);
    const worker = this.state.workers.find((entry) => entry.id === input.workerId);

    if (!task) {
      throw new Error(`Task ${input.taskId} not found.`);
    }

    if (!worker) {
      throw new Error(`Worker ${input.workerId} not found.`);
    }

    if (worker.status === "archived") {
      throw new Error(`Worker ${worker.id} is archived and cannot accept new assignments.`);
    }

    if (task.assignedWorkerId && task.assignedWorkerId !== worker.id) {
      throw new Error(`Task ${task.id} is already assigned to another worker.`);
    }

    if (worker.assignedTaskId && worker.assignedTaskId !== task.id) {
      throw new Error(`Worker ${worker.id} already has an active task.`);
    }

    if (task.projectId || worker.projectId) {
      if (!task.projectId || !worker.projectId || task.projectId !== worker.projectId) {
        throw new Error(`Task ${task.id} and worker ${worker.id} must belong to the same project before assignment.`);
      }
    }

    if (["done", "canceled", "review"].includes(task.status)) {
      throw new Error(`Task ${task.id} cannot be assigned while in status ${task.status}.`);
    }

    if (task.status === "in_progress" && task.assignedWorkerId === worker.id) {
      throw new Error(`Task ${task.id} is already in progress on worker ${worker.id}.`);
    }

    task.assignedWorkerId = worker.id;
    task.status = "in_progress";
    task.updatedAt = nowIso();

    worker.assignedTaskId = task.id;
    worker.status = "active";
    worker.lastSeenAt = nowIso();

    const run: Run = {
      id: createId(),
      taskId: task.id,
      workerId: worker.id,
      startAt: nowIso(),
    };

    this.state.runs.push(run);
    this.appendEvent({
      type: "TaskAssigned",
      entityType: "task",
      entityId: task.id,
      payload: { taskId: task.id, workerId: worker.id, runId: run.id },
    });
    this.appendEvent({
      type: "WorkStarted",
      entityType: "run",
      entityId: run.id,
      payload: run,
    });

    await this.persist();
    return { task: cloneState(task), worker: cloneState(worker), run: cloneState(run) };
  }

  async transitionTask(taskId: string, input: TaskTransitionInput): Promise<TaskTransitionResult> {
    const task = this.state.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    const timestamp = nowIso();
    const assignedWorker = task.assignedWorkerId
      ? this.state.workers.find((entry) => entry.id === task.assignedWorkerId)
      : undefined;
    const activeRun = this.getActiveRunForTask(task.id);
    let eventType: EventRecord["type"];
    let workerResult: Worker | undefined;
    let runResult: Run | undefined;

    switch (input.action) {
      case "unassign": {
        if (!assignedWorker) {
          throw new Error(`Task ${task.id} is not currently assigned.`);
        }

        task.status = "queued";
        delete task.assignedWorkerId;
        task.updatedAt = timestamp;
        this.releaseWorker(assignedWorker, timestamp);
        runResult = this.closeRun(activeRun, timestamp, input.result ?? "failed", input.notes);
        eventType = "TaskUnassigned";
        workerResult = assignedWorker;
        break;
      }
      case "block": {
        if (["done", "canceled", "review"].includes(task.status)) {
          throw new Error(`Task ${task.id} cannot be blocked from status ${task.status}.`);
        }

        task.status = "blocked";
        task.updatedAt = timestamp;
        if (assignedWorker) {
          delete task.assignedWorkerId;
          this.releaseWorker(assignedWorker, timestamp);
          runResult = this.closeRun(activeRun, timestamp, input.result ?? "failed", input.notes);
          workerResult = assignedWorker;
        }
        eventType = "TaskBlocked";
        break;
      }
      case "review": {
        if (!assignedWorker) {
          throw new Error(`Task ${task.id} must be assigned before it can move to review.`);
        }

        task.status = "review";
        delete task.assignedWorkerId;
        task.updatedAt = timestamp;
        this.releaseWorker(assignedWorker, timestamp);
        runResult = this.closeRun(activeRun, timestamp, input.result ?? "needs_review", input.notes);
        eventType = "TaskMovedToReview";
        workerResult = assignedWorker;
        break;
      }
      case "complete": {
        if (!["in_progress", "review"].includes(task.status)) {
          throw new Error(`Task ${task.id} can only complete from in_progress or review.`);
        }

        task.status = "done";
        task.updatedAt = timestamp;
        if (assignedWorker) {
          delete task.assignedWorkerId;
          this.releaseWorker(assignedWorker, timestamp);
          workerResult = assignedWorker;
        }
        runResult = this.closeRun(activeRun, timestamp, input.result ?? "success", input.notes);
        eventType = "TaskCompleted";
        break;
      }
      case "cancel": {
        if (["done", "canceled"].includes(task.status)) {
          throw new Error(`Task ${task.id} cannot be canceled from status ${task.status}.`);
        }

        task.status = "canceled";
        task.updatedAt = timestamp;
        if (assignedWorker) {
          delete task.assignedWorkerId;
          this.releaseWorker(assignedWorker, timestamp);
          workerResult = assignedWorker;
        }
        runResult = this.closeRun(activeRun, timestamp, input.result ?? "failed", input.notes);
        eventType = "TaskCanceled";
        break;
      }
      default:
        throw new Error(`Unsupported task transition: ${input.action}.`);
    }

    this.appendEvent({
      type: eventType,
      entityType: "task",
      entityId: task.id,
      payload: {
        action: input.action,
        ...(workerResult ? { workerId: workerResult.id } : {}),
        ...(runResult ? { runId: runResult.id, result: runResult.result } : {}),
        ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      },
    });

    await this.persist();
    return {
      action: input.action,
      task: cloneState(task),
      ...(workerResult ? { worker: cloneState(workerResult) } : {}),
      ...(runResult ? { run: cloneState(runResult) } : {}),
    };
  }

  async reviewTask(taskId: string, input: TaskReviewInput, integration?: TaskIntegrationSummary): Promise<TaskReviewResult> {
    const task = this.state.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found.`);
    }

    if (task.status !== "review") {
      throw new Error(`Task ${task.id} must be in review before review actions can be applied.`);
    }

    const timestamp = nowIso();
    let eventType: EventRecord["type"];

    switch (input.action) {
      case "approve": {
        task.updatedAt = timestamp;
        eventType = "TaskApproved";
        break;
      }
      case "request_changes": {
        task.status = "queued";
        task.updatedAt = timestamp;
        eventType = "TaskChangesRequested";
        break;
      }
      case "integrate": {
        if (!integration) {
          throw new Error(`Task ${task.id} integration result is required.`);
        }

        task.updatedAt = timestamp;
        if (integration.status === "integrated") {
          task.status = "done";
          eventType = "TaskIntegrated";
        } else if (integration.status === "conflicted") {
          eventType = "TaskIntegrationConflicted";
        } else {
          eventType = "TaskIntegrationBlocked";
        }
        break;
      }
      default:
        throw new Error(`Unsupported task review action: ${input.action}.`);
    }

    const artifact = input.notes?.trim()
      ? this.appendArtifactRecord(task.id, "note", input.notes.trim(), timestamp)
      : undefined;

    this.appendEvent({
      type: eventType,
      entityType: "task",
      entityId: task.id,
      payload: {
        action: input.action,
        ...(artifact ? { artifactId: artifact.id } : {}),
        ...(integration ? { integration } : {}),
      },
    });

    await this.persist();
    return {
      action: input.action,
      task: cloneState(task),
      ...(artifact ? { artifact: cloneState(artifact) } : {}),
      ...(integration ? { integration: cloneState(integration) } : {}),
    };
  }

  async markWorkerLaunched(workerId: string, processId?: number): Promise<Worker> {
    const worker = this.state.workers.find((entry) => entry.id === workerId);

    if (!worker) {
      throw new Error(`Worker ${workerId} not found.`);
    }

    if (worker.status === "archived") {
      throw new Error(`Worker ${workerId} is archived and cannot accept heartbeats.`);
    }

    if (processId !== undefined) {
      worker.processId = processId;
    } else {
      delete worker.processId;
    }
    worker.lastSeenAt = nowIso();

    this.appendEvent({
      type: "WorkerLaunched",
      entityType: "worker",
      entityId: worker.id,
      payload: { processId },
    });
    await this.persist();
    return cloneState(worker);
  }

  async markWorkerLaunchFailed(workerId: string, reason: string): Promise<void> {
    const worker = this.state.workers.find((entry) => entry.id === workerId);

    if (!worker) {
      throw new Error(`Worker ${workerId} not found.`);
    }

    worker.status = "offline";
    worker.lastSeenAt = nowIso();

    this.appendEvent({
      type: "WorkerLaunchFailed",
      entityType: "worker",
      entityId: worker.id,
      payload: { reason },
    });
    await this.persist();
  }

  async recordWorkerHeartbeat(workerId: string, status?: ReportedWorkerStatus): Promise<Worker> {
    const worker = this.state.workers.find((entry) => entry.id === workerId);

    if (!worker) {
      throw new Error(`Worker ${workerId} not found.`);
    }

    if (status) {
      worker.status = status;
    }
    worker.lastSeenAt = nowIso();

    this.appendEvent({
      type: "WorkerHeartbeat",
      entityType: "worker",
      entityId: worker.id,
      payload: {
        ...(status ? { status } : {}),
      },
    });
    await this.persist();
    return cloneState(worker);
  }

  async addArtifact(taskId: string, type: Artifact["type"], pathOrText: string): Promise<Artifact> {
    const artifact = this.appendArtifactRecord(taskId, type, pathOrText);
    await this.persist();
    return artifact;
  }

  async recordEvent(event: Omit<EventRecord, "id" | "ts">): Promise<void> {
    this.appendEvent(event);
    await this.persist();
  }

  async archiveWorker(workerId: string, cleanup: WorkerCleanupSummary): Promise<CleanupWorkerResult> {
    const worker = this.state.workers.find((entry) => entry.id === workerId);

    if (!worker) {
      throw new Error(`Worker ${workerId} not found.`);
    }

    if (worker.status === "archived") {
      throw new Error(`Worker ${workerId} is already archived.`);
    }

    if (worker.assignedTaskId) {
      throw new Error(`Worker ${worker.id} cannot be archived while assigned to task ${worker.assignedTaskId}.`);
    }

    worker.status = "archived";
    worker.archivedAt = cleanup.generatedAt;
    worker.lastSeenAt = cleanup.generatedAt;
    delete worker.processId;

    this.appendEvent({
      type: "WorkerArchived",
      entityType: "worker",
      entityId: worker.id,
      payload: {
        archivedAt: cleanup.generatedAt,
      },
    });
    this.appendEvent({
      type: cleanup.status === "completed" ? "WorkerCleanupCompleted" : "WorkerCleanupBlocked",
      entityType: "worker",
      entityId: worker.id,
      payload: cleanup,
    });

    await this.persist();
    return {
      worker: cloneState(worker),
      cleanup: cloneState(cleanup),
    };
  }

  async archiveProject(projectId: string, archive: ProjectArchiveSummary): Promise<ArchiveProjectResult> {
    const project = this.getProjectRecord(projectId);

    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }

    if (project.archivedAt) {
      throw new Error(`Project ${project.id} is already archived.`);
    }

    project.archivedAt = archive.generatedAt;

    this.appendEvent({
      type: "ProjectArchived",
      entityType: "project",
      entityId: project.id,
      payload: archive,
    });

    await this.persist();
    return {
      project: cloneState(project),
      archive: cloneState(archive),
    };
  }

  private appendEvent(event: Omit<EventRecord, "id" | "ts">): void {
    this.state.events.push({
      id: createId(),
      ts: nowIso(),
      ...event,
    });
  }

  private async persist(): Promise<void> {
    await writeFile(STATE_FILE, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }
}

function normalizeRuntimeKind(runtimeKind: AgentRuntimeKind | undefined): AgentRuntimeKind {
  return runtimeKind ?? DEFAULT_AGENT_RUNTIME_KIND;
}
