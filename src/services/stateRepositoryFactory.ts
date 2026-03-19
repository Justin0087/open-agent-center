import { StateRepository } from "./stateRepository.js";
import { SQLiteStateRepository } from "./sqliteStateRepository.js";
import { StateStore } from "./stateStore.js";

export type StateRepositoryKind = "json" | "sqlite";

export function resolveStateRepositoryKind(value = process.env.OPEN_AGENT_CENTER_STORAGE): StateRepositoryKind {
  return value?.trim().toLowerCase() === "sqlite" ? "sqlite" : "json";
}

export function createStateRepository(kind = resolveStateRepositoryKind()): StateRepository {
  if (kind === "sqlite") {
    return new SQLiteStateRepository();
  }

  return new StateStore();
}