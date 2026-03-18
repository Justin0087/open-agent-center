param(
  [string]$BaseUrl = "http://127.0.0.1:4317",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DefaultBranch = "main",
  [ValidateSet("success", "blocked")]
  [string]$Scenario = "success"
)

$ErrorActionPreference = "Stop"

function Invoke-JsonRequest {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("GET", "POST")]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [object]$Body
  )

  $requestArgs = @{
    Method = $Method
    Uri = $Uri
    Headers = @{ "Content-Type" = "application/json" }
    NoProxy = $true
  }

  if ($PSBoundParameters.ContainsKey("Body")) {
    $requestArgs.Body = ($Body | ConvertTo-Json -Depth 8)
  }

  return Invoke-RestMethod @requestArgs
}

function Invoke-JsonRequestAllowError {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("GET", "POST")]
    [string]$Method,

    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [object]$Body
  )

  $requestArgs = @{
    Method = $Method
    Uri = $Uri
    Headers = @{ "Content-Type" = "application/json" }
    NoProxy = $true
    SkipHttpErrorCheck = $true
  }

  if ($PSBoundParameters.ContainsKey("Body")) {
    $requestArgs.Body = ($Body | ConvertTo-Json -Depth 8)
  }

  $response = Invoke-WebRequest @requestArgs
  $parsedBody = $null

  if ($response.Content) {
    try {
      $parsedBody = $response.Content | ConvertFrom-Json
    } catch {
      $parsedBody = $response.Content
    }
  }

  return [pscustomobject]@{
    StatusCode = [int]$response.StatusCode
    Body = $parsedBody
  }
}

$projectName = "smoke-open-agent-center-project-archive-$Scenario"

Write-Host "Checking controller health at $BaseUrl ..." -ForegroundColor Cyan
$health = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/health"

if (-not $health.ok) {
  throw "Controller health check failed."
}

Write-Host "Registering smoke archive project for repo: $RepoPath" -ForegroundColor Cyan
$project = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects" -Body @{
  name = $projectName
  repoPath = $RepoPath
  defaultBranch = $DefaultBranch
}

if ($Scenario -eq "blocked") {
  $workerName = "archive-blocker-worker"
  $taskTitle = "Archive blocker task"
  $taskDescription = "Verify project archive is rejected while project work remains active."
  $tempWorktreePath = Join-Path $env:TEMP ("open-agent-center-archive-blocker-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tempWorktreePath | Out-Null

  Write-Host "Creating project-bound worker and task to force blocked project archive..." -ForegroundColor Cyan
  $worker = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers" -Body @{
    name = $workerName
    projectId = $project.id
    worktreePath = $tempWorktreePath
    assignedBranch = "task/archive-blocker-worker"
  }

  $task = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks" -Body @{
    title = $taskTitle
    description = $taskDescription
    priority = "medium"
    projectId = $project.id
  }

  $null = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/assignments" -Body @{
    taskId = $task.id
    workerId = $worker.id
  }

  Write-Host "Calling project archive API and expecting a blocked response..." -ForegroundColor Cyan
  $archiveAttempt = Invoke-JsonRequestAllowError -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/archive"

  if ($archiveAttempt.StatusCode -ne 409) {
    throw "Expected blocked project archive HTTP 409, got $($archiveAttempt.StatusCode)."
  }

  if ($archiveAttempt.Body.errorCode -ne "PROJECT_ARCHIVE_BLOCKED") {
    throw "Expected PROJECT_ARCHIVE_BLOCKED, got $($archiveAttempt.Body.errorCode)."
  }

  Write-Host "Fetching controller snapshot to confirm blocked event payload and linked entities..." -ForegroundColor Cyan
  $state = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/state"
  $persistedProject = $state.projects | Where-Object { $_.id -eq $project.id } | Select-Object -First 1
  $blockedEvent = @($state.events | Where-Object { $_.type -eq "ProjectArchiveBlocked" -and $_.entityId -eq $project.id })[-1]
  $persistedWorker = $state.workers | Where-Object { $_.id -eq $worker.id } | Select-Object -First 1
  $persistedTask = $state.tasks | Where-Object { $_.id -eq $task.id } | Select-Object -First 1

  if (-not $persistedProject) {
    throw "Blocked archive project was not found in controller state."
  }

  if ($persistedProject.archivedAt) {
    throw "Blocked archive project should not be archived, but archivedAt was set to $($persistedProject.archivedAt)."
  }

  if (-not $blockedEvent) {
    throw "ProjectArchiveBlocked event was not found in controller state."
  }

  if ($blockedEvent.payload.projectId -ne $project.id) {
    throw "Blocked event project mismatch. Expected $($project.id), got $($blockedEvent.payload.projectId)."
  }

  if (($blockedEvent.payload.blockingWorkerIds -notcontains $worker.id) -or ($blockedEvent.payload.blockingTaskIds -notcontains $task.id)) {
    throw "Blocked event did not reference the expected worker/task blockers."
  }

  if ($persistedWorker.name -ne $workerName) {
    throw "Blocked worker name mismatch. Expected $workerName, got $($persistedWorker.name)."
  }

  if ($persistedTask.title -ne $taskTitle) {
    throw "Blocked task title mismatch. Expected '$taskTitle', got '$($persistedTask.title)'."
  }

  Write-Host "Blocked project archive smoke test passed." -ForegroundColor Green
  Write-Host "Project ID:      $($project.id)"
  Write-Host "Worker ID:       $($worker.id)"
  Write-Host "Task ID:         $($task.id)"
  Write-Host "Error Code:      $($archiveAttempt.Body.errorCode)"
} else {
  Write-Host "Archiving clean project through project archive API..." -ForegroundColor Cyan
  $archiveResult = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/archive"

  if ($archiveResult.project.id -ne $project.id) {
    throw "Archive response project mismatch. Expected $($project.id), got $($archiveResult.project.id)."
  }

  if (-not $archiveResult.project.archivedAt) {
    throw "Archive response did not include archivedAt for the project."
  }

  if ($archiveResult.archive.status -ne "archived") {
    throw "Archive response status mismatch. Expected archived, got $($archiveResult.archive.status)."
  }

  Write-Host "Fetching controller snapshot to confirm archived state..." -ForegroundColor Cyan
  $state = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/state"
  $persistedProject = $state.projects | Where-Object { $_.id -eq $project.id } | Select-Object -First 1

  if (-not $persistedProject.archivedAt) {
    throw "Persisted project did not report archivedAt after successful archive."
  }

  Write-Host "Verifying archived projects reject new work..." -ForegroundColor Cyan
  $taskAttempt = Invoke-JsonRequestAllowError -Method POST -Uri "$BaseUrl/api/tasks" -Body @{
    title = "Should fail"
    description = "Archived projects must reject new tasks."
    projectId = $project.id
  }

  if ($taskAttempt.StatusCode -ne 409 -or $taskAttempt.Body.errorCode -ne "PROJECT_ARCHIVED") {
    throw "Expected task creation to fail with PROJECT_ARCHIVED, got status $($taskAttempt.StatusCode) and code $($taskAttempt.Body.errorCode)."
  }

  $workerAttempt = Invoke-JsonRequestAllowError -Method POST -Uri "$BaseUrl/api/workers" -Body @{
    name = "archived-project-worker"
    projectId = $project.id
    worktreePath = (Join-Path $env:TEMP "open-agent-center-archived-project-worker")
    assignedBranch = "task/archived-project-worker"
  }

  if ($workerAttempt.StatusCode -ne 409 -or $workerAttempt.Body.errorCode -ne "PROJECT_ARCHIVED") {
    throw "Expected worker creation to fail with PROJECT_ARCHIVED, got status $($workerAttempt.StatusCode) and code $($workerAttempt.Body.errorCode)."
  }

  $worktreeAttempt = Invoke-JsonRequestAllowError -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/worktrees" -Body @{
    workerName = "archived-project-worktree"
  }

  if ($worktreeAttempt.StatusCode -ne 409 -or $worktreeAttempt.Body.errorCode -ne "PROJECT_ARCHIVED") {
    throw "Expected worktree provisioning to fail with PROJECT_ARCHIVED, got status $($worktreeAttempt.StatusCode) and code $($worktreeAttempt.Body.errorCode)."
  }

  Write-Host "Project archive smoke test passed." -ForegroundColor Green
  Write-Host "Project ID:      $($project.id)"
  Write-Host "Archived At:     $($persistedProject.archivedAt)"
  Write-Host "Task Reject:     $($taskAttempt.Body.errorCode)"
  Write-Host "Worker Reject:   $($workerAttempt.Body.errorCode)"
  Write-Host "Worktree Reject: $($worktreeAttempt.Body.errorCode)"
}