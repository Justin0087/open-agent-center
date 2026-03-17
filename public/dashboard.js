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
  taskTitleInput: document.querySelector("#task-title-input"),
  taskDescriptionInput: document.querySelector("#task-description-input"),
  taskPriorityInput: document.querySelector("#task-priority-input"),
  projectSelect: document.querySelector("#project-select"),
  workerNameInput: document.querySelector("#worker-name-input"),
  branchBaseInput: document.querySelector("#branch-base-input"),
  taskSelect: document.querySelector("#task-select"),
  workerInsights: document.querySelector("#worker-insights"),
  projectsBody: document.querySelector("#projects-body"),
  workersBody: document.querySelector("#workers-body"),
  tasksBody: document.querySelector("#tasks-body"),
  eventsList: document.querySelector("#events-list"),
};

let lastSnapshot = structuredClone(EMPTY_STATE);
let lastWorkerBoard = structuredClone(EMPTY_WORKER_BOARD);
let mutationPending = false;

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
  renderActionForms(snapshot);
  renderProjects(snapshot.projects);
  renderWorkers(workerBoard.items);
  renderTasks(snapshot.tasks, workerBoard.items);
  renderEvents(snapshot.events);
}

function renderActionForms(snapshot) {
  renderProjectOptions(snapshot.projects);
  renderTaskOptions(snapshot.tasks);
  updateActionDisabledState(snapshot.projects.length === 0);
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
    10,
    "No workers exist yet. Provision one through the controller to validate worktree orchestration.",
    (worker) => [
      worker.workerName,
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

function renderTasks(tasks, workers) {
  const workerMap = new Map(workers.map((worker) => [worker.workerId, worker]));

  renderTableBody(
    elements.tasksBody,
    tasks,
    6,
    "No tasks exist yet. Create a task to validate assignment and dashboard refresh.",
    (task) => {
      const assignedWorker = task.assignedWorkerId ? workerMap.get(task.assignedWorkerId) : undefined;
      return [
        task.title,
        statusBadge(task.status),
        statusBadge(task.priority),
        assignedWorker ? assignedWorker.workerName : task.assignedWorkerId ?? "Unassigned",
        formatDateTime(task.createdAt),
        formatDateTime(task.updatedAt),
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

function renderTaskOptions(tasks) {
  const previousValue = elements.taskSelect.value;
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "No task attached";

  const options = tasks.map((task) => {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${task.title} (${humanize(task.status)})`;
    return option;
  });

  elements.taskSelect.replaceChildren(emptyOption, ...options);
  const stillExists = tasks.some((task) => task.id === previousValue);
  elements.taskSelect.value = stillExists ? previousValue : "";
}

function renderWorkerActions(worker) {
  const wrapper = document.createElement("div");
  wrapper.className = "action-stack";

  const launchButton = createActionButton("Launch", async () => {
    await mutateJson(`/api/workers/${worker.workerId}/launch`, { method: "POST" }, `Worker ${worker.workerName} launched.`);
  }, worker.processId !== undefined);

  const heartbeatRow = document.createElement("div");
  heartbeatRow.className = "action-row";
  heartbeatRow.append(
    createHeartbeatButton(worker, "idle"),
    createHeartbeatButton(worker, "active"),
    createHeartbeatButton(worker, "blocked"),
  );

  wrapper.append(launchButton, heartbeatRow);
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

  elements.provisionWorkerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitProvisionWorker();
  });
}

async function submitCreateTask() {
  const title = elements.taskTitleInput.value.trim();
  const description = elements.taskDescriptionInput.value.trim();
  const priority = elements.taskPriorityInput.value;

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
      body: JSON.stringify({ title, description, priority }),
    },
    `Task ${title} created.`,
  );

  elements.createTaskForm.reset();
  elements.taskPriorityInput.value = "medium";
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
  renderTaskOptions(lastSnapshot.tasks);
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

    await refresh();
    showError("");
    announce(successMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mutation failure.";
    showError(`Action failed: ${message}`);
    announce(`Action failed. ${message}`);
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
  updateActionDisabledState(lastSnapshot.projects.length === 0);
}

function updateActionDisabledState(noProjects) {
  const disableProvision = mutationPending || noProjects;
  const disableTaskCreate = mutationPending;

  for (const element of Array.from(elements.createTaskForm.elements)) {
    element.disabled = disableTaskCreate;
  }

  for (const element of Array.from(elements.provisionWorkerForm.elements)) {
    element.disabled = disableProvision;
  }

  for (const button of elements.workersBody.querySelectorAll("[data-dashboard-action='true']")) {
    button.disabled = mutationPending;
  }
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