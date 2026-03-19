import {
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
  RegisterProjectInput,
  Task,
  TaskIntegrationSummary,
  TaskReviewInput,
  TaskReviewResult,
  TaskTransitionInput,
  TaskTransitionResult,
  Worker,
  WorkerCleanupSummary,
  ReportedWorkerStatus,
} from "../domain/types.js";

export interface StateRepository {
  initialize(): Promise<void>;
  getState(): AppState;
  listProjects(): Project[];
  listWorkers(): Worker[];
  listTasks(): Task[];
  getProjectById(projectId: string): Project | undefined;
  getWorkerById(workerId: string): Worker | undefined;
  getTaskById(taskId: string): Task | undefined;
  registerProject(input: RegisterProjectInput): Promise<Project>;
  createWorker(input: CreateWorkerInput): Promise<Worker>;
  createTask(input: CreateTaskInput): Promise<Task>;
  assignTask(input: AssignTaskInput): Promise<{ task: Task; worker: Worker; run: AppState["runs"][number] }>;
  transitionTask(taskId: string, input: TaskTransitionInput): Promise<TaskTransitionResult>;
  reviewTask(taskId: string, input: TaskReviewInput, integration?: TaskIntegrationSummary): Promise<TaskReviewResult>;
  markWorkerLaunched(workerId: string, processId?: number): Promise<Worker>;
  markWorkerLaunchFailed(workerId: string, reason: string): Promise<void>;
  recordWorkerHeartbeat(workerId: string, status?: ReportedWorkerStatus): Promise<Worker>;
  addArtifact(taskId: string, type: Artifact["type"], pathOrText: string): Promise<Artifact>;
  recordEvent(event: Omit<EventRecord, "id" | "ts">): Promise<void>;
  archiveWorker(workerId: string, cleanup: WorkerCleanupSummary): Promise<CleanupWorkerResult>;
  archiveProject(projectId: string, archive: ProjectArchiveSummary): Promise<ArchiveProjectResult>;
}