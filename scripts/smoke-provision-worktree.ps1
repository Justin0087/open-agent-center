param(
  [string]$BaseUrl = "http://127.0.0.1:4317",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DefaultBranch = "main",
  [string]$WorkerName = "smoke-worker",
  [switch]$Cleanup
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

function Remove-ProvisionedWorktree {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RepositoryPath,

    [Parameter(Mandatory = $true)]
    [string]$WorktreePath,

    [Parameter(Mandatory = $true)]
    [string]$BranchName
  )

  Write-Host "Cleaning up provisioned worktree..." -ForegroundColor Yellow
  & git -C $RepositoryPath worktree remove --force $WorktreePath
  & git -C $RepositoryPath branch -D $BranchName
}

$projectName = "smoke-open-agent-center"
$taskTitle = "Smoke test worktree provisioning"
$taskDescription = "Verify browser-first onboarding can register a project, provision a worker, create a task, and assign it."

Write-Host "Checking controller health at $BaseUrl ..." -ForegroundColor Cyan
$health = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/health"

if (-not $health.ok) {
  throw "Controller health check failed."
}

Write-Host "Registering smoke test project for repo: $RepoPath" -ForegroundColor Cyan
$project = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects" -Body @{
  name = $projectName
  repoPath = $RepoPath
  defaultBranch = $DefaultBranch
}

Write-Host "Provisioning worktree for worker '$WorkerName' ..." -ForegroundColor Cyan
$provisionResult = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/worktrees" -Body @{
  workerName = $WorkerName
}

Write-Host "Creating project-bound smoke test task..." -ForegroundColor Cyan
$task = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks" -Body @{
  title = $taskTitle
  description = $taskDescription
  priority = "medium"
  projectId = $project.id
}

Write-Host "Assigning smoke test task to provisioned worker..." -ForegroundColor Cyan
$assignment = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/assignments" -Body @{
  taskId = $task.id
  workerId = $provisionResult.worker.id
}

Write-Host "Fetching worker board to confirm worker persistence..." -ForegroundColor Cyan
$workers = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/workers?includeDiff=false"
$worker = $workers.items | Where-Object { $_.workerId -eq $provisionResult.worker.id } | Select-Object -First 1

Write-Host "Fetching task detail to confirm project-bound assignment..." -ForegroundColor Cyan
$taskDetail = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/tasks/$($task.id)"

if (-not $worker) {
  throw "Provisioned worker was not found in the worker board response."
}

if (-not (Test-Path $provisionResult.worktree.worktreePath)) {
  throw "Provisioned worktree path does not exist: $($provisionResult.worktree.worktreePath)"
}

if ($worker.projectId -ne $project.id) {
  throw "Provisioned worker project binding mismatch. Expected $($project.id), got $($worker.projectId)."
}

if ($worker.taskId -ne $task.id) {
  throw "Provisioned worker assignment mismatch. Expected task $($task.id), got $($worker.taskId)."
}

if ($task.projectId -ne $project.id) {
  throw "Created task project binding mismatch. Expected $($project.id), got $($task.projectId)."
}

if ($taskDetail.assignedWorker.workerId -ne $provisionResult.worker.id) {
  throw "Task detail assignment mismatch. Expected worker $($provisionResult.worker.id), got $($taskDetail.assignedWorker.workerId)."
}

if ($assignment.worker.id -ne $provisionResult.worker.id) {
  throw "Assignment response mismatch. Expected worker $($provisionResult.worker.id), got $($assignment.worker.id)."
}

Write-Host "Smoke test passed." -ForegroundColor Green
Write-Host "Project ID:      $($project.id)"
Write-Host "Task ID:         $($task.id)"
Write-Host "Worker ID:       $($provisionResult.worker.id)"
Write-Host "Branch:          $($provisionResult.worktree.branchName)"
Write-Host "Worktree Path:   $($provisionResult.worktree.worktreePath)"

if ($Cleanup) {
  Remove-ProvisionedWorktree -RepositoryPath $RepoPath -WorktreePath $provisionResult.worktree.worktreePath -BranchName $provisionResult.worktree.branchName
  Write-Host "Cleanup completed. The controller state still contains the created project, task, and worker records." -ForegroundColor Yellow
} else {
  Write-Host "Cleanup was not requested. The new worktree and branch were left in place for inspection." -ForegroundColor Yellow
  Write-Host "To remove them later:" -ForegroundColor Yellow
  Write-Host "  git -C \"$RepoPath\" worktree remove --force \"$($provisionResult.worktree.worktreePath)\""
  Write-Host "  git -C \"$RepoPath\" branch -D \"$($provisionResult.worktree.branchName)\""
}