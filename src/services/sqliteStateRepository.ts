import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import initSqlJs, { SqlJsDatabase, SqlJsStatic } from "sql.js";

import { DATA_DIR, JSON_STATE_FILE, SQLITE_STATE_FILE } from "./statePersistencePaths.js";
import { StateStore } from "./stateStore.js";

const require = createRequire(import.meta.url);

export class SQLiteStateRepository extends StateStore {
  private sql?: SqlJsStatic;
  private db?: SqlJsDatabase;

  override async initialize(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    this.sql = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
    });

    this.db = new this.sql.Database(await this.loadDatabaseFile());
    const requiresProjectionRefresh = this.ensureSchema();

    const persistedState = this.readStateFromDatabase();
    let shouldPersist = requiresProjectionRefresh;

    if (persistedState) {
      this.state = persistedState;
    } else {
      const importedJsonState = await this.readImportedJsonState();
      if (importedJsonState) {
        this.state = importedJsonState;
      }
      shouldPersist = true;
    }

    if (this.normalizeState()) {
      shouldPersist = true;
    }

    if (shouldPersist) {
      await this.persist();
    }
  }

  protected override async persist(): Promise<void> {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const serializedState = JSON.stringify(this.state, null, 2);
    const statement = this.db.prepare(
      `
        INSERT INTO app_state (id, state_json, updated_at)
        VALUES (1, $stateJson, $updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `,
    );

    try {
      this.db.run("BEGIN");

      statement.run({
        $stateJson: serializedState,
        $updatedAt: new Date().toISOString(),
      });

      this.refreshRelationalProjection();
      this.db.run("COMMIT");
    } finally {
      try {
        this.db.run("ROLLBACK");
      } catch {
        // Ignore rollback failures after a successful commit.
      }
      statement.free();
    }

    await writeFile(SQLITE_STATE_FILE, Buffer.from(this.db.export()));
  }

  private ensureSchema(): boolean {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const schemaVersion = this.readSchemaVersion();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runtime_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        project_id TEXT,
        worktree_path TEXT NOT NULL,
        assigned_branch TEXT NOT NULL,
        assigned_task_id TEXT,
        process_id INTEGER,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority TEXT NOT NULL,
        project_id TEXT,
        status TEXT NOT NULL,
        target_paths_json TEXT NOT NULL,
        acceptance_checks_json TEXT NOT NULL,
        assigned_worker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT,
        result TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        path_or_text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workers_project_id ON workers(project_id);
      CREATE INDEX IF NOT EXISTS idx_workers_assigned_task_id ON workers(assigned_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned_worker_id ON tasks(assigned_worker_id);
      CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id);
      CREATE INDEX IF NOT EXISTS idx_runs_worker_id ON runs(worker_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);

      INSERT INTO metadata (key, value)
      VALUES ('schemaVersion', '2')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);

    return schemaVersion !== "2";
  }

  private refreshRelationalProjection(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    this.db.run(`
      DELETE FROM projects;
      DELETE FROM workers;
      DELETE FROM tasks;
      DELETE FROM runs;
      DELETE FROM artifacts;
      DELETE FROM events;
    `);

    this.insertProjects();
    this.insertWorkers();
    this.insertTasks();
    this.insertRuns();
    this.insertArtifacts();
    this.insertEvents();
  }

  private insertProjects(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare(`
      INSERT INTO projects (id, name, repo_path, default_branch, created_at, archived_at)
      VALUES ($id, $name, $repoPath, $defaultBranch, $createdAt, $archivedAt)
    `);

    try {
      for (const project of this.state.projects) {
        statement.run({
          $id: project.id,
          $name: project.name,
          $repoPath: project.repoPath,
          $defaultBranch: project.defaultBranch,
          $createdAt: project.createdAt,
          $archivedAt: project.archivedAt ?? null,
        });
      }
    } finally {
      statement.free();
    }
  }

  private insertWorkers(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare(`
      INSERT INTO workers (
        id, name, runtime_kind, status, project_id, worktree_path, assigned_branch,
        assigned_task_id, process_id, last_seen_at, created_at, archived_at
      )
      VALUES (
        $id, $name, $runtimeKind, $status, $projectId, $worktreePath, $assignedBranch,
        $assignedTaskId, $processId, $lastSeenAt, $createdAt, $archivedAt
      )
    `);

    try {
      for (const worker of this.state.workers) {
        statement.run({
          $id: worker.id,
          $name: worker.name,
          $runtimeKind: worker.runtimeKind,
          $status: worker.status,
          $projectId: worker.projectId ?? null,
          $worktreePath: worker.worktreePath,
          $assignedBranch: worker.assignedBranch,
          $assignedTaskId: worker.assignedTaskId ?? null,
          $processId: worker.processId ?? null,
          $lastSeenAt: worker.lastSeenAt,
          $createdAt: worker.createdAt,
          $archivedAt: worker.archivedAt ?? null,
        });
      }
    } finally {
      statement.free();
    }
  }

  private insertTasks(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, priority, project_id, status,
        target_paths_json, acceptance_checks_json, assigned_worker_id, created_at, updated_at
      )
      VALUES (
        $id, $title, $description, $priority, $projectId, $status,
        $targetPathsJson, $acceptanceChecksJson, $assignedWorkerId, $createdAt, $updatedAt
      )
    `);

    try {
      for (const task of this.state.tasks) {
        statement.run({
          $id: task.id,
          $title: task.title,
          $description: task.description,
          $priority: task.priority,
          $projectId: task.projectId ?? null,
          $status: task.status,
          $targetPathsJson: JSON.stringify(task.targetPaths),
          $acceptanceChecksJson: JSON.stringify(task.acceptanceChecks),
          $assignedWorkerId: task.assignedWorkerId ?? null,
          $createdAt: task.createdAt,
          $updatedAt: task.updatedAt,
        });
      }
    } finally {
      statement.free();
    }
  }

  private insertRuns(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare(`
      INSERT INTO runs (id, task_id, worker_id, start_at, end_at, result, notes)
      VALUES ($id, $taskId, $workerId, $startAt, $endAt, $result, $notes)
    `);

    try {
      for (const run of this.state.runs) {
        statement.run({
          $id: run.id,
          $taskId: run.taskId,
          $workerId: run.workerId,
          $startAt: run.startAt,
          $endAt: run.endAt ?? null,
          $result: run.result ?? null,
          $notes: run.notes ?? null,
        });
      }
    } finally {
      statement.free();
    }
  }

  private insertArtifacts(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare(`
      INSERT INTO artifacts (id, task_id, type, path_or_text, created_at)
      VALUES ($id, $taskId, $type, $pathOrText, $createdAt)
    `);

    try {
      for (const artifact of this.state.artifacts) {
        statement.run({
          $id: artifact.id,
          $taskId: artifact.taskId,
          $type: artifact.type,
          $pathOrText: artifact.pathOrText,
          $createdAt: artifact.createdAt,
        });
      }
    } finally {
      statement.free();
    }
  }

  private insertEvents(): void {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare(`
      INSERT INTO events (id, ts, type, entity_type, entity_id, payload_json)
      VALUES ($id, $ts, $type, $entityType, $entityId, $payloadJson)
    `);

    try {
      for (const event of this.state.events) {
        statement.run({
          $id: event.id,
          $ts: event.ts,
          $type: event.type,
          $entityType: event.entityType,
          $entityId: event.entityId,
          $payloadJson: JSON.stringify(event.payload),
        });
      }
    } finally {
      statement.free();
    }
  }

  private readSchemaVersion(): string | undefined {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    try {
      const statement = this.db.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'");

      try {
        if (!statement.step()) {
          return undefined;
        }

        const row = statement.getAsObject();
        return typeof row.value === "string" ? row.value : undefined;
      } finally {
        statement.free();
      }
    } catch {
      return undefined;
    }
  }

  private readStateFromDatabase() {
    if (!this.db) {
      throw new Error("SQLite repository has not been initialized.");
    }

    const statement = this.db.prepare("SELECT state_json FROM app_state WHERE id = 1");

    try {
      if (!statement.step()) {
        return undefined;
      }

      const row = statement.getAsObject();
      const stateJson = row.state_json;
      return typeof stateJson === "string" ? JSON.parse(stateJson) : undefined;
    } finally {
      statement.free();
    }
  }

  private async readImportedJsonState() {
    try {
      const raw = await readFile(JSON_STATE_FILE, "utf8");
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private async loadDatabaseFile(): Promise<Uint8Array | undefined> {
    try {
      await access(SQLITE_STATE_FILE);
      const buffer = await readFile(SQLITE_STATE_FILE);
      return new Uint8Array(buffer);
    } catch {
      return undefined;
    }
  }
}