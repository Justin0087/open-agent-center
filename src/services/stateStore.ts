import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AppState,
  Artifact,
  AssignTaskInput,
  CreateTaskInput,
  CreateWorkerInput,
  EventRecord,
  Project,
  ReportedWorkerStatus,
  RegisterProjectInput,
  Run,
  Task,
  Worker,
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

  async initialize(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });

    try {
      const raw = await readFile(STATE_FILE, "utf8");
      this.state = JSON.parse(raw) as AppState;
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
    const worker: Worker = {
      id: createId(),
      name: input.name,
      status: "idle",
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
    const task: Task = {
      id: createId(),
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
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

  async markWorkerLaunched(workerId: string, processId?: number): Promise<Worker> {
    const worker = this.state.workers.find((entry) => entry.id === workerId);

    if (!worker) {
      throw new Error(`Worker ${workerId} not found.`);
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
    const artifact: Artifact = {
      id: createId(),
      taskId,
      type,
      pathOrText,
      createdAt: nowIso(),
    };

    this.state.artifacts.push(artifact);
    this.appendEvent({
      type: type === "diff" ? "DiffSummarized" : "WorkerProducedChanges",
      entityType: "artifact",
      entityId: artifact.id,
      payload: artifact,
    });
    await this.persist();
    return artifact;
  }

  async recordEvent(event: Omit<EventRecord, "id" | "ts">): Promise<void> {
    this.appendEvent(event);
    await this.persist();
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
