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
$taskDescription = "Verify controller can provision a worker worktree from a registered project."

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

Write-Host "Creating smoke test task..." -ForegroundColor Cyan
$task = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks" -Body @{
  title = $taskTitle
  description = $taskDescription
  priority = "medium"
}

Write-Host "Provisioning worktree for worker '$WorkerName' ..." -ForegroundColor Cyan
$provisionResult = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/worktrees" -Body @{
  workerName = $WorkerName
  taskId = $task.id
}

Write-Host "Fetching worker board to confirm worker persistence..." -ForegroundColor Cyan
$workers = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/workers?includeDiff=false"
$worker = $workers.items | Where-Object { $_.workerId -eq $provisionResult.worker.id } | Select-Object -First 1

if (-not $worker) {
  throw "Provisioned worker was not found in the worker board response."
}

if (-not (Test-Path $provisionResult.worktree.worktreePath)) {
  throw "Provisioned worktree path does not exist: $($provisionResult.worktree.worktreePath)"
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