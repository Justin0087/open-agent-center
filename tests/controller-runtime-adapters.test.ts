import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentRuntimeKind, LaunchResult, RuntimeAdapter, Worker } from "../src/domain/types.js";

type ControllerModule = typeof import("../src/application/controllerService.js");
type AppErrorModule = typeof import("../src/application/appError.js");
type StateStoreModule = typeof import("../src/services/stateStore.js");
type RegistryModule = typeof import("../src/infra/runtimeAdapterRegistry.js");

let tempCwd = "";
let originalCwd = "";
let controllerModule: ControllerModule;
let appErrorModule: AppErrorModule;
let stateStoreModule: StateStoreModule;
let registryModule: RegistryModule;

before(async () => {
  originalCwd = process.cwd();
  tempCwd = await mkdtemp(path.join(os.tmpdir(), "open-agent-center-runtime-tests-"));
  process.chdir(tempCwd);

  controllerModule = await import("../src/application/controllerService.js");
  appErrorModule = await import("../src/application/appError.js");
  stateStoreModule = await import("../src/services/stateStore.js");
  registryModule = await import("../src/infra/runtimeAdapterRegistry.js");
});

beforeEach(async () => {
  await rm(path.join(tempCwd, ".data"), { recursive: true, force: true });
});

after(async () => {
  process.chdir(originalCwd);
  await rm(tempCwd, { recursive: true, force: true });
});

async function createStateStore() {
  const store = new stateStoreModule.StateStore();
  await store.initialize();
  return store;
}

function createAdapter(kind: AgentRuntimeKind, launch: (worker: Worker) => Promise<LaunchResult>): RuntimeAdapter {
  return {
    kind,
    launch,
    getCapabilities() {
      return {
        canOpenEditor: kind === "vscode-copilot",
        supportsSnapshots: false,
      };
    },
  };
}

function createController(
  stateStore: InstanceType<StateStoreModule["StateStore"]>,
  adapters: RuntimeAdapter[],
) {
  const { ControllerService } = controllerModule;
  const registry = new registryModule.RuntimeAdapterRegistry();

  for (const adapter of adapters) {
    registry.register(adapter);
  }

  return new ControllerService(
    stateStore,
    registry,
    {} as never,
    {
      async getWorkerDiff() {
        return {
          workerId: "stub",
          workerName: "stub",
          branch: "stub",
          worktreePath: "stub",
          generatedAt: new Date().toISOString(),
          hasChanges: false,
          totals: {
            filesChanged: 0,
            additions: 0,
            deletions: 0,
          },
          files: [],
          summary: "No changes.",
        };
      },
    } as never,
  );
}

function expectAppError(error: unknown, errorCode: string, statusCode: number) {
  assert.ok(error instanceof appErrorModule.AppError);
  assert.equal(error.errorCode, errorCode);
  assert.equal(error.statusCode, statusCode);
  return true;
}

describe("controller runtime adapters", () => {
  test("launchWorker dispatches through the vscode-copilot adapter and persists process id", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore, [
      createAdapter("vscode-copilot", async () => ({ ok: true, processId: 4242 })),
    ]);

    const worker = await controller.createWorker({
      name: "worker-launch-success",
      worktreePath: path.join(tempCwd, "worker-launch-success"),
      assignedBranch: "task/worker-launch-success",
    });

    const updatedWorker = await controller.launchWorker(worker.id);
    const state = stateStore.getState();
    const launchEvent = [...state.events].reverse().find((entry) => entry.type === "WorkerLaunched");

    assert.equal(updatedWorker.processId, 4242);
    assert.equal(stateStore.getWorkerById(worker.id)?.processId, 4242);
    assert.equal(launchEvent?.entityId, worker.id);
  });

  test("launchWorker turns unsupported runtime launch into a stable operator error", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore, [
      createAdapter("openclaw", async () => ({ ok: false, error: "Launch not supported for runtime kind: openclaw" })),
    ]);

    const worker = await controller.createWorker({
      name: "worker-launch-unsupported",
      runtimeKind: "openclaw",
      worktreePath: path.join(tempCwd, "worker-launch-unsupported"),
      assignedBranch: "task/worker-launch-unsupported",
    });

    await assert.rejects(
      controller.launchWorker(worker.id),
      (error) => expectAppError(error, "WORKER_LAUNCH_FAILED", 422),
    );

    const persisted = stateStore.getWorkerById(worker.id);
    const state = stateStore.getState();
    const failureEvent = [...state.events].reverse().find((entry) => entry.type === "WorkerLaunchFailed");

    assert.equal(persisted?.status, "offline");
    assert.equal(failureEvent?.entityId, worker.id);
    assert.deepEqual(failureEvent?.payload, { reason: "Launch not supported for runtime kind: openclaw" });
  });

  test("launchWorker propagates adapter exceptions through the existing failure path", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore, [
      createAdapter("vscode-copilot", async () => {
        throw new Error("simulated launch failure");
      }),
    ]);

    const worker = await controller.createWorker({
      name: "worker-launch-throws",
      worktreePath: path.join(tempCwd, "worker-launch-throws"),
      assignedBranch: "task/worker-launch-throws",
    });

    await assert.rejects(
      controller.launchWorker(worker.id),
      (error) => expectAppError(error, "WORKER_LAUNCH_FAILED", 422),
    );

    const persisted = stateStore.getWorkerById(worker.id);
    const failureEvent = [...stateStore.getState().events]
      .reverse()
      .find((entry) => entry.type === "WorkerLaunchFailed" && entry.entityId === worker.id);

    assert.equal(persisted?.status, "offline");
    assert.deepEqual(failureEvent?.payload, { reason: "simulated launch failure" });
  });

  test("listWorkers includes additive runtimeCapabilities derived from the adapter registry", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore, [
      createAdapter("vscode-copilot", async () => ({ ok: true, processId: 4242 })),
      createAdapter("openclaw", async () => ({ ok: false, error: "unsupported" })),
    ]);

    const vscodeWorker = await controller.createWorker({
      name: "worker-vscode",
      runtimeKind: "vscode-copilot",
      worktreePath: path.join(tempCwd, "worker-vscode"),
      assignedBranch: "task/worker-vscode",
    });
    const openclawWorker = await controller.createWorker({
      name: "worker-openclaw",
      runtimeKind: "openclaw",
      worktreePath: path.join(tempCwd, "worker-openclaw"),
      assignedBranch: "task/worker-openclaw",
    });

    const result = await controller.listWorkers({ includeDiff: false });
    const vscodeSummary = result.items.find((item) => item.workerId === vscodeWorker.id);
    const openclawSummary = result.items.find((item) => item.workerId === openclawWorker.id);

    assert.deepEqual(vscodeSummary?.runtimeCapabilities, {
      canOpenEditor: true,
      supportsSnapshots: false,
    });
    assert.deepEqual(openclawSummary?.runtimeCapabilities, {
      canOpenEditor: false,
      supportsSnapshots: false,
    });
  });
});
