## Plan: Runtime Adapter Contract

Turn `runtimeKind` from stored metadata into a real runtime boundary in small, low-risk slices. The recommended path is three stages: first introduce the adapter boundary and move worker launch behind it, then expose derived runtime capabilities on read models, and only after that update dashboard UX and docs. This keeps the first implementation PR narrow and testable.

**Stage 1: Runtime Boundary**
1. Add minimal runtime adapter types in `src/domain/types.ts`.
This stage should only define what the current launch flow actually needs:
- `RuntimeAdapter`
- `LaunchResult`
- `RuntimeCapabilities` as static metadata
- a registry keyed by `AgentRuntimeKind`
2. Keep the adapter contract intentionally small.
Include `launch(worker)` and capability access. Do not include runtime snapshot semantics yet because there is no current caller that needs them.
3. Keep heartbeat unchanged externally.
Do not make runtime-specific heartbeat behavior part of the first implementation slice. If a hook is added, it should remain optional and unused in normal flow.
4. Add the concrete `vscode-copilot` adapter.
Wrap the current `WindowManager` launch behavior instead of reimplementing it.
5. Add placeholder adapters for `claude-code`, `openclaw`, and `custom`.
These should fail launch explicitly with predictable operator-facing errors rather than silently falling back to VS Code behavior.
6. Inject the registry through composition.
Construct the registry in `src/index.ts` and pass it into `ControllerService` so runtime selection is resolved centrally.
7. Refactor `ControllerService.launchWorker` to dispatch through the registry.
Preserve the existing route contract, response shape, and state transitions by continuing to call `markWorkerLaunched` and `markWorkerLaunchFailed` exactly as today.
8. Add launch-focused tests.
Cover adapter resolution, successful launch, unsupported runtime launch, and launch failure propagation.

**Stage 2: Runtime Capabilities on Read Models**
1. Add an optional additive `runtimeCapabilities` field to `WorkerSummary`.
This should be derived at read time from the adapter or a capability mapper, not stored in persistence.
2. Update `buildWorkerSummaries` to attach capability metadata.
Keep all current fields intact so `GET /api/workers` remains backward-compatible.
3. Defer task-detail capability propagation unless a real UI need appears.
Worker board support is sufficient for the first capability rollout.
4. Validate compatibility through API and repository tests.
This stage should not require schema changes in JSON or SQLite persistence.

**Stage 3: Dashboard UX and Docs**
1. Surface a small runtime capability hint in the worker board and provisioning form.
Keep the UI additive and non-blocking.
2. Disable unsupported actions only where runtime capability clearly disallows them.
Do not regress existing task/project lifecycle gating.
3. Update operator docs.
Document the adapter boundary and additive worker capability fields in `README.md`.
4. Do not plan around `ARCHITECTURE.md` unless that file is added.
The current repo context does not show that file, so it should not be treated as a required edit target.

**Implementation Order**
1. Stage 1 adapter types and registry.
2. Stage 1 `vscode-copilot` adapter.
3. Stage 1 placeholder adapters.
4. Stage 1 controller injection and `launchWorker` refactor.
5. Stage 1 tests.
6. Stage 2 worker summary capability field.
7. Stage 3 dashboard updates.
8. Stage 3 docs updates.

**Dependencies**
1. Stage 1 is sequential.
The controller cannot dispatch through adapters until the contract, registry, and concrete registrations exist.
2. Stage 2 depends on the Stage 1 capability shape being finalized.
3. Stage 3 depends on the Stage 2 response shape being stable.

**Relevant files**
- `src/application/controllerService.ts` — move worker launch to adapter dispatch while preserving current state transitions.
- `src/index.ts` — build and inject the runtime adapter registry.
- `src/domain/types.ts` — define adapter contract and additive runtime capability types.
- `src/services/windowManager.ts` — keep as the low-level VS Code launcher used by the `vscode-copilot` adapter.
- `src/queries/workerQueries.ts` — add derived runtime capability fields during read-model construction in Stage 2.
- `src/routes/api.ts` — preserve route compatibility and validate that no route shape changes are introduced.
- `public/dashboard.js` — render capability hints and disable unsupported actions in Stage 3.
- `public/dashboard.html` — add minimal UI affordances only if needed.
- `README.md` — document the runtime boundary and additive capability fields.
- `tests/project-ownership.test.ts` — extend only if this remains the best controller-level test location.
- `tests/sqlite-state-repository.test.ts` — regression coverage only; no direct runtime logic should be added here.
- `tests/controller-runtime-adapters.test.ts` — preferred new test file for launch-path coverage if a separate controller test file is cleaner.

**Verification**
1. Confirm `POST /api/workers/:workerId/launch` behaves the same for `vscode-copilot` workers before and after the refactor.
2. Confirm unsupported runtimes fail with explicit, predictable errors.
3. Confirm `GET /api/workers` remains backward-compatible and only adds optional fields.
4. Confirm `npm run check` and `npm test` pass.
5. Confirm smoke flows covering provisioning, launch, heartbeat, and review still pass.
6. Confirm JSON and SQLite-backed repositories behave the same because capabilities are derived, not persisted.

**Scope Boundaries**
- Included now: adapter contract, registry, first concrete adapter, placeholder adapters, launch refactor, and launch-focused tests.
- Deferred to follow-up work: capability exposure on read models, dashboard capability UX, and documentation updates.
- Excluded: new runtime implementations beyond placeholders, API renaming, scheduler work, and persistence schema changes.

**Recommended First PR**
1. Add adapter contract and registry.
2. Add `vscode-copilot` plus placeholder adapters.
3. Inject registry into `ControllerService`.
4. Refactor `launchWorker`.
5. Add focused controller tests.

This version is intentionally narrower than the earlier draft. It keeps the first PR centered on the runtime boundary itself, which is the highest-value and highest-risk change.
