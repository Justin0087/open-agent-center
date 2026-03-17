import { deriveWorkerStatus, getHeartbeatAgeMs, isWorkerStale } from "../domain/workerStatus.js";
import { AppState, TaskDetail } from "../domain/types.js";

function deriveReviewState(events: TaskDetail["events"]): "pending" | "approved" | undefined {
  const lastReviewEvent = [...events]
    .reverse()
    .find((entry) => ["TaskApproved", "TaskChangesRequested", "TaskIntegrated", "TaskMovedToReview"].includes(entry.type));

  if (!lastReviewEvent) {
    return undefined;
  }

  if (lastReviewEvent.type === "TaskApproved") {
    return "approved";
  }

  if (lastReviewEvent.type === "TaskMovedToReview") {
    return "pending";
  }

  return undefined;
}

export function buildTaskDetail(state: AppState, taskId: string): TaskDetail | undefined {
  const now = Date.now();
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    return undefined;
  }

  const assignedWorker = task.assignedWorkerId
    ? state.workers.find((entry) => entry.id === task.assignedWorkerId)
    : undefined;

  const runs = state.runs
    .filter((entry) => entry.taskId === task.id)
    .sort((left, right) => left.startAt.localeCompare(right.startAt));

  const artifacts = state.artifacts
    .filter((entry) => entry.taskId === task.id)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const runIds = new Set(runs.map((entry) => entry.id));
  const artifactIds = new Set(artifacts.map((entry) => entry.id));
  const events = state.events
    .filter((entry) => {
      if (entry.entityType === "task" && entry.entityId === task.id) {
        return true;
      }

      if (entry.entityType === "run" && runIds.has(entry.entityId)) {
        return true;
      }

      if (entry.entityType === "artifact" && artifactIds.has(entry.entityId)) {
        return true;
      }

      return false;
    })
    .sort((left, right) => left.ts.localeCompare(right.ts));

  const lastEvent = events.at(-1);
  const reviewState = deriveReviewState(events);

  return {
    task,
    ...(assignedWorker
      ? {
          assignedWorker: {
            workerId: assignedWorker.id,
            workerName: assignedWorker.name,
            status: deriveWorkerStatus(assignedWorker.status, assignedWorker.lastSeenAt, now),
            branch: assignedWorker.assignedBranch,
            worktreePath: assignedWorker.worktreePath,
            lastSeenAt: assignedWorker.lastSeenAt,
            heartbeatAgeMs: getHeartbeatAgeMs(assignedWorker.lastSeenAt, now),
            isStale: isWorkerStale(assignedWorker.lastSeenAt, now),
            ...(assignedWorker.processId !== undefined ? { processId: assignedWorker.processId } : {}),
          },
        }
      : {}),
    runs,
    artifacts,
    events,
    summary: {
      runCount: runs.length,
      artifactCount: artifacts.length,
      eventCount: events.length,
      hasActiveRun: runs.some((entry) => !entry.endAt),
      ...(reviewState ? { reviewState } : {}),
      ...(lastEvent ? { lastEventAt: lastEvent.ts, lastEventType: lastEvent.type } : {}),
    },
  };
}