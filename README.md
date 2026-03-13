# open-agent-center

open-agent-center is a local-first control plane for orchestrating multiple VS Code Copilot worker windows on one Windows machine.

Architecture reference: [ARCHITECTURE.md](ARCHITECTURE.md)

The current implementation focuses on the first practical slice of the system:

- register a project
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
- `POST /api/tasks`
- `POST /api/assignments`
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

Run a type check:

```bash
npm run check
```

Example flow:

1. Register your repository as a project.
2. Create one worker per git worktree.
3. Create tasks.
4. Assign tasks to workers.
5. Launch the matching VS Code worker windows.

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
	-d "{\"name\":\"worker-1\",\"worktreePath\":\"C:/repo/.worktrees/worker-1\",\"assignedBranch\":\"task/worker-1\"}"
```

Example task creation:

```bash
curl -X POST http://localhost:4317/api/tasks \
	-H "Content-Type: application/json" \
	-d "{\"title\":\"Build worker board\",\"description\":\"Implement worker status grid\",\"priority\":\"high\"}"
```

Example worktree-backed worker creation:

```bash
curl -X POST http://localhost:4317/api/projects/<project-id>/worktrees \
	-H "Content-Type: application/json" \
	-d "{\"workerName\":\"copilot-1\",\"branchBase\":\"worker-board\"}"
```

Example worker diff lookup:

```bash
curl http://localhost:4317/api/workers/<worker-id>/diff
```

Example task detail lookup:

```bash
curl http://localhost:4317/api/tasks/<task-id>
```

## Next Milestones

Planned next implementation steps:

- worker heartbeat and blocked-state transitions
- dashboard UI
- review and integration queue

## Scope Notes

This project intentionally does not yet automate Copilot chat internals. That is a higher-risk layer and comes after worktree isolation, task orchestration, and observability are stable.
