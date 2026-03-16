import { WorkerStatus } from "./types.js";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function getHeartbeatAgeMs(lastSeenAt: string, now = Date.now()): number {
  return Math.max(0, now - parseTimestamp(lastSeenAt));
}

export function getHeartbeatTimeoutMs(): number {
  const configured = Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS ?? DEFAULT_HEARTBEAT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HEARTBEAT_TIMEOUT_MS;
}

export function isWorkerStale(lastSeenAt: string, now = Date.now()): boolean {
  return getHeartbeatAgeMs(lastSeenAt, now) > getHeartbeatTimeoutMs();
}

export function deriveWorkerStatus(
  status: WorkerStatus,
  lastSeenAt: string,
  now = Date.now(),
): WorkerStatus {
  if (status === "offline") {
    return "offline";
  }

  return isWorkerStale(lastSeenAt, now) ? "offline" : status;
}
