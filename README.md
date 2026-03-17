# open-agent-center

open-agent-center is a local-first control plane for orchestrating multiple VS Code Copilot worker windows on one Windows machine.

Architecture reference: [ARCHITECTURE.md](ARCHITECTURE.md)

The current implementation focuses on the first practical slice of the system:

- register a project
- provision isolated git worktrees for workers
- create isolated workers bound to worktree paths and branches
- create parallel development tasks
- assign tasks to workers
- launch VS Code windows for workers
- persist local controller state for later dashboard and review work

## Why This Exists

Running several Copilot-driven development threads in parallel quickly breaks down without isolation and visibility. The first version of open-agent-center treats each VS Code window as a worker session and gives it:

- a unique worker identity
- a dedicated worktree path
- a dedicated branch
- a tracked task assignment
- a persistent event trail

This keeps the problem grounded in supported automation boundaries. The controller manages windows, state, and review flow; Copilot interaction stays inside VS Code.

## Current Implementation

The repository now contains a minimal TypeScript controller service with:

- local HTTP API
- JSON-backed state persistence in `.data/state.json`
- in-memory domain model for projects, workers, tasks, runs, artifacts, and events
- same-origin validation dashboard served by the controller
- dashboard operator controls for task creation, assignment, worker provisioning, launch, heartbeat, and branch sync
- project-aware task and worker binding so assignments stay inside a single repository context
- a VS Code window launcher using the `code` CLI
- an application layer for orchestration use cases
- a git worktree provisioning service for new workers
- a git diff inspection service for worker worktrees

Current source layout:

- `src/index.ts`: server bootstrap
- `src/application/controllerService.ts`: orchestration use cases
- `src/routes/api.ts`: HTTP routing
- `src/services/stateStore.ts`: persistent state and event recording
- `src/services/windowManager.ts`: worker window launcher
- `src/services/worktreeManager.ts`: git worktree provisioning
- `src/services/diffService.ts`: worker diff inspection
- `src/queries/workerQueries.ts`: worker board read model
- `src/domain/types.ts`: shared domain types

## API Surface

Available endpoints:

- `GET /`
- `GET /dashboard`
- `GET /dashboard.css`
- `GET /dashboard.js`
- `GET /health`
- `GET /api/state`
- `GET /api/projects`
- `GET /api/workers`
- `GET /api/workers/:workerId/diff`
- `GET /api/tasks`
- `GET /api/tasks/:taskId`
- `POST /api/projects`
- `POST /api/projects/:projectId/worktrees`
- `POST /api/workers`
- `POST /api/workers/:workerId/heartbeat`
- `POST /api/workers/:workerId/sync`
- `POST /api/tasks`
- `POST /api/assignments`
- `POST /api/tasks/:taskId/transitions`
- `POST /api/tasks/:taskId/review`
- `POST /api/workers/:workerId/launch`

## Getting Started

Requirements:

- Node.js 20.11 or newer
- VS Code `code` CLI available in `PATH`

Install dependencies:

```bash
npm install
```

Run the controller in development mode:

```bash
npm run dev
```

Open the validation dashboard in your browser:

```text
http://127.0.0.1:4317/dashboard
```

The root path redirects to `/dashboard` for convenience.

The dashboard now supports the main operator loop directly in the browser: create tasks, provision workers, assign queued work, launch worker windows, send heartbeat updates, and trigger branch sync back to the repository default branch. Tasks can optionally be bound to a project, and worktree-backed workers are automatically bound to their source project so cross-project assignment mistakes are rejected.

The next operator slice is also available through the same dashboard task table: unassign active work, mark tasks blocked, move tasks into review, complete them, or cancel them without leaving the page.

Tasks in `review` also appear in a dedicated review queue panel. The dashboard inspects `GET /api/tasks/:taskId` and `GET /api/workers/:workerId/diff` to show the latest task detail, artifacts, and worker diff summary before you approve, request changes, or integrate the work.

The review panel also includes reviewer notes. When you submit approve, request changes, or integrate from the dashboard, any note you enter is stored as a `note` artifact for that task.

Run a type check:

```bash
npm run check
```

Run the focused automated tests:

```bash
npm test
```

Type-check the test files as well:

```bash
npm run check:test
```

Run a local smoke check for project registration, task creation, and worktree provisioning:

```bash
npm run smoke:worktree
```

Run a local smoke check for the review queue flow:

```bash
npm run smoke:review
```

Run a local smoke check for the request-changes and reassignment flow:

```bash
npm run smoke:review:changes
```

Run a local smoke check for the real integration conflict flow:

```bash
npm run smoke:review:conflict
```

The smoke script assumes the controller is already running on `http://127.0.0.1:4317` and uses the current repository root as the registered project path. By default it leaves the generated branch and worktree in place for inspection. To clean up immediately, run:

```powershell
pwsh -File scripts/smoke-provision-worktree.ps1 -Cleanup
```

The review smoke script also assumes the controller is already running on `http://127.0.0.1:4317`. By default it now validates a real `assign -> review -> approve(notes) -> integrate` flow against an isolated temporary local clone: it provisions a worktree-backed worker, creates a real commit on the worker branch, integrates it into the registered project's `main`, and confirms the resulting repository `HEAD` and file content changed as expected.

`npm run smoke:review:changes` runs the alternate scenario: `assign -> review -> request_changes(notes) -> queued -> reassign -> review`. This confirms the task is returned to the queue, released from its first worker, then successfully reassigned and resubmitted for review.

`npm run smoke:review:conflict` runs the real merge-conflict scenario: it creates conflicting commits on the worker branch and `main`, attempts `integrate`, then confirms the task stays in `review`, the integration result is `conflicted`, and the repository `HEAD` remains on the pre-existing `main` commit.

Example flow:

1. Register your repository as a project.
2. Create tasks.
3. Ask the controller to provision one worker worktree per task.
4. Assign tasks to workers.
5. Launch the matching VS Code worker windows.
6. Open `/dashboard` to validate the resulting controller state visually.

Example project registration:

```bash
curl -X POST http://localhost:4317/api/projects \
	-H "Content-Type: application/json" \
	-d "{\"name\":\"open-agent-center\",\"repoPath\":\"C:/repo/open-agent-center\",\"defaultBranch\":\"main\"}"
```

Example worker creation:

```bash
curl -X POST http://localhost:4317/api/workers \
	-H "Content-Type: application/json" \
	-d "{\"name\":\"worker-1\",\"projectId\":\"<project-id>\",\"worktreePath\":\"C:/repo/.worktrees/worker-1\",\"assignedBranch\":\"task/worker-1\"}"
```

Example task creation:

```bash
curl -X POST http://localhost:4317/api/tasks \
	-H "Content-Type: application/json" \
	-d "{\"title\":\"Build worker board\",\"description\":\"Implement worker status grid\",\"priority\":\"high\",\"projectId\":\"<project-id>\"}"
```

Example worktree-backed worker creation:

```bash
curl -X POST http://localhost:4317/api/projects/<project-id>/worktrees \
	-H "Content-Type: application/json" \
	-d "{\"workerName\":\"copilot-1\",\"branchBase\":\"worker-board\"}"
```

You can also attach the new worker directly to a task during provisioning:

```bash
curl -X POST http://localhost:4317/api/projects/<project-id>/worktrees \
	-H "Content-Type: application/json" \
	-d "{\"workerName\":\"copilot-1\",\"taskId\":\"<task-id>\"}"
```

Example worker diff lookup:

```bash
curl http://localhost:4317/api/workers/<worker-id>/diff
```

`GET /api/workers` now returns board-oriented live fields for each worker, including:

- `projectId`: the repository context bound to the worker, if any
- `projectName`: the bound project name, when available
- `changedFileCount`: current modified or untracked file count from the worktree
- `hasChanges`: whether the worker currently has local changes
- `heartbeatAgeMs`: how old the latest worker heartbeat is
- `isStale`: whether the latest heartbeat is older than the configured timeout
- `lastSyncStatus`: latest sync outcome derived from the event trail
- `lastSyncTargetBranch`: the branch most recently synced against
- `lastSyncSummary`: operator-friendly summary of the last sync result

`GET /api/workers` also supports dashboard-friendly query parameters:

- `status=idle|active|blocked|offline`
- `hasChanges=true|false`
- `isStale=true|false`
- `includeDiff=true|false`
- `taskId=<task id>`
- `branch=<branch name>`
- `lastSyncStatus=synced|conflicted`
- `sortBy=name|status|lastSeenAt|heartbeatAgeMs|changedFileCount`
- `sortOrder=asc|desc`
- `limit=<non-negative integer>`
- `offset=<non-negative integer>`

`GET /api/workers` returns:

- `items`: the current page of worker summaries
- `includesDiffMetrics`: whether this response actually computed and included live diff fields
- `pagination.total`: number of workers after filters are applied
- `pagination.limit`: requested page size
- `pagination.offset`: starting index into the filtered result set
- `pagination.count`: number of workers in the current page
- `pagination.hasMore`: whether another page exists after the current one

`includeDiff=false` skips live diff collection unless the request still needs diff-derived behavior such as `hasChanges=...` filtering or `sortBy=changedFileCount`.

Example filtered worker board lookup:

```bash
curl "http://localhost:4317/api/workers?status=offline&hasChanges=true&sortBy=heartbeatAgeMs&sortOrder=desc"
```

Example task- and sync-aware worker board lookup:

```bash
curl "http://localhost:4317/api/workers?taskId=830f184f-a195-4a21-9422-c45d3bb03317&lastSyncStatus=conflicted&branch=feature/controller-query-foundation"
```

Example paginated worker board lookup:

```bash
curl "http://localhost:4317/api/workers?sortBy=name&sortOrder=asc&limit=2&offset=2"
```

Example lightweight worker board lookup without diff sampling:

```bash
curl "http://localhost:4317/api/workers?includeDiff=false&sortBy=lastSeenAt&sortOrder=desc&limit=20"
```

Example worker branch sync:

```bash
curl -X POST http://localhost:4317/api/workers/<worker-id>/sync \
	-H "Content-Type: application/json" \
	-d "{\"targetBranch\":\"main\"}"
```

Example worker heartbeat:

```bash
curl -X POST http://127.0.0.1:4317/api/workers/<worker-id>/heartbeat \
	-H "Content-Type: application/json" \
	-d "{\"status\":\"active\"}"
```

Heartbeat behavior:

- workers can report `idle`, `active`, or `blocked`
- `offline` is controller-derived, not worker-reported
- a worker is treated as `offline` when `lastSeenAt` is older than `WORKER_HEARTBEAT_TIMEOUT_MS`
- the default timeout is 5 minutes
- `heartbeatAgeMs` and `isStale` are returned by worker and task read models so the UI does not need to reimplement timeout math

Example task lifecycle transition:

```bash
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/transitions \
	-H "Content-Type: application/json" \
	-d "{\"action\":\"review\"}"
```

Example review action:

```bash
curl -X POST http://127.0.0.1:4317/api/tasks/<task-id>/review \
	-H "Content-Type: application/json" \
	-d "{\"action\":\"approve\"}"
```

## Dashboard

The built-in dashboard is a same-origin operator surface for the current demo. It polls the existing controller APIs every few seconds and renders:

- controller health and refresh state
- summary cards for projects, workers, tasks, runs, artifacts, and events
- worker status insight cards for active, blocked, offline, and stale-heartbeat counts
- projects, workers, and tasks tables
- a recent event timeline
- lightweight action controls for task creation, worker provisioning, worker launch, and heartbeat updates

The workers table is backed by the worker board API, so it also shows controller-derived status, heartbeat freshness, and changed-file counts without you having to inspect raw JSON manually. The dashboard now also exposes small mutation controls so you can validate the main orchestration loop without switching to curl for every step.

Example task detail lookup:

```bash
curl http://localhost:4317/api/tasks/<task-id>
```

## Next Milestones

Planned next implementation steps:

- review and integration queue
- SQLite-backed persistence and richer worker lifecycle history

## Scope Notes

This project intentionally does not yet automate Copilot chat internals. That is a higher-risk layer and comes after worktree isolation, task orchestration, and observability are stable.
