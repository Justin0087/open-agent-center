param(
  [string]$BaseUrl = "http://127.0.0.1:4317",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DefaultBranch = "main",
  [string]$WorkerName = "cleanup-smoke-worker",
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

$projectName = "smoke-open-agent-center-cleanup-$Scenario"
$taskTitle = "Cleanup blocked smoke task"
$taskDescription = "Verify cleanup is rejected while a worker is assigned."

Write-Host "Checking controller health at $BaseUrl ..." -ForegroundColor Cyan
$health = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/health"

if (-not $health.ok) {
  throw "Controller health check failed."
}

Write-Host "Registering smoke cleanup project for repo: $RepoPath" -ForegroundColor Cyan
$project = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects" -Body @{
  name = $projectName
  repoPath = $RepoPath
  defaultBranch = $DefaultBranch
}

Write-Host "Provisioning cleanup smoke worker '$WorkerName' ..." -ForegroundColor Cyan
$provisionResult = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/worktrees" -Body @{
  workerName = $WorkerName
}

$worktreePath = $provisionResult.worktree.worktreePath

if (-not (Test-Path $worktreePath)) {
  throw "Provisioned worktree path does not exist before cleanup: $worktreePath"
}

if ($Scenario -eq "blocked") {
  Write-Host "Creating task and assignment to force blocked cleanup..." -ForegroundColor Cyan
  $task = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks" -Body @{
    title = $taskTitle
    description = $taskDescription
    priority = "medium"
    projectId = $project.id
  }

  $null = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/assignments" -Body @{
    taskId = $task.id
    workerId = $provisionResult.worker.id
  }

  Write-Host "Calling cleanup API and expecting a blocked response..." -ForegroundColor Cyan
  $cleanupAttempt = Invoke-JsonRequestAllowError -Method POST -Uri "$BaseUrl/api/workers/$($provisionResult.worker.id)/cleanup" -Body @{
    removeWorktree = $true
    deleteBranch = $false
  }

  if ($cleanupAttempt.StatusCode -ne 409) {
    throw "Expected blocked cleanup HTTP 409, got $($cleanupAttempt.StatusCode)."
  }

  if ($cleanupAttempt.Body.errorCode -ne "WORKER_CLEANUP_BLOCKED") {
    throw "Expected WORKER_CLEANUP_BLOCKED, got $($cleanupAttempt.Body.errorCode)."
  }

  Write-Host "Fetching worker board to confirm worker stayed active..." -ForegroundColor Cyan
  $workers = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/workers?includeDiff=false"
  $worker = $workers.items | Where-Object { $_.workerId -eq $provisionResult.worker.id } | Select-Object -First 1

  if (-not $worker) {
    throw "Assigned worker was not found in the worker board response after blocked cleanup."
  }

  if (-not (Test-Path $worktreePath)) {
    throw "Worktree path was removed even though cleanup should have been blocked: $worktreePath"
  }

  if ($worker.status -ne "active") {
    throw "Worker board status mismatch after blocked cleanup. Expected active, got $($worker.status)."
  }

  if ($worker.taskId -ne $task.id) {
    throw "Blocked cleanup should keep assignment intact. Expected task $($task.id), got $($worker.taskId)."
  }

  Write-Host "Blocked cleanup smoke test passed." -ForegroundColor Green
  Write-Host "Project ID:      $($project.id)"
  Write-Host "Task ID:         $($task.id)"
  Write-Host "Worker ID:       $($provisionResult.worker.id)"
  Write-Host "Error Code:      $($cleanupAttempt.Body.errorCode)"
} else {
  Write-Host "Archiving worker through cleanup API..." -ForegroundColor Cyan
  $cleanupResult = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers/$($provisionResult.worker.id)/cleanup" -Body @{
    removeWorktree = $true
    deleteBranch = $false
  }

  Write-Host "Fetching worker board to confirm archived state..." -ForegroundColor Cyan
  $workers = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/workers?includeDiff=false"
  $worker = $workers.items | Where-Object { $_.workerId -eq $provisionResult.worker.id } | Select-Object -First 1

  if (-not $worker) {
    throw "Archived worker was not found in the worker board response."
  }

  if ($cleanupResult.worker.status -ne "archived") {
    throw "Cleanup response worker status mismatch. Expected archived, got $($cleanupResult.worker.status)."
  }

  if ($cleanupResult.cleanup.status -ne "completed") {
    throw "Cleanup response status mismatch. Expected completed, got $($cleanupResult.cleanup.status)."
  }

  if (-not $cleanupResult.cleanup.removedWorktree) {
    throw "Cleanup response reported removedWorktree=false."
  }

  if (Test-Path $worktreePath) {
    throw "Worktree path still exists after cleanup: $worktreePath"
  }

  if ($worker.status -ne "archived") {
    throw "Worker board status mismatch. Expected archived, got $($worker.status)."
  }

  if (-not $worker.archivedAt) {
    throw "Worker board did not report archivedAt for the archived worker."
  }

  if ($worker.taskId) {
    throw "Archived worker should not remain assigned, but taskId was $($worker.taskId)."
  }

  Write-Host "Cleanup smoke test passed." -ForegroundColor Green
  Write-Host "Project ID:      $($project.id)"
  Write-Host "Worker ID:       $($provisionResult.worker.id)"
  Write-Host "Branch:          $($provisionResult.worktree.branchName)"
  Write-Host "Worktree Removed: $($cleanupResult.cleanup.removedWorktree)"
  Write-Host "Archived At:     $($worker.archivedAt)"
}