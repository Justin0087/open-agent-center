export type WorkerStatus = "idle" | "active" | "blocked" | "offline";
export type TaskStatus = "queued" | "in_progress" | "review" | "done" | "blocked" | "canceled";
export type RunResult = "success" | "needs_review" | "failed";
export type EventType =
  | "ProjectRegistered"
  | "TaskCreated"
  | "TaskUpdated"
  | "WorkerCreated"
  | "WorkerLaunched"
  | "WorkerLaunchFailed"
  | "TaskAssigned"
  | "TaskUnassigned"
  | "WorkStarted"
  | "WorkerProducedChanges"
  | "DiffSummarized"
  | "TaskBlocked"
  | "BranchSyncRequested"
  | "BranchSynced"
  | "BranchSyncFailed"
  | "TaskApproved"
  | "TaskIntegrated"
  | "TaskCompleted"
  | "TaskCanceled";

export type Priority = "low" | "medium" | "high";

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus;
  worktreePath: string;
  assignedBranch: string;
  assignedTaskId?: string;
  processId?: number;
  lastSeenAt: string;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: TaskStatus;
  targetPaths: string[];
  acceptanceChecks: string[];
  assignedWorkerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  workerId: string;
  startAt: string;
  endAt?: string;
  result?: RunResult;
  notes?: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  type: "diff" | "patch" | "test_report" | "note";
  pathOrText: string;
  createdAt: string;
}

export interface EventRecord {
  id: string;
  ts: string;
  type: EventType;
  entityType: "project" | "task" | "worker" | "run" | "artifact";
  entityId: string;
  payload: unknown;
}

export interface AppState {
  projects: Project[];
  workers: Worker[];
  tasks: Task[];
  runs: Run[];
  artifacts: Artifact[];
  events: EventRecord[];
}

export interface RegisterProjectInput {
  name: string;
  repoPath: string;
  defaultBranch?: string;
}

export interface CreateWorkerInput {
  name: string;
  worktreePath: string;
  assignedBranch: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  priority?: Priority;
  targetPaths?: string[];
  acceptanceChecks?: string[];
}

export interface AssignTaskInput {
  taskId: string;
  workerId: string;
}

export interface CreateProjectWorktreeInput {
  workerName: string;
  branchBase?: string;
  taskId?: string;
}

export interface WorktreeDefinition {
  worktreePath: string;
  branchName: string;
  rootPath: string;
}

export interface WorkerSummary {
  workerId: string;
  workerName: string;
  status: WorkerStatus;
  taskId?: string;
  taskTitle?: string;
  branch: string;
  worktreePath: string;
  processId?: number;
  lastSeenAt: string;
  lastEventType?: EventType;
  lastEventAt?: string;
}

export interface WorkerDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface WorkerDiffSummary {
  workerId: string;
  workerName: string;
  branch: string;
  worktreePath: string;
  generatedAt: string;
  hasChanges: boolean;
  totals: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
  files: WorkerDiffFile[];
  summary: string;
}

export interface TaskAssignedWorkerSummary {
  workerId: string;
  workerName: string;
  status: WorkerStatus;
  branch: string;
  worktreePath: string;
  lastSeenAt: string;
  processId?: number;
}

export interface TaskDetailSummary {
  runCount: number;
  artifactCount: number;
  eventCount: number;
  hasActiveRun: boolean;
  lastEventAt?: string;
  lastEventType?: EventType;
}

export interface TaskDetail {
  task: Task;
  assignedWorker?: TaskAssignedWorkerSummary;
  runs: Run[];
  artifacts: Artifact[];
  events: EventRecord[];
  summary: TaskDetailSummary;
}
