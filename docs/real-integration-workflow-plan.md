## Plan: Real Integration Workflow

The next recommended slice is to turn review `integrate` from a state-only action into a real repository integration workflow. Today the system can create, assign, review, approve, and mark work as integrated, but it does not actually merge worker changes back into the project repository. The most pragmatic sequence is: add project-aware integration orchestration, expose the result in the existing review API/dashboard, then lock it down with deterministic tests and a smoke path.

**Steps**
1. Phase 1: Define the integration contract in the domain and application layers. Extend the review action result so `integrate` can return a structured git outcome such as integrated, conflicted, or blocked. This step blocks all later implementation.
2. Phase 1: Reuse the existing git command patterns in `WorktreeManager` to add a dedicated integration operation for a reviewed worker branch back into the project default branch. Start with a conservative local-first strategy: fetch, verify clean target state, merge worker branch, capture conflict paths, and avoid destructive cleanup on the first iteration. This depends on step 1.
3. Phase 1: Thread project and worker context through the review path so `ControllerService.reviewTask` can resolve the exact repository, worktree, and branch to integrate. Persist an auditable event payload with branch, target branch, resulting HEAD SHA, and conflict summary. This depends on steps 1 and 2.
4. Phase 2: Update the existing `POST /api/tasks/:taskId/review` integrate path to return the structured integration result without changing the route shape. Keep approve and request-changes behavior intact. This depends on step 3.
5. Phase 2: Update the dashboard review panel so the Integrate action shows meaningful success or conflict feedback, including the target branch, resulting commit, and any conflicted files. This can run in parallel with step 4 once the response contract is fixed.
6. Phase 2: Decide and document the first-pass post-integration policy. Recommended initial policy: mark task `done` only when merge succeeds; leave task in `review` on conflict; do not auto-delete worktrees or branches yet. This depends on steps 3 and 4.
7. Phase 3: Add focused automated coverage for the transition matrix around integration success and conflict handling, plus extend the existing review smoke script to verify an actual git integration outcome rather than only a task status change. This depends on steps 4 through 6.

**Relevant files**
- `c:\Vibe coding\claw\open-agent-center.git-mainline\src\services\worktreeManager.ts` — add the integration git operation using the existing `execFileAsync`, branch resolution, and conflict parsing patterns.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\src\application\controllerService.ts` — move `reviewTask` from state-only orchestration to repository-aware integration orchestration for the `integrate` action.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\src\services\stateStore.ts` — change `reviewTask` persistence rules so success and conflict outcomes are recorded correctly and task status is not advanced prematurely.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\src\domain\types.ts` — extend review and integration result types, event payload expectations, and any structured merge outcome types.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\src\routes\api.ts` — preserve the current review route while returning the richer integrate response.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\src\queries\taskQueries.ts` — surface enough task detail or summary state for the dashboard to reflect integration outcome and any pending conflict state.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\public\dashboard.js` — update review action handling and detail rendering for integrate success/conflict feedback.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\public\dashboard.html` — only minimal UI changes should be needed if the existing review panel is reused.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\public\dashboard.css` — add only the styles needed for integration outcome messaging if existing review styles are insufficient.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\scripts\smoke-review-queue.ps1` — extend the current happy-path scenario so it verifies real repository integration behavior.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\package.json` — add or adjust any script entry points for the new verification flow.
- `c:\Vibe coding\claw\open-agent-center.git-mainline\README.md` — document the new operator behavior, especially what Integrate now does and how conflicts are reported.

**Verification**
1. Confirm `integrate` performs a real git operation against the project default branch instead of only mutating task state.
2. Confirm successful integration records structured output: source branch, target branch, resulting HEAD SHA, and a success summary.
3. Confirm merge conflicts do not mark the task `done`, and that conflicted file paths are visible through the API and dashboard.
4. Confirm `npm run check` passes after the contract changes.
5. Confirm the review smoke flow validates actual integration behavior, not just state transitions.
6. Confirm no destructive cleanup occurs automatically after integration in the first iteration.

**Decisions**
- Included scope: real local repository integration for reviewed work, conflict reporting, dashboard visibility, and focused verification.
- Excluded scope: automatic remote push, automatic PR creation from inside the controller, worktree deletion, branch deletion, and advanced merge policy selection.
- Recommended first-pass behavior: keep the integration strategy conservative and auditable rather than trying to automate every cleanup step.
- Recommended follow-up after this slice: add project-scoped task/worker ownership constraints if integration needs stronger repository resolution guarantees.

**Further Considerations**
1. If you want a lower-risk slice before real integration, the fallback next step is a focused automated test layer around `StateStore` and `ControllerService`; that improves safety but does not close the operator loop.
2. If project resolution turns out ambiguous during implementation, introduce explicit `projectId` ownership on tasks and workers before finalizing integration semantics.
3. Keep using GitHub API for remote PR creation when needed; git transport on this machine is still unreliable.