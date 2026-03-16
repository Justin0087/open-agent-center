# Architecture

This document is the living architecture reference for open-agent-center.

It should be updated whenever the controller responsibilities, worker model, storage model, or integration boundaries change.

## Target System Diagram

```mermaid
flowchart LR
    Operator[Operator]
    Dashboard[Local Dashboard UI\nplanned]
    Controller[Local Controller API\nNode.js + TypeScript]

    subgraph App[Application Layer]
        Orchestrator[ControllerService\nuse cases]
        Queries[Query Layer\nworker board / task detail]
    end

    subgraph Infra[Infrastructure Services]
        StateStore[StateStore\ncurrent: JSON\nfuture: SQLite]
        WindowManager[WindowManager\nlaunch VS Code]
        WorktreeManager[WorktreeManager\ngit worktree create/sync]
        DiffService[DiffService\ngit status / diff]
    end

    subgraph Repo[Repository Side]
        MainRepo[Base Repository]
        WorktreeA[Worker Worktree A]
        WorktreeB[Worker Worktree B]
    end

    subgraph Workers[VS Code Worker Sessions]
        VSCodeA[VS Code Window A\nCopilot Worker]
        VSCodeB[VS Code Window B\nCopilot Worker]
    end

    Operator --> Dashboard
    Operator --> Controller
    Dashboard --> Controller

    Controller --> Orchestrator
    Controller --> Queries

    Orchestrator --> StateStore
    Orchestrator --> WindowManager
    Orchestrator --> WorktreeManager
    Orchestrator --> DiffService

    Queries --> StateStore
    Queries --> DiffService

    WorktreeManager --> MainRepo
    WorktreeManager --> WorktreeA
    WorktreeManager --> WorktreeB

    WindowManager --> VSCodeA
    WindowManager --> VSCodeB

    VSCodeA <--> WorktreeA
    VSCodeB <--> WorktreeB

    DiffService --> WorktreeA
    DiffService --> WorktreeB

    StateStore --> Events[(Events / Runs / Tasks / Workers)]
```

## Architecture Intent

open-agent-center is a local-first control plane for managing multiple VS Code Copilot worker windows on one machine.

The controller is the system of record for:

- projects
- workers
- tasks
- runs
- artifacts
- events

Each worker is modeled as one VS Code window plus one isolated git worktree.

## Current Boundaries

### Controller

The controller exposes local HTTP APIs for orchestration and read models.

Current implementation centers on:

- project registration
- worker creation
- task creation
- task assignment
- worker launch
- worker diff inspection
- task detail inspection

### Application Layer

The application layer coordinates use cases and enforces state transitions.

Current core entry point:

- `src/application/controllerService.ts`

### Infrastructure Services

Current services:

- `StateStore`: local persistence, currently JSON-backed
- `WindowManager`: launches VS Code windows
- `WorktreeManager`: provisions git worktrees
- `DiffService`: reads git status and diff summaries from worker worktrees

### Query Layer

The query layer shapes data for future dashboard views.

Current query modules:

- `src/queries/workerQueries.ts`
- `src/queries/taskQueries.ts`

## Current vs Planned

Implemented now:

- local controller API
- worktree provisioning
- worker launch
- worker diff endpoint
- task detail endpoint
- application-layer orchestration entry point

Planned next:

- branch sync and conflict summaries
- worker heartbeat and offline detection
- dashboard UI
- review queue
- SQLite migration for persistence

## Maintenance Rule

When changing the system, update this file if any of the following change:

- a new major service is introduced
- data ownership moves between modules
- a new external integration boundary is added
- the worker lifecycle or repository isolation model changes
- storage moves from JSON to SQLite or another backing store