import { AppState, EventRecord, WorkerSummary, WorkerSyncSummary } from "../domain/types.js";
import { deriveWorkerStatus, getHeartbeatAgeMs, isWorkerStale } from "../domain/workerStatus.js";

interface WorkerBoardMetrics {
  changedFileCount?: number;
  hasChanges?: boolean;
}

function isWorkerSyncSummary(value: unknown): value is WorkerSyncSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<WorkerSyncSummary>;
  return (
    typeof record.workerId === "string" &&
    typeof record.targetBranch === "string" &&
    typeof record.status === "string" &&
    typeof record.summary === "string"
  );
}

function getLastSyncEvent(events: EventRecord[], workerId: string): EventRecord | undefined {
  return [...events]
    .reverse()
    .find(
      (entry) =>
        entry.entityType === "worker" &&
        entry.entityId === workerId &&
        (entry.type === "BranchSynced" || entry.type === "BranchSyncFailed"),
    );
}

export function buildWorkerSummaries(
  state: AppState,
  metricsByWorkerId: Record<string, WorkerBoardMetrics> = {},
): WorkerSummary[] {
  const now = Date.now();

  return state.workers.map((worker) => {
    const task = worker.assignedTaskId
      ? state.tasks.find((entry) => entry.id === worker.assignedTaskId)
      : undefined;
    const lastEvent = [...state.events]
      .reverse()
      .find((entry) => entry.entityType === "worker" && entry.entityId === worker.id);
    const lastSyncEvent = getLastSyncEvent(state.events, worker.id);
    const lastSyncSummary =
      lastSyncEvent && isWorkerSyncSummary(lastSyncEvent.payload)
        ? {
            lastSyncAt: lastSyncEvent.ts,
            lastSyncStatus: lastSyncEvent.payload.status,
            lastSyncTargetBranch: lastSyncEvent.payload.targetBranch,
            lastSyncSummary: lastSyncEvent.payload.summary,
          }
        : undefined;
    const metrics = metricsByWorkerId[worker.id];
    const heartbeatAgeMs = getHeartbeatAgeMs(worker.lastSeenAt, now);
    const isStale = isWorkerStale(worker.lastSeenAt, now);

    return {
      workerId: worker.id,
      workerName: worker.name,
      status: deriveWorkerStatus(worker.status, worker.lastSeenAt, now),
      branch: worker.assignedBranch,
      worktreePath: worker.worktreePath,
      lastSeenAt: worker.lastSeenAt,
      heartbeatAgeMs,
      isStale,
      ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
      ...(worker.processId !== undefined ? { processId: worker.processId } : {}),
      ...(lastEvent ? { lastEventType: lastEvent.type, lastEventAt: lastEvent.ts } : {}),
      ...(metrics?.changedFileCount !== undefined
        ? {
            changedFileCount: metrics.changedFileCount,
            hasChanges: metrics.hasChanges ?? metrics.changedFileCount > 0,
          }
        : {}),
      ...(lastSyncSummary ?? {}),
    };
  });
}