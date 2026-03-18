import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

interface MinimalProject {
  repoPath: string;
}

type ControllerModule = typeof import("../src/application/controllerService.js");
type AppErrorModule = typeof import("../src/application/appError.js");
type StateStoreModule = typeof import("../src/services/stateStore.js");

let tempCwd = "";
let originalCwd = "";
let controllerModule: ControllerModule;
let appErrorModule: AppErrorModule;
let stateStoreModule: StateStoreModule;

before(async () => {
  originalCwd = process.cwd();
  tempCwd = await mkdtemp(path.join(os.tmpdir(), "open-agent-center-tests-"));
  process.chdir(tempCwd);

  controllerModule = await import("../src/application/controllerService.js");
  appErrorModule = await import("../src/application/appError.js");
  stateStoreModule = await import("../src/services/stateStore.js");
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

function createController(stateStore: InstanceType<StateStoreModule["StateStore"]>) {
  const { ControllerService } = controllerModule;

  return new ControllerService(
    stateStore,
    {} as never,
    {
      async create(project: MinimalProject, workerName: string, branchBase?: string) {
        return {
          worktreePath: path.join(tempCwd, ".worktrees", workerName),
          branchName: `${branchBase ?? "task"}/${workerName}`,
          rootPath: project.repoPath,
        };
      },
    } as never,
    {} as never,
  );
}

function expectAppError(error: unknown, errorCode: string, statusCode: number) {
  assert.ok(error instanceof appErrorModule.AppError);
  assert.equal(error.errorCode, errorCode);
  assert.equal(error.statusCode, statusCode);
  return true;
}

describe("project ownership enforcement", () => {
  test("controller rejects assignment across different projects", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore);

    const projectA = await controller.registerProject({
      name: "project-a",
      repoPath: path.join(tempCwd, "repo-a"),
      defaultBranch: "main",
    });
    const projectB = await controller.registerProject({
      name: "project-b",
      repoPath: path.join(tempCwd, "repo-b"),
      defaultBranch: "main",
    });

    const task = await controller.createTask({
      title: "Scoped task",
      description: "Only project A workers can take this.",
      projectId: projectA.id,
    });
    const worker = await controller.createWorker({
      name: "worker-b",
      projectId: projectB.id,
      worktreePath: path.join(tempCwd, "repo-b.worktrees", "worker-b"),
      assignedBranch: "task/worker-b",
    });

    await assert.rejects(
      controller.assignTask({ taskId: task.id, workerId: worker.id }),
      (error) => expectAppError(error, "PROJECT_ASSIGNMENT_CONFLICT", 409),
    );
  });

  test("controller rejects assignment when only the task is project-bound", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore);

    const project = await controller.registerProject({
      name: "project-a",
      repoPath: path.join(tempCwd, "repo-a"),
      defaultBranch: "main",
    });

    const task = await controller.createTask({
      title: "Scoped task",
      description: "Unbound workers must not receive this task.",
      projectId: project.id,
    });
    const worker = await controller.createWorker({
      name: "worker-unbound",
      worktreePath: path.join(tempCwd, "loose", "worker-unbound"),
      assignedBranch: "task/worker-unbound",
    });

    await assert.rejects(
      controller.assignTask({ taskId: task.id, workerId: worker.id }),
      (error) => expectAppError(error, "PROJECT_ASSIGNMENT_CONFLICT", 409),
    );
  });

  test("state store rejects mismatched project assignment as a second line of defense", async () => {
    const stateStore = await createStateStore();

    const task = await stateStore.createTask({
      title: "Scoped task",
      description: "Direct state assignment should still be blocked.",
      projectId: "project-a",
    });
    const worker = await stateStore.createWorker({
      name: "worker-b",
      projectId: "project-b",
      worktreePath: path.join(tempCwd, "repo-b.worktrees", "worker-b"),
      assignedBranch: "task/worker-b",
    });

    await assert.rejects(
      stateStore.assignTask({ taskId: task.id, workerId: worker.id }),
      /must belong to the same project before assignment/,
    );
  });

  test("provisioned worktree workers inherit the project and can be attached to same-project tasks", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore);

    const project = await controller.registerProject({
      name: "project-a",
      repoPath: path.join(tempCwd, "repo-a"),
      defaultBranch: "main",
    });
    const task = await controller.createTask({
      title: "Scoped task",
      description: "Provisioned workers should inherit this project.",
      projectId: project.id,
    });

    const provisioned = await controller.createProjectWorktree(project.id, {
      workerName: "worker-a",
      taskId: task.id,
      branchBase: "feature",
    });

    assert.equal(provisioned.worker.projectId, project.id);
    assert.equal(provisioned.task?.assignedWorkerId, provisioned.worker.id);
    assert.equal(provisioned.worker.assignedTaskId, task.id);
  });

  test("controller rejects unknown project ids during task and worker creation", async () => {
    const stateStore = await createStateStore();
    const controller = createController(stateStore);

    await assert.rejects(
      controller.createTask({
        title: "Invalid task",
        description: "Unknown project.",
        projectId: "missing-project",
      }),
      (error) => expectAppError(error, "PROJECT_NOT_FOUND", 404),
    );

    await assert.rejects(
      controller.createWorker({
        name: "invalid-worker",
        projectId: "missing-project",
        worktreePath: path.join(tempCwd, "missing", "invalid-worker"),
        assignedBranch: "task/invalid-worker",
      }),
      (error) => expectAppError(error, "PROJECT_NOT_FOUND", 404),
    );
  });
});