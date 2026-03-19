import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import initSqlJs, { SqlJsDatabase, SqlJsStatic } from "sql.js";

type SQLiteRepositoryModule = typeof import("../src/services/sqliteStateRepository.js");
type StateStoreModule = typeof import("../src/services/stateStore.js");

const require = createRequire(import.meta.url);

let tempCwd = "";
let originalCwd = "";
let sqliteRepositoryModule: SQLiteRepositoryModule;
let stateStoreModule: StateStoreModule;
let sql: SqlJsStatic;

before(async () => {
  originalCwd = process.cwd();
  tempCwd = await mkdtemp(path.join(os.tmpdir(), "open-agent-center-sqlite-tests-"));
  process.chdir(tempCwd);

  sql = await initSqlJs({
    locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
  });
  sqliteRepositoryModule = await import("../src/services/sqliteStateRepository.js");
  stateStoreModule = await import("../src/services/stateStore.js");
});

beforeEach(async () => {
  await rm(path.join(tempCwd, ".data"), { recursive: true, force: true });
});

after(async () => {
  process.chdir(originalCwd);
  await rm(tempCwd, { recursive: true, force: true });
});

async function openPersistedDatabase(): Promise<SqlJsDatabase> {
  const databaseFile = await readFile(path.join(tempCwd, ".data", "state.sqlite"));
  return new sql.Database(databaseFile);
}

function readCount(database: SqlJsDatabase, tableName: string): number {
  const statement = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`);

  try {
    assert.equal(statement.step(), true, `Expected ${tableName} count query to return a row.`);
    const row = statement.getAsObject();
    assert.equal(typeof row.count, "number");
    return row.count;
  } finally {
    statement.free();
  }
}

function readSchemaVersion(database: SqlJsDatabase): string {
  const statement = database.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'");

  try {
    assert.equal(statement.step(), true, "Expected schemaVersion row to exist.");
    const row = statement.getAsObject();
    assert.equal(typeof row.value, "string");
    return row.value;
  } finally {
    statement.free();
  }
}

describe("sqlite state repository", () => {
  test("persists controller state across repository restarts", async () => {
    const repository = new sqliteRepositoryModule.SQLiteStateRepository();
    await repository.initialize();

    const project = await repository.registerProject({
      name: "sqlite-project",
      repoPath: path.join(tempCwd, "repo-sqlite"),
      defaultBranch: "main",
    });

    const reloadedRepository = new sqliteRepositoryModule.SQLiteStateRepository();
    await reloadedRepository.initialize();

    assert.equal(reloadedRepository.getProjectById(project.id)?.name, "sqlite-project");
  });

  test("imports the existing JSON snapshot when booting into sqlite for the first time", async () => {
    const jsonRepository = new stateStoreModule.StateStore();
    await jsonRepository.initialize();

    const project = await jsonRepository.registerProject({
      name: "json-project",
      repoPath: path.join(tempCwd, "repo-json"),
      defaultBranch: "main",
    });

    const sqliteRepository = new sqliteRepositoryModule.SQLiteStateRepository();
    await sqliteRepository.initialize();

    assert.equal(sqliteRepository.getProjectById(project.id)?.name, "json-project");
  });

  test("writes normalized relational tables alongside the snapshot", async () => {
    const repository = new sqliteRepositoryModule.SQLiteStateRepository();
    await repository.initialize();

    const project = await repository.registerProject({
      name: "normalized-project",
      repoPath: path.join(tempCwd, "repo-normalized"),
      defaultBranch: "main",
    });
    const worker = await repository.createWorker({
      name: "agent-a",
      runtimeKind: "claude-code",
      projectId: project.id,
      worktreePath: path.join(tempCwd, "repo-normalized-agent-a"),
      assignedBranch: "agent-a/task-1",
    });
    const task = await repository.createTask({
      title: "Implement projection",
      description: "Keep SQLite tables queryable.",
      projectId: project.id,
      targetPaths: ["src/services/sqliteStateRepository.ts"],
      acceptanceChecks: ["npm test"],
    });

    await repository.assignTask({ taskId: task.id, workerId: worker.id });
    await repository.addArtifact(task.id, "note", "Projection refreshed successfully.");

    const database = await openPersistedDatabase();

    try {
      assert.equal(readSchemaVersion(database), "2");
      assert.equal(readCount(database, "projects"), 1);
      assert.equal(readCount(database, "workers"), 1);
      assert.equal(readCount(database, "tasks"), 1);
      assert.equal(readCount(database, "runs"), 1);
      assert.equal(readCount(database, "artifacts"), 1);
      assert.ok(readCount(database, "events") >= 5);
    } finally {
      database.close();
    }
  });

  test("upgrades a v1 snapshot database and backfills normalized tables", async () => {
    const timestamp = "2026-03-18T00:00:00.000Z";
    const legacyState = {
      projects: [
        {
          id: "project-1",
          name: "legacy-project",
          repoPath: path.join(tempCwd, "repo-legacy"),
          defaultBranch: "main",
          createdAt: timestamp,
        },
      ],
      workers: [
        {
          id: "worker-1",
          name: "legacy-worker",
          runtimeKind: "openclaw",
          status: "active",
          projectId: "project-1",
          worktreePath: path.join(tempCwd, "repo-legacy-worker"),
          assignedBranch: "legacy/task-1",
          assignedTaskId: "task-1",
          processId: 4242,
          lastSeenAt: timestamp,
          createdAt: timestamp,
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Legacy task",
          description: "Created before relational projection existed.",
          priority: "high",
          projectId: "project-1",
          status: "in_progress",
          targetPaths: ["README.md"],
          acceptanceChecks: ["npm run check"],
          assignedWorkerId: "worker-1",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      runs: [
        {
          id: "run-1",
          taskId: "task-1",
          workerId: "worker-1",
          startAt: timestamp,
        },
      ],
      artifacts: [
        {
          id: "artifact-1",
          taskId: "task-1",
          type: "note",
          pathOrText: "Legacy note",
          createdAt: timestamp,
        },
      ],
      events: [
        {
          id: "event-1",
          ts: timestamp,
          type: "TaskCreated",
          entityType: "task",
          entityId: "task-1",
          payload: { taskId: "task-1" },
        },
      ],
    };

    const legacyDatabase = new sql.Database();
    legacyDatabase.run(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDatabase.run("INSERT INTO metadata (key, value) VALUES ('schemaVersion', '1')");

    const insertSnapshot = legacyDatabase.prepare(`
      INSERT INTO app_state (id, state_json, updated_at)
      VALUES (1, $stateJson, $updatedAt)
    `);

    insertSnapshot.run({
      $stateJson: JSON.stringify(legacyState),
      $updatedAt: timestamp,
    });
    insertSnapshot.free();

    await mkdir(path.join(tempCwd, ".data"), { recursive: true });
    await writeFile(path.join(tempCwd, ".data", "state.sqlite"), Buffer.from(legacyDatabase.export()));
    legacyDatabase.close();

    const repository = new sqliteRepositoryModule.SQLiteStateRepository();
    await repository.initialize();

    assert.equal(repository.getProjectById("project-1")?.name, "legacy-project");

    const database = await openPersistedDatabase();

    try {
      assert.equal(readSchemaVersion(database), "2");
      assert.equal(readCount(database, "projects"), 1);
      assert.equal(readCount(database, "workers"), 1);
      assert.equal(readCount(database, "tasks"), 1);
      assert.equal(readCount(database, "runs"), 1);
      assert.equal(readCount(database, "artifacts"), 1);
      assert.equal(readCount(database, "events"), 1);
    } finally {
      database.close();
    }
  });
});