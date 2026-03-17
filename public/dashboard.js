const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const EMPTY_STATE = {
  projects: [],
  workers: [],
  tasks: [],
  runs: [],
  artifacts: [],
  events: [],
};

const EMPTY_WORKER_BOARD = {
  items: [],
  includesDiffMetrics: false,
  pagination: {
    total: 0,
    limit: 1,
    offset: 0,
    count: 0,
    hasMore: false,
  },
};

const elements = {
  refreshMeta: document.querySelector("#refresh-meta"),
  healthIndicator: document.querySelector("#health-indicator"),
  snapshotIndicator: document.querySelector("#snapshot-indicator"),
  errorBanner: document.querySelector("#error-banner"),
  liveRegion: document.querySelector("#live-region"),
  summaryGrid: document.querySelector("#summary-grid"),
  createTaskForm: document.querySelector("#create-task-form"),
  provisionWorkerForm: document.querySelector("#provision-worker-form"),
  assignTaskForm: document.querySelector("#assign-task-form"),
  taskProjectSelect: document.querySelector("#task-project-select"),
  taskTitleInput: document.querySelector("#task-title-input"),
  taskDescriptionInput: document.querySelector("#task-description-input"),
  taskPriorityInput: document.querySelector("#task-priority-input"),
  projectSelect: document.querySelector("#project-select"),
  workerNameInput: document.querySelector("#worker-name-input"),
  branchBaseInput: document.querySelector("#branch-base-input"),
  taskSelect: document.querySelector("#task-select"),
  assignTaskSelect: document.querySelector("#assign-task-select"),
  assignWorkerSelect: document.querySelector("#assign-worker-select"),
  workerInsights: document.querySelector("#worker-insights"),
  projectsBody: document.querySelector("#projects-body"),
  workersBody: document.querySelector("#workers-body"),
  tasksBody: document.querySelector("#tasks-body"),
  reviewQueue: document.querySelector("#review-queue"),
  reviewDetail: document.querySelector("#review-detail"),
  eventsList: document.querySelector("#events-list"),
};

let lastSnapshot = structuredClone(EMPTY_STATE);
let lastWorkerBoard = structuredClone(EMPTY_WORKER_BOARD);
let mutationPending = false;
let selectedReviewTaskId = "";
let reviewDetailRequestId = 0;
let reviewNotesByTaskId = {};
let actionAvailability = {
  disableProvision: true,
  disableAssign: true,
};

renderSnapshot(lastSnapshot, lastWorkerBoard);
bindActions();
refresh();
setInterval(refresh, POLL_INTERVAL_MS);

async function refresh() {
  const startedAt = new Date();

  try {
    const [healthResponse, stateResponse, workersResponse] = await Promise.all([
      fetch("/health", { cache: "no-store" }),
      fetch("/api/state", { cache: "no-store" }),
      fetch("/api/workers?includeDiff=false", { cache: "no-store" }),
    ]);

    if (!healthResponse.ok) {
      throw new Error(`Health request failed with ${healthResponse.status}`);
    }

    if (!stateResponse.ok) {
      throw new Error(`State request failed with ${stateResponse.status}`);
    }

    if (!workersResponse.ok) {
      throw new Error(`Workers request failed with ${workersResponse.status}`);
    }

    await healthResponse.json();
    lastSnapshot = await stateResponse.json();
    lastWorkerBoard = await workersResponse.json();
    renderStatus(true, false, startedAt);
    renderSnapshot(lastSnapshot, lastWorkerBoard);
    showError("");
    announce(`Dashboard refreshed at ${formatTime(startedAt.toISOString())}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown refresh failure.";
    renderStatus(false, true, startedAt);
    renderSnapshot(lastSnapshot, lastWorkerBoard);
    showError(`Refresh failed: ${message}`);
    announce(`Refresh failed. ${message}`);
  }
}

function renderStatus(healthy, stale, refreshedAt) {
  elements.refreshMeta.textContent = `Last attempted refresh: ${formatDateTime(refreshedAt.toISOString())}`;
  updateStatusPill(
    elements.healthIndicator,
    healthy ? "Healthy" : "Unavailable",
    healthy ? "status-pill status-pill--healthy" : "status-pill status-pill--error",
  );
  updateStatusPill(
    elements.snapshotIndicator,
    stale ? "Stale Snapshot" : "Live Snapshot",
    stale ? "status-pill status-pill--stale" : "status-pill status-pill--healthy",
  );
}

function renderSnapshot(snapshot, workerBoard) {
  renderSummary(snapshot, workerBoard);
  renderActionForms(snapshot, workerBoard.items);
  renderProjects(snapshot.projects);
  renderWorkers(workerBoard.items);
  renderTasks(snapshot.tasks, workerBoard.items, snapshot.projects);
  renderReviewQueue(snapshot);
  renderEvents(snapshot.events);
}

function renderReviewQueue(snapshot) {
  const reviewTasks = snapshot.tasks.filter((task) => task.status === "review");

  if (reviewTasks.length === 0) {
    selectedReviewTaskId = "";
    elements.reviewQueue.replaceChildren(createEmptyState("No tasks are currently waiting for review."));
    elements.reviewDetail.replaceChildren(createEmptyState("Select a review task to inspect its details and diff summary."));
    return;
  }

  if (!reviewTasks.some((task) => task.id === selectedReviewTaskId)) {
    selectedReviewTaskId = reviewTasks[0].id;
  }

  const cards = reviewTasks.map((task) => {
    const card = document.createElement("article");
    card.className = `review-card${task.id === selectedReviewTaskId ? " review-card--selected" : ""}`;

    const title = document.createElement("h3");
    title.className = "review-card__title";
    title.textContent = task.title;

    const meta = document.createElement("div");
    meta.className = "review-card__meta";
    meta.append(
      statusBadge(task.status),
      statusBadge(task.priority),
      textSpan(formatDateTime(task.updatedAt)),
    );

    const openButton = createActionButton("Inspect", async () => {
      selectedReviewTaskId = task.id;
      renderReviewQueue(lastSnapshot);
      await refreshReviewDetail();
    }, false, true);

    card.append(title, meta, openButton);
    return card;
  });

  elements.reviewQueue.replaceChildren(...cards);
  void refreshReviewDetail();
}

async function refreshReviewDetail() {
  if (!selectedReviewTaskId) {
    elements.reviewDetail.replaceChildren(createEmptyState("Select a review task to inspect its details and diff summary."));
    return;
  }

  const requestId = ++reviewDetailRequestId;
  elements.reviewDetail.replaceChildren(createEmptyState("Loading review detail..."));

  try {
    const detailResponse = await fetch(`/api/tasks/${selectedReviewTaskId}`, { cache: "no-store" });
    if (!detailResponse.ok) {
      throw new Error(`Task detail request failed with ${detailResponse.status}`);
    }

    const detail = await detailResponse.json();
    const latestRun = [...detail.runs].reverse().find((run) => typeof run.workerId === "string");
    let diff;

    if (latestRun?.workerId) {
      const diffResponse = await fetch(`/api/workers/${latestRun.workerId}/diff`, { cache: "no-store" });
      if (diffResponse.ok) {
        diff = await diffResponse.json();
      }
    }

    if (requestId !== reviewDetailRequestId) {
      return;
    }

    renderReviewDetail(detail, diff);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown review detail failure.";
    elements.reviewDetail.replaceChildren(createEmptyState(`Review detail failed: ${message}`));
  }
}

function renderReviewDetail(detail, diff) {
  const wrapper = document.createElement("article");
  wrapper.className = "review-card";
  const currentNotes = reviewNotesByTaskId[detail.task.id] ?? "";
  const latestIntegration = getLatestIntegration(detail.events);

  const title = document.createElement("h3");
  title.className = "review-card__title";
  title.textContent = detail.task.title;

  const description = document.createElement("p");
  description.textContent = detail.task.description;

  const meta = document.createElement("div");
  meta.className = "review-detail__meta";
  meta.append(
    statusBadge(detail.task.status),
    statusBadge(detail.task.priority),
    statusBadge(detail.summary.reviewState ?? "pending"),
    textSpan(`Runs: ${detail.summary.runCount}`),
    textSpan(`Artifacts: ${detail.summary.artifactCount}`),
  );

  const actions = document.createElement("div");
  actions.className = "action-row";

  const notesSection = document.createElement("section");
  notesSection.className = "review-detail__section";

  const notesTitle = document.createElement("h3");
  notesTitle.textContent = "Reviewer Notes";

  const notesHelp = document.createElement("p");
  notesHelp.className = "action-note";
  notesHelp.textContent = "These notes are stored as task artifacts and travel with approve, request changes, or integrate actions.";

  const notesInput = document.createElement("textarea");
  notesInput.className = "review-notes";
  notesInput.placeholder = "Add reviewer context, merge rationale, or requested follow-up work...";
  notesInput.value = currentNotes;
  notesInput.addEventListener("input", () => {
    reviewNotesByTaskId[detail.task.id] = notesInput.value;
  });

  actions.append(
    createReviewActionButton(detail.task.id, "Approve", "approve", `Task ${detail.task.title} approved.`, () => notesInput.value),
    createReviewActionButton(detail.task.id, "Request Changes", "request_changes", `Changes requested for ${detail.task.title}.`, () => notesInput.value),
    createReviewActionButton(detail.task.id, "Integrate", "integrate", `Task ${detail.task.title} integrated.`, () => notesInput.value),
  );

  notesSection.append(notesTitle, notesHelp, notesInput);

  wrapper.append(title, description, meta, notesSection, actions);

  if (latestIntegration) {
    wrapper.append(renderIntegrationSection(latestIntegration));
  }

  if (diff) {
    const diffSection = document.createElement("section");
    diffSection.className = "review-detail__section";

    const diffTitle = document.createElement("h3");
    diffTitle.textContent = "Worker Diff";

    const diffSummary = document.createElement("p");
    diffSummary.textContent = diff.summary;

    const files = document.createElement("div");
    files.className = "review-detail__files";
    const fileEntries = diff.files.slice(0, 8).map((file) => {
      const item = document.createElement("article");
      item.className = "review-file";
      item.append(
        textSpan(file.path, "mono"),
        textSpan(`${file.status} | +${file.additions} / -${file.deletions}`),
      );
      return item;
    });

    if (fileEntries.length === 0) {
      files.append(createEmptyState("No diff files found for the latest worker run."));
    } else {
      files.append(...fileEntries);
    }

    diffSection.append(diffTitle, diffSummary, files);
    wrapper.append(diffSection);
  }

  const artifactsSection = document.createElement("section");
  artifactsSection.className = "review-detail__section";
  const artifactsTitle = document.createElement("h3");
  artifactsTitle.textContent = "Artifacts";
  const artifacts = document.createElement("div");
  artifacts.className = "review-detail__artifacts";
  const artifactEntries = detail.artifacts.slice(-6).reverse().map((artifact) => {
    const item = document.createElement("article");
    item.className = "review-artifact";
    item.append(
      statusBadge(artifact.type),
      textSpan(artifact.pathOrText),
      textSpan(formatDateTime(artifact.createdAt)),
    );
    return item;
  });

  if (artifactEntries.length === 0) {
    artifacts.append(createEmptyState("No artifacts recorded for this task yet."));
  } else {
    artifacts.append(...artifactEntries);
  }

  artifactsSection.append(artifactsTitle, artifacts);
  wrapper.append(artifactsSection);

  elements.reviewDetail.replaceChildren(wrapper);
}

function getLatestIntegration(events) {
  const integrationEvent = [...events]
    .reverse()
    .find((event) => ["TaskIntegrated", "TaskIntegrationBlocked", "TaskIntegrationConflicted"].includes(event.type));

  if (!integrationEvent || typeof integrationEvent.payload !== "object" || integrationEvent.payload === null) {
    return undefined;
  }

  return integrationEvent.payload.integration;
}

function renderIntegrationSection(integration) {
  const section = document.createElement("section");
  section.className = "review-detail__section";

  const title = document.createElement("h3");
  title.textContent = "Latest Integration Attempt";

  const meta = document.createElement("div");
  meta.className = "review-detail__meta";
  meta.append(
    statusBadge(integration.status),
    textSpan(`Target: ${integration.targetBranch}`, "mono"),
    textSpan(`Source: ${integration.sourceBranch}`, "mono"),
  );

  const summary = document.createElement("p");
  summary.textContent = integration.summary;

  const facts = document.createElement("div");
  facts.className = "review-detail__artifacts";
  facts.append(
    createIntegrationFact("Repository", integration.repoPath),
    createIntegrationFact("Head", integration.headSha),
    createIntegrationFact("Generated", formatDateTime(integration.generatedAt)),
  );

  section.append(title, meta, summary, facts);

  if (Array.isArray(integration.conflicts) && integration.conflicts.length > 0) {
    const conflicts = document.createElement("div");
    conflicts.className = "review-detail__files";
    conflicts.append(...integration.conflicts.map((filePath) => {
      const item = document.createElement("article");
      item.className = "review-file";
      item.append(textSpan(filePath, "mono"));
      return item;
    }));
    section.append(conflicts);
  }

  return section;
}

function createIntegrationFact(label, value) {
  const item = document.createElement("article");
  item.className = "review-artifact";
  item.append(textSpan(label), textSpan(value, "mono"));
  return item;
}

function renderActionForms(snapshot, workers) {
  const assignableTasks = getAssignableTasks(snapshot.tasks);

  renderTaskProjectOptions(snapshot.projects);
  renderProjectOptions(snapshot.projects);
  renderProvisionTaskOptions(assignableTasks);
  renderAssignmentTaskOptions(assignableTasks, snapshot.projects);
  renderAssignmentWorkerOptions(getAssignableWorkersForSelectedTask(assignableTasks, workers));

  actionAvailability = {
    disableProvision: snapshot.projects.length === 0,
    disableAssign: assignableTasks.length === 0 || getAssignableWorkersForSelectedTask(assignableTasks, workers).length === 0,
  };

  updateActionDisabledState();
}

function renderSummary(snapshot, workerBoard) {
  const cards = [
    ["Projects", snapshot.projects.length],
    ["Workers", workerBoard.pagination.total],
    ["Tasks", snapshot.tasks.length],
    ["Runs", snapshot.runs.length],
    ["Artifacts", snapshot.artifacts.length],
    ["Events", snapshot.events.length],
  ];

  elements.summaryGrid.replaceChildren(...cards.map(([label, value]) => {
    const card = document.createElement("article");
    card.className = "summary-card";

    const valueNode = document.createElement("p");
    valueNode.className = "summary-card__value";
    valueNode.textContent = String(value);

    const labelNode = document.createElement("p");
    labelNode.className = "summary-card__label";
    labelNode.textContent = label;

    card.append(valueNode, labelNode);
    return card;
  }));
}

function renderProjects(projects) {
  renderTableBody(
    elements.projectsBody,
    projects,
    4,
    "No projects registered yet. Create one through the API to populate this table.",
    (project) => [
      project.name,
      project.defaultBranch,
      asMono(project.repoPath),
      formatDateTime(project.createdAt),
    ],
  );
}

function renderWorkers(workers) {
  renderWorkerInsights(workers);

  renderTableBody(
    elements.workersBody,
    workers,
    11,
    "No workers exist yet. Provision one through the controller to validate worktree orchestration.",
    (worker) => [
      worker.workerName,
      worker.projectName ?? worker.projectId ?? "Unbound",
      statusBadge(worker.status),
      worker.taskTitle ?? worker.taskId ?? "Unassigned",
      asMono(worker.branch),
      asMono(worker.worktreePath),
      worker.processId ? String(worker.processId) : "Not launched",
      renderHeartbeatCell(worker.heartbeatAgeMs, worker.isStale),
      worker.changedFileCount ?? "—",
      formatDateTime(worker.lastSeenAt),
      renderWorkerActions(worker),
    ],
  );
}

function renderWorkerInsights(workers) {
  const counts = {
    active: workers.filter((worker) => worker.status === "active").length,
    blocked: workers.filter((worker) => worker.status === "blocked").length,
    offline: workers.filter((worker) => worker.status === "offline").length,
    stale: workers.filter((worker) => worker.isStale).length,
  };

  const cards = [
    ["Active", counts.active, "status-badge--active", "Current worker count."],
    ["Blocked", counts.blocked, "status-badge--blocked", "Current worker count."],
    ["Offline", counts.offline, "status-badge--offline", "Controller-derived offline workers."],
    ["Stale Heartbeats", counts.stale, counts.stale > 0 ? "status-badge--stale" : "status-badge--fresh", `Derived from a ${Math.round(HEARTBEAT_STALE_MS / 1000)}s timeout.`],
  ];

  elements.workerInsights.replaceChildren(...cards.map(([label, value, badgeClass, description]) => {
    const card = document.createElement("article");
    card.className = "summary-card";

    const valueRow = document.createElement("div");
    valueRow.className = "timeline__meta";

    const valueNode = document.createElement("p");
    valueNode.className = "summary-card__value";
    valueNode.textContent = String(value);

    const badge = document.createElement("span");
    badge.className = `status-badge ${badgeClass}`;
    badge.textContent = label;

    const labelNode = document.createElement("p");
    labelNode.className = "summary-card__label";
    labelNode.textContent = description;

    valueRow.append(valueNode, badge);
    card.append(valueRow, labelNode);
    return card;
  }));
}

function renderTasks(tasks, workers, projects) {
  const workerMap = new Map(workers.map((worker) => [worker.workerId, worker]));
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));

  renderTableBody(
    elements.tasksBody,
    tasks,
    8,
    "No tasks exist yet. Create a task to validate assignment and dashboard refresh.",
    (task) => {
      const assignedWorker = task.assignedWorkerId ? workerMap.get(task.assignedWorkerId) : undefined;
      return [
        task.title,
        task.projectId ? projectMap.get(task.projectId) ?? task.projectId : "Unbound",
        statusBadge(task.status),
        statusBadge(task.priority),
        assignedWorker ? assignedWorker.workerName : task.assignedWorkerId ?? "Unassigned",
        formatDateTime(task.createdAt),
        formatDateTime(task.updatedAt),
        renderTaskActions(task, workers),
      ];
    },
  );
}

function renderEvents(events) {
  const recentEvents = [...events].slice(-12).reverse();

  if (recentEvents.length === 0) {
    elements.eventsList.replaceChildren(createEmptyState("No events recorded yet. New controller actions will appear here."));
    return;
  }

  elements.eventsList.replaceChildren(...recentEvents.map((event) => {
    const item = document.createElement("li");
    item.className = "timeline__item";

    const title = document.createElement("h3");
    title.textContent = event.type;

    const meta = document.createElement("div");
    meta.className = "timeline__meta";
    meta.append(
      statusBadge(event.entityType),
      textSpan(formatDateTime(event.ts)),
      textSpan(event.entityId, "mono"),
    );

    item.append(title, meta);
    return item;
  }));
}

function renderTableBody(container, rows, colSpan, emptyMessage, renderRow) {
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = colSpan;
    cell.append(createEmptyState(emptyMessage));
    row.append(cell);
    container.replaceChildren(row);
    return;
  }

  container.replaceChildren(...rows.map((rowData) => {
    const row = document.createElement("tr");
    const cells = renderRow(rowData);

    for (const value of cells) {
      const cell = document.createElement("td");
      if (value instanceof Node) {
        cell.append(value);
      } else {
        cell.textContent = String(value);
      }
      row.append(cell);
    }

    return row;
  }));
}

function createEmptyState(message) {
  const box = document.createElement("li");
  box.className = "empty-state";
  box.textContent = message;
  return box;
}

function renderTaskProjectOptions(projects) {
  const previousValue = elements.taskProjectSelect.value;
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "No project binding";

  const options = projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} (${project.defaultBranch})`;
    return option;
  });

  elements.taskProjectSelect.replaceChildren(emptyOption, ...options);
  const stillExists = projects.some((project) => project.id === previousValue);
  elements.taskProjectSelect.value = stillExists ? previousValue : "";
}

function renderProjectOptions(projects) {
  const previousValue = elements.projectSelect.value;
  const options = projects.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} (${project.defaultBranch})`;
    return option;
  });

  if (options.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No projects available";
    elements.projectSelect.replaceChildren(option);
    elements.projectSelect.value = "";
    return;
  }

  elements.projectSelect.replaceChildren(...options);
  const stillExists = projects.some((project) => project.id === previousValue);
  elements.projectSelect.value = stillExists ? previousValue : projects[0].id;
}

function renderProvisionTaskOptions(tasks) {
  const projectId = elements.projectSelect.value;
  const previousValue = elements.taskSelect.value;
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "No task attached";

  const compatibleTasks = tasks.filter((task) => task.projectId === projectId);

  const options = compatibleTasks.map((task) => {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${task.title} (${humanize(task.status)})`;
    return option;
  });

  elements.taskSelect.replaceChildren(emptyOption, ...options);
  const stillExists = compatibleTasks.some((task) => task.id === previousValue);
  elements.taskSelect.value = stillExists ? previousValue : "";
}

function renderAssignmentTaskOptions(tasks, projects) {
  const previousValue = elements.assignTaskSelect.value;
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));

  if (tasks.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No assignable tasks";
    elements.assignTaskSelect.replaceChildren(option);
    elements.assignTaskSelect.value = "";
    return;
  }

  const options = tasks.map((task) => {
    const option = document.createElement("option");
    option.value = task.id;
    const projectLabel = task.projectId ? projectMap.get(task.projectId) ?? task.projectId : "unbound";
    option.textContent = `${task.title} (${projectLabel}, ${humanize(task.status)})`;
    return option;
  });

  elements.assignTaskSelect.replaceChildren(...options);
  const stillExists = tasks.some((task) => task.id === previousValue);
  elements.assignTaskSelect.value = stillExists ? previousValue : tasks[0].id;
}

function renderAssignmentWorkerOptions(workers) {
  const previousValue = elements.assignWorkerSelect.value;

  if (workers.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No compatible workers";
    elements.assignWorkerSelect.replaceChildren(option);
    elements.assignWorkerSelect.value = "";
    return;
  }

  const options = workers.map((worker) => {
    const option = document.createElement("option");
    option.value = worker.workerId;
    const projectLabel = worker.projectName ?? worker.projectId ?? "unbound";
    option.textContent = `${worker.workerName} (${projectLabel}, ${humanize(worker.status)})`;
    return option;
  });

  elements.assignWorkerSelect.replaceChildren(...options);
  const stillExists = workers.some((worker) => worker.workerId === previousValue);
  elements.assignWorkerSelect.value = stillExists ? previousValue : workers[0].workerId;
}

function renderWorkerActions(worker) {
  const wrapper = document.createElement("div");
  wrapper.className = "action-stack";

  const actionRow = document.createElement("div");
  actionRow.className = "action-row";

  const launchButton = createActionButton("Launch", async () => {
    await mutateJson(`/api/workers/${worker.workerId}/launch`, { method: "POST" }, `Worker ${worker.workerName} launched.`);
  }, worker.processId !== undefined);

  const syncButton = createActionButton("Sync", async () => {
    await mutateJson(
      `/api/workers/${worker.workerId}/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      `Worker ${worker.workerName} synced with the default branch.`,
    );
  }, false, true);

  actionRow.append(launchButton, syncButton);

  const heartbeatRow = document.createElement("div");
  heartbeatRow.className = "action-row";
  heartbeatRow.append(
    createHeartbeatButton(worker, "idle"),
    createHeartbeatButton(worker, "active"),
    createHeartbeatButton(worker, "blocked"),
  );

  wrapper.append(actionRow, heartbeatRow);

  if (worker.lastSyncSummary) {
    const note = document.createElement("p");
    note.className = "action-note";
    note.textContent = worker.lastSyncSummary;
    wrapper.append(note);
  }

  return wrapper;
}

function createHeartbeatButton(worker, status) {
  return createActionButton(humanize(status), async () => {
    await mutateJson(
      `/api/workers/${worker.workerId}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      },
      `Worker ${worker.workerName} heartbeat set to ${status}.`,
    );
  }, false, true);
}

function createActionButton(label, handler, disabled = false, ghost = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = ghost ? "button button--mini button--secondary button--ghost" : "button button--mini";
  button.dataset.dashboardAction = "true";
  button.dataset.baseDisabled = String(disabled);
  button.disabled = disabled || mutationPending;
  button.textContent = label;
  button.addEventListener("click", () => {
    void handler();
  });
  return button;
}

function bindActions() {
  elements.createTaskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitCreateTask();
  });

  elements.projectSelect.addEventListener("change", () => {
    syncProvisionTaskOptions();
  });

  elements.assignTaskSelect.addEventListener("change", () => {
    syncAssignmentWorkerOptions();
  });

  elements.provisionWorkerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProvisionWorker();
  });

  elements.assignTaskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitAssignTask();
  });
}

async function submitCreateTask() {
  const title = elements.taskTitleInput.value.trim();
  const description = elements.taskDescriptionInput.value.trim();
  const priority = elements.taskPriorityInput.value;
  const projectId = elements.taskProjectSelect.value;

  if (!title || !description) {
    showError("Task title and description are required.");
    announce("Task title and description are required.");
    return;
  }

  await mutateJson(
    "/api/tasks",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, priority, ...(projectId ? { projectId } : {}) }),
    },
    `Task ${title} created.`,
  );

  elements.createTaskForm.reset();
  elements.taskPriorityInput.value = "medium";
  elements.taskProjectSelect.value = "";
}

async function submitProvisionWorker() {
  const projectId = elements.projectSelect.value;
  const workerName = elements.workerNameInput.value.trim();
  const branchBase = elements.branchBaseInput.value.trim();
  const taskId = elements.taskSelect.value;

  if (!projectId || !workerName) {
    showError("Project and worker name are required to provision a worker.");
    announce("Project and worker name are required to provision a worker.");
    return;
  }

  const payload = {
    workerName,
    ...(branchBase ? { branchBase } : {}),
    ...(taskId ? { taskId } : {}),
  };

  await mutateJson(
    `/api/projects/${projectId}/worktrees`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    `Worker ${workerName} provisioned.`,
  );

  elements.provisionWorkerForm.reset();
  renderProjectOptions(lastSnapshot.projects);
  renderProvisionTaskOptions(getAssignableTasks(lastSnapshot.tasks));
}

async function submitAssignTask() {
  const taskId = elements.assignTaskSelect.value;
  const workerId = elements.assignWorkerSelect.value;

  if (!taskId || !workerId) {
    showError("Task and worker are required to create an assignment.");
    announce("Task and worker are required to create an assignment.");
    return;
  }

  const task = lastSnapshot.tasks.find((entry) => entry.id === taskId);
  const worker = lastWorkerBoard.items.find((entry) => entry.workerId === workerId);

  await mutateJson(
    "/api/assignments",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, workerId }),
    },
    `Task ${task?.title ?? taskId} assigned to ${worker?.workerName ?? workerId}.`,
  );
}

async function mutateJson(url, options, successMessage) {
  setMutationPending(true);

  try {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
    });

    if (!response.ok) {
      const errorBody = await safeReadJson(response);
      const message = errorBody?.error ?? `Request failed with ${response.status}`;
      throw new Error(message);
    }

    const responseBody = await safeReadJson(response);

    await refresh();
    showError("");
    announce(typeof successMessage === "function" ? successMessage(responseBody) : successMessage);
    return responseBody;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mutation failure.";
    showError(`Action failed: ${message}`);
    announce(`Action failed. ${message}`);
    return undefined;
  } finally {
    setMutationPending(false);
  }
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function setMutationPending(value) {
  mutationPending = value;
  updateActionDisabledState();
}

function updateActionDisabledState() {
  const disableProvision = mutationPending || actionAvailability.disableProvision;
  const disableTaskCreate = mutationPending;
  const disableAssign = mutationPending || actionAvailability.disableAssign;

  for (const element of Array.from(elements.createTaskForm.elements)) {
    element.disabled = disableTaskCreate;
  }

  for (const element of Array.from(elements.provisionWorkerForm.elements)) {
    element.disabled = disableProvision;
  }

  for (const element of Array.from(elements.assignTaskForm.elements)) {
    element.disabled = disableAssign;
  }

  for (const element of document.querySelectorAll("[data-dashboard-action='true']")) {
    element.disabled = mutationPending || element.dataset.baseDisabled === "true";
  }
}

function renderTaskActions(task, workers) {
  if (["done", "canceled"].includes(task.status)) {
    return textSpan("Closed", "action-note");
  }

  if (task.status === "review") {
    return createTaskLifecycleActions(task, [
      ["Complete", "complete", `Task ${task.title} completed.`],
      ["Cancel", "cancel", `Task ${task.title} canceled.`],
    ]);
  }

  if (task.assignedWorkerId) {
    return createTaskLifecycleActions(task, [
      ["Unassign", "unassign", `Task ${task.title} returned to the queue.`],
      ["Block", "block", `Task ${task.title} marked as blocked.`],
      ["Review", "review", `Task ${task.title} moved to review.`],
      ["Complete", "complete", `Task ${task.title} completed.`],
      ["Cancel", "cancel", `Task ${task.title} canceled.`],
    ]);
  }

  const availableWorkers = getCompatibleAvailableWorkers(task, workers);
  if (availableWorkers.length === 0 && task.status !== "blocked") {
    return textSpan("No compatible workers", "action-note");
  }

  if (task.status === "blocked" && availableWorkers.length === 0) {
    return createTaskLifecycleActions(task, [
      ["Cancel", "cancel", `Task ${task.title} canceled.`],
    ]);
  }

  const wrapper = document.createElement("div");
  wrapper.className = "action-row";

  const select = document.createElement("select");
  select.className = "inline-select";
  select.dataset.dashboardAction = "true";
  select.dataset.baseDisabled = "false";

  for (const worker of availableWorkers) {
    const option = document.createElement("option");
    option.value = worker.workerId;
    option.textContent = worker.workerName;
    select.append(option);
  }

  const assignButton = createActionButton("Assign", async () => {
    const selectedWorker = availableWorkers.find((worker) => worker.workerId === select.value);
    await mutateJson(
      "/api/assignments",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: task.id, workerId: select.value }),
      },
      `Task ${task.title} assigned to ${selectedWorker?.workerName ?? select.value}.`,
    );
  }, false, true);

  wrapper.append(select, assignButton);

  if (task.status === "blocked") {
    wrapper.append(
      createTaskTransitionButton(task, "Cancel", "cancel", `Task ${task.title} canceled.`),
    );
  }

  return wrapper;
}

function getAssignableTasks(tasks) {
  return tasks.filter((task) => !task.assignedWorkerId && !["done", "canceled", "review"].includes(task.status));
}

function getAvailableWorkers(workers) {
  return workers.filter((worker) => !worker.taskId);
}

function areTaskAndWorkerCompatible(task, worker) {
  if (!task.projectId && !worker.projectId) {
    return true;
  }

  return Boolean(task.projectId && worker.projectId && task.projectId === worker.projectId);
}

function getCompatibleAvailableWorkers(task, workers) {
  return getAvailableWorkers(workers).filter((worker) => areTaskAndWorkerCompatible(task, worker));
}

function getAssignableWorkersForSelectedTask(tasks, workers) {
  const selectedTaskId = elements.assignTaskSelect.value;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];

  if (!selectedTask) {
    return [];
  }

  return getCompatibleAvailableWorkers(selectedTask, workers);
}

function syncProvisionTaskOptions() {
  renderProvisionTaskOptions(getAssignableTasks(lastSnapshot.tasks));
}

function syncAssignmentWorkerOptions() {
  const assignableTasks = getAssignableTasks(lastSnapshot.tasks);
  renderAssignmentWorkerOptions(getAssignableWorkersForSelectedTask(assignableTasks, lastWorkerBoard.items));
  actionAvailability = {
    ...actionAvailability,
    disableAssign: assignableTasks.length === 0 || getAssignableWorkersForSelectedTask(assignableTasks, lastWorkerBoard.items).length === 0,
  };
  updateActionDisabledState();
}

function createTaskLifecycleActions(task, actions) {
  const wrapper = document.createElement("div");
  wrapper.className = "action-row";

  for (const [label, action, successMessage] of actions) {
    wrapper.append(createTaskTransitionButton(task, label, action, successMessage));
  }

  return wrapper;
}

function createTaskTransitionButton(task, label, action, successMessage) {
  return createActionButton(label, async () => {
    await mutateJson(
      `/api/tasks/${task.id}/transitions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      },
      successMessage,
    );
  }, false, true);
}

function createReviewActionButton(taskId, label, action, successMessage, getNotes = () => "") {
  return createActionButton(label, async () => {
    const notes = getNotes().trim();
    const response = await mutateJson(
      `/api/tasks/${taskId}/review`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(notes ? { notes } : {}) }),
      },
      (body) => body?.integration?.summary ?? successMessage,
    );

    if (response && notes) {
      reviewNotesByTaskId[taskId] = "";
    }
  }, false, true);
}

function statusBadge(value) {
  const badge = document.createElement("span");
  badge.className = `status-badge status-badge--${String(value)}`;
  badge.textContent = humanize(value);
  return badge;
}

function asMono(value) {
  return textSpan(value, "mono");
}

function renderHeartbeatCell(heartbeatAgeMs, isStale) {
  const heartbeat = getHeartbeatState(heartbeatAgeMs, isStale);
  const wrapper = document.createElement("div");
  wrapper.className = "heartbeat-cell";

  const badge = document.createElement("span");
  badge.className = `status-badge status-badge--${heartbeat.tone}`;
  badge.textContent = heartbeat.label;

  const meta = document.createElement("span");
  meta.className = "heartbeat-cell__meta";
  meta.textContent = heartbeat.meta;

  wrapper.append(badge, meta);
  return wrapper;
}

function getHeartbeatState(heartbeatAgeMs, isStale) {
  if (!Number.isFinite(heartbeatAgeMs)) {
    return {
      label: "Unknown",
      tone: "unknown",
      meta: "No valid heartbeat timestamp.",
    };
  }

  if (isStale) {
    return {
      label: "Stale",
      tone: "stale",
      meta: `${formatRelativeAge(heartbeatAgeMs)} ago`,
    };
  }

  if (heartbeatAgeMs >= HEARTBEAT_STALE_MS / 2) {
    return {
      label: "Aging",
      tone: "aging",
      meta: `${formatRelativeAge(heartbeatAgeMs)} ago`,
    };
  }

  return {
    label: "Fresh",
    tone: "fresh",
    meta: `${formatRelativeAge(heartbeatAgeMs)} ago`,
  };
}

function textSpan(value, className = "") {
  const node = document.createElement("span");
  node.textContent = String(value);
  if (className) {
    node.className = className;
  }
  return node;
}

function showError(message) {
  if (!message) {
    elements.errorBanner.hidden = true;
    elements.errorBanner.textContent = "";
    return;
  }

  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = message;
}

function announce(message) {
  elements.liveRegion.textContent = message;
}

function updateStatusPill(node, label, className) {
  node.className = className;
  node.textContent = label;
}

function formatDateTime(value) {
  if (!value) {
    return "—";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatTime(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatRelativeAge(ageMs) {
  const totalSeconds = Math.round(ageMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours}h`;
}

function humanize(value) {
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}