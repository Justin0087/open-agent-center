export type WorkerStatus = "idle" | "active" | "blocked" | "offline" | "archived";
export type ReportedWorkerStatus = Exclude<WorkerStatus, "offline" | "archived">;
export type TaskStatus = "queued" | "in_progress" | "review" | "done" | "blocked" | "canceled";
export type RunResult = "success" | "needs_review" | "failed";
export type EventType =
  | "ProjectRegistered"
  | "ProjectArchived"
  | "ProjectArchiveBlocked"
  | "TaskCreated"
  | "TaskUpdated"
  | "TaskMovedToReview"
  | "TaskChangesRequested"
  | "TaskIntegrationBlocked"
  | "TaskIntegrationConflicted"
  | "WorkerCreated"
  | "WorkerArchived"
  | "WorkerCleanupRequested"
  | "WorkerCleanupCompleted"
  | "WorkerCleanupBlocked"
  | "WorkerLaunched"
  | "WorkerLaunchFailed"
  | "WorkerHeartbeat"
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
  archivedAt?: string;
}

export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus;
  projectId?: string;
  worktreePath: string;
  assignedBranch: string;
  assignedTaskId?: string;
  processId?: number;
  lastSeenAt: string;
  createdAt: string;
  archivedAt?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  projectId?: string;
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

export interface ProjectArchiveSummary {
  projectId: string;
  projectName: string;
  generatedAt: string;
  status: "archived" | "blocked";
  blockingWorkerIds: string[];
  blockingTaskIds: string[];
  summary: string;
}

export interface ArchiveProjectResult {
  project: Project;
  archive: ProjectArchiveSummary;
}

export interface CreateWorkerInput {
  name: string;
  projectId?: string;
  worktreePath: string;
  assignedBranch: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  projectId?: string;
  priority?: Priority;
  targetPaths?: string[];
  acceptanceChecks?: string[];
}

export interface WorkerHeartbeatInput {
  status?: ReportedWorkerStatus;
}

export interface ListWorkersInput {
  status?: WorkerStatus;
  hasChanges?: boolean;
  isStale?: boolean;
  taskId?: string;
  branch?: string;
  lastSyncStatus?: "synced" | "conflicted";
  includeDiff?: boolean;
  sortBy?: "name" | "status" | "lastSeenAt" | "heartbeatAgeMs" | "changedFileCount";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ListWorkersResult {
  items: WorkerSummary[];
  includesDiffMetrics: boolean;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    count: number;
    hasMore: boolean;
  };
}

export interface AssignTaskInput {
  taskId: string;
  workerId: string;
}

export interface CleanupWorkerInput {
  removeWorktree?: boolean;
  deleteBranch?: boolean;
}

export interface WorkerCleanupSummary {
  workerId: string;
  workerName: string;
  branch: string;
  worktreePath: string;
  repoPath?: string;
  generatedAt: string;
  status: "completed" | "blocked";
  removedWorktree: boolean;
  deletedBranch: boolean;
  summary: string;
}

export interface CleanupWorkerResult {
  worker: Worker;
  cleanup: WorkerCleanupSummary;
}

export type TaskTransitionAction = "unassign" | "block" | "review" | "complete" | "cancel";

export interface TaskTransitionInput {
  action: TaskTransitionAction;
  notes?: string;
  result?: RunResult;
}

export interface TaskTransitionResult {
  action: TaskTransitionAction;
  task: Task;
  worker?: Worker;
  run?: Run;
}

export type TaskReviewAction = "approve" | "request_changes" | "integrate";

export interface TaskIntegrationSummary {
  workerId: string;
  workerName: string;
  sourceBranch: string;
  targetBranch: string;
  repoPath: string;
  generatedAt: string;
  status: "integrated" | "conflicted" | "blocked";
  headSha: string;
  hasLocalChanges: boolean;
  conflicts: string[];
  summary: string;
}

export interface TaskReviewInput {
  action: TaskReviewAction;
  notes?: string;
}

export interface TaskReviewResult {
  action: TaskReviewAction;
  task: Task;
  artifact?: Artifact;
  integration?: TaskIntegrationSummary;
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
  projectId?: string;
  projectName?: string;
  taskId?: string;
  taskTitle?: string;
  branch: string;
  worktreePath: string;
  processId?: number;
  lastSeenAt: string;
  heartbeatAgeMs: number;
  isStale: boolean;
  lastEventType?: EventType;
  lastEventAt?: string;
  changedFileCount?: number;
  hasChanges?: boolean;
  lastSyncAt?: string;
  lastSyncStatus?: "synced" | "conflicted";
  lastSyncTargetBranch?: string;
  lastSyncSummary?: string;
  archivedAt?: string;
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
  projectId?: string;
  branch: string;
  worktreePath: string;
  lastSeenAt: string;
  heartbeatAgeMs: number;
  isStale: boolean;
  processId?: number;
}

export interface TaskDetailSummary {
  runCount: number;
  artifactCount: number;
  eventCount: number;
  hasActiveRun: boolean;
  reviewState?: "pending" | "approved" | "blocked" | "conflicted";
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

export interface SyncWorkerBranchInput {
  targetBranch?: string;
}

export interface WorkerSyncSummary {
  workerId: string;
  workerName: string;
  branch: string;
  targetBranch: string;
  generatedAt: string;
  status: "synced" | "conflicted";
  headSha: string;
  hasLocalChanges: boolean;
  conflicts: string[];
  summary: string;
}
