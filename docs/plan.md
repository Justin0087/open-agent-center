## Plan: Runtime Adapter Contract

Use the next implementation slice to turn `runtimeKind` from stored metadata into a real application boundary. The recommended scope is one incremental runtime-adapter PR: introduce an adapter contract and registry, route worker launch through it, ship `vscode-copilot` as the first concrete adapter, and expose additive runtime capability metadata on the existing worker board response so the dashboard can explain and gate actions without breaking `/api/workers` compatibility. Do not broaden this slice into non-VS Code launch implementations, API renaming, or more SQLite schema work.

**Steps**
1. Phase 1: Define the runtime boundary. Add runtime adapter types for launch result, optional heartbeat hook, optional runtime snapshot, and a registry keyed by `AgentRuntimeKind`. Keep the contract minimal: it should support current launch flow first and leave room for richer health semantics later.
2. Phase 1: Add concrete adapters. Wrap the existing VS Code launcher behind a `vscode-copilot` adapter. Add simple placeholder adapters for `claude-code`, `openclaw`, and `custom` so controller dispatch does not devolve into branching logic. Placeholder adapters may intentionally return predictable unsupported errors for launch if that is the chosen policy.
3. Phase 1: Refactor controller launch through the registry. Update `ControllerService.launchWorker` so it resolves the adapter from `worker.runtimeKind`, calls the adapter, then preserves the current state transitions and event recording through `markWorkerLaunched` and `markWorkerLaunchFailed`. Keep route shapes and response semantics unchanged.
4. Phase 1: Keep heartbeat backward-compatible. Leave the external heartbeat route unchanged. Optionally add an adapter hook point in `heartbeatWorker`, but do not require runtime-specific heartbeat behavior in this PR unless it is trivial and fully testable.
5. Phase 2: Expose runtime capabilities on read models. Add additive capability metadata to the existing worker summary shape, derived from runtime kind through the adapter or a shared capability mapper. Capabilities should be derived at read time, not stored in persistence.
6. Phase 2: Update dashboard runtime UX. Surface a small runtime capability summary in the worker table and provisioning form, and disable unsupported worker actions based on runtime capability while keeping existing project/task state gating intact.
7. Phase 2: Keep docs aligned. Update README and architecture docs to reflect the new runtime boundary, the still-stable `/api/workers` routes, and the fact that capability exposure is now implemented while broader runtime behavior remains incremental.
8. Phase 3: Expand tests and smoke coverage. Add controller tests for adapter resolution and launch outcomes, and ensure existing smoke paths still pass without route or payload regressions.

**Implementation sequence**
1. Add runtime adapter types and registry support.
2. Add the `vscode-copilot` adapter around the existing `WindowManager`.
3. Add placeholder adapters for the other declared runtime kinds.
4. Thread the registry into the composition root and controller constructor.
5. Refactor `launchWorker` to use adapter dispatch.
6. Add runtime capability metadata to worker summaries.
7. Update dashboard rendering for capability hints and disabled actions.
8. Update docs and tests.

**Parallelism and dependencies**
1. Steps 1 through 5 are sequential because the controller cannot dispatch until the adapter contract and registry exist.
2. Step 6 can begin once the adapter capability shape is fixed.
3. Steps 7 and 8 can run in parallel after the API and UI shapes stabilize.

**Relevant files**
- `src/application/controllerService.ts` — refactor `launchWorker`, optionally add a runtime hook point in `heartbeatWorker`, and thread runtime capability data into read-model responses where appropriate.
- `src/index.ts` — compose and inject the runtime adapter registry.
- `src/domain/types.ts` — define any domain-visible runtime capability or adapter result contracts used by the worker board.
- `src/services/windowManager.ts` — keep as the low-level VS Code process launcher used by the `vscode-copilot` adapter.
- `src/routes/api.ts` — preserve route compatibility and, if needed, validate any additive list-workers query parameters or response typing changes.
- `src/queries/workerQueries.ts` — attach derived runtime capability metadata to worker summaries.
- `src/queries/taskQueries.ts` — optionally mirror runtime capability metadata in task-detail assigned-worker summaries if the review panel needs it.
- `public/dashboard.html` — add minimal UI affordances for runtime capability hints.
- `public/dashboard.js` — render runtime capabilities and gate unsupported actions in the worker board and provision form.
- `README.md` — document runtime capability fields and operator-visible behavior changes.
- `ARCHITECTURE.md` — move runtime adapters from planned-only to partially implemented.
- `tests/project-ownership.test.ts` — extend or complement with launch-path coverage through the adapter boundary.
- `tests/sqlite-state-repository.test.ts` — no direct runtime work expected here; this file is out of scope unless a regression appears.

**Verification**
1. Confirm `vscode-copilot` workers still launch successfully through `POST /api/workers/:workerId/launch` with unchanged response and event behavior.
2. Confirm unsupported runtime launch behavior is explicit and predictable, with clear operator-facing error semantics.
3. Confirm `GET /api/workers` remains backward-compatible and only adds runtime capability fields.
4. Confirm dashboard actions are disabled only when runtime capability disallows them, without regressing existing task/project lifecycle gating.
5. Confirm `npm run check` and `npm test` pass, and rerun existing smoke flows that cover provisioning, launch, heartbeat, and lifecycle paths.
6. Confirm both JSON and SQLite repositories behave identically under the new runtime adapter layer.

**Decisions**
- Included scope: adapter contract, registry, first concrete adapter, additive capability exposure, dashboard hints, tests, and docs.
- Excluded scope: non-VS Code runtime launch implementations beyond placeholder adapters, API renaming, scheduler work, and further SQLite schema evolution.
- Preferred compatibility rule: keep `/api/workers` and current payloads stable; use additive fields only.
- Preferred capability rule: derive runtime capabilities from code at read time rather than persisting them.

**Further Considerations**
1. Decide unsupported-runtime policy before implementation starts. Option A: placeholder adapters fail launch clearly. Option B: all runtime kinds temporarily reuse the VS Code launcher. Recommendation: Option A, because it keeps semantics honest.
2. Decide whether heartbeat hooks are part of this PR. Recommendation: keep heartbeat externally unchanged and make adapter heartbeat hooks optional so launch refactor stays the main risk.
3. Decide whether task detail needs capability metadata immediately. Recommendation: worker board first; task detail only if the review panel needs runtime-specific action explanations in the same PR.
