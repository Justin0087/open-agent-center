import { AppState, WorkerSummary } from "../domain/types.js";

export function buildWorkerSummaries(state: AppState): WorkerSummary[] {
  return state.workers.map((worker) => {
    const task = worker.assignedTaskId
      ? state.tasks.find((entry) => entry.id === worker.assignedTaskId)
      : undefined;
    const lastEvent = [...state.events]
      .reverse()
      .find((entry) => entry.entityType === "worker" && entry.entityId === worker.id);

    return {
      workerId: worker.id,
      workerName: worker.name,
      status: worker.status,
      branch: worker.assignedBranch,
      worktreePath: worker.worktreePath,
      lastSeenAt: worker.lastSeenAt,
      ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
      ...(worker.processId !== undefined ? { processId: worker.processId } : {}),
      ...(lastEvent ? { lastEventType: lastEvent.type, lastEventAt: lastEvent.ts } : {}),
    };
  });
}