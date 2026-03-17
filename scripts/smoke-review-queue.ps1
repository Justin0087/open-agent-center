param(
  [string]$BaseUrl = "http://127.0.0.1:4317",
  [ValidateSet("approve-integrate", "request-changes-reassign")]
  [string]$Scenario = "approve-integrate",
  [string]$SourceRepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$TempRoot = (Join-Path $env:TEMP "open-agent-center-review-smoke"),
  [string]$WorkerName = "smoke-review-worker",
  [string]$ReassignWorkerName = "smoke-review-worker-reassign",
  [string]$TaskTitle = "Smoke test review queue",
  [string]$ReviewNote = "Smoke review note: ready after validation."
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

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = & git @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $output"
  }

  return ($output | Out-String).Trim()
}

function New-IntegrationValidationRepo {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceRepoPath,

    [Parameter(Mandatory = $true)]
    [string]$TempRoot
  )

  if (Test-Path $TempRoot) {
    Remove-Item -Recurse -Force $TempRoot
  }

  New-Item -ItemType Directory -Path $TempRoot | Out-Null
  $repoPath = Join-Path $TempRoot "repo"

  Invoke-Git -Arguments @("clone", "--quiet", "--branch", "main", "--single-branch", $SourceRepoPath, $repoPath) | Out-Null
  Invoke-Git -Arguments @("-C", $repoPath, "config", "user.name", "Open Agent Center Smoke") | Out-Null
  Invoke-Git -Arguments @("-C", $repoPath, "config", "user.email", "open-agent-center-smoke@example.com") | Out-Null

  return $repoPath
}

function New-WorkerCommit {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerPath
  )

  $targetFile = Join-Path $WorkerPath "INTEGRATION_SMOKE.md"
  @(
    "# Integration Smoke",
    "",
    "This file was created by the real approve -> integrate validation."
  ) | Set-Content -Path $targetFile -Encoding utf8

  Invoke-Git -Arguments @("-C", $WorkerPath, "config", "user.name", "Open Agent Center Smoke") | Out-Null
  Invoke-Git -Arguments @("-C", $WorkerPath, "config", "user.email", "open-agent-center-smoke@example.com") | Out-Null
  Invoke-Git -Arguments @("-C", $WorkerPath, "add", "INTEGRATION_SMOKE.md") | Out-Null
  Invoke-Git -Arguments @("-C", $WorkerPath, "commit", "-m", "Add integration smoke artifact") | Out-Null

  return (Invoke-Git -Arguments @("-C", $WorkerPath, "rev-parse", "HEAD")).Trim()
}

Write-Host "Checking controller health at $BaseUrl ..." -ForegroundColor Cyan
$health = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/health"

if (-not $health.ok) {
  throw "Controller health check failed."
}

$worker = $null
$validationRepoPath = $null
$workerCommit = $null

if ($Scenario -eq "approve-integrate") {
  Write-Host "Preparing isolated validation repository..." -ForegroundColor Cyan
  $validationRepoPath = New-IntegrationValidationRepo -SourceRepoPath $SourceRepoPath -TempRoot $TempRoot

  Write-Host "Registering smoke review project..." -ForegroundColor Cyan
  $project = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects" -Body @{
    name = "integration-smoke-project"
    repoPath = $validationRepoPath
    defaultBranch = "main"
  }
}
else {
  Write-Host "Creating smoke review worker..." -ForegroundColor Cyan
  $worker = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers" -Body @{
    name = $WorkerName
    worktreePath = "C:/temp/$WorkerName"
    assignedBranch = "task/$WorkerName"
  }
}

$reassignWorker = $null
if ($Scenario -eq "request-changes-reassign") {
  Write-Host "Creating reassign target worker..." -ForegroundColor Cyan
  $reassignWorker = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers" -Body @{
    name = $ReassignWorkerName
    worktreePath = "C:/temp/$ReassignWorkerName"
    assignedBranch = "task/$ReassignWorkerName"
  }
}

Write-Host "Creating smoke review task..." -ForegroundColor Cyan
$task = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks" -Body @{
  title = $TaskTitle
  description = "Verify assign -> review -> approve(notes) -> integrate flow."
  priority = "high"
}

if ($Scenario -eq "approve-integrate") {
  Write-Host "Provisioning worktree-backed worker..." -ForegroundColor Cyan
  $provisioned = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/projects/$($project.id)/worktrees" -Body @{
    workerName = $WorkerName
    taskId = $task.id
    branchBase = "integration-smoke"
  }
  $worker = $provisioned.worker
  $workerCommit = New-WorkerCommit -WorkerPath $worker.worktreePath
}
else {
  Write-Host "Assigning task to worker..." -ForegroundColor Cyan
  Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/assignments" -Body @{
    taskId = $task.id
    workerId = $worker.id
  } | Out-Null
}

Write-Host "Moving task into review..." -ForegroundColor Cyan
Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks/$($task.id)/transitions" -Body @{
  action = "review"
} | Out-Null

if ($Scenario -eq "approve-integrate") {
  Write-Host "Approving task with reviewer note..." -ForegroundColor Cyan
  Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks/$($task.id)/review" -Body @{
    action = "approve"
    notes = $ReviewNote
  } | Out-Null

  $approvedDetail = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/tasks/$($task.id)"
  $noteArtifact = $approvedDetail.artifacts | Where-Object { $_.type -eq "note" } | Select-Object -Last 1

  if (-not $noteArtifact) {
    throw "Expected a note artifact after approving with reviewer notes."
  }

  if ($noteArtifact.pathOrText -ne $ReviewNote) {
    throw "Reviewer note artifact text did not match the submitted note."
  }

  if ($approvedDetail.summary.reviewState -ne "approved") {
    throw "Expected reviewState to be 'approved' after approval."
  }

  Write-Host "Integrating task..." -ForegroundColor Cyan
  $integratedResponse = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks/$($task.id)/review" -Body @{
    action = "integrate"
  }

  $integratedDetail = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/tasks/$($task.id)"

  if ($integratedDetail.task.status -ne "done") {
    throw "Expected task status to be 'done' after integrate."
  }

  if ($integratedDetail.summary.hasActiveRun) {
    throw "Expected no active run after integration."
  }

  $eventTail = $integratedDetail.events | Select-Object -Last 5 | ForEach-Object { $_.type }

  if (-not ($eventTail -contains "TaskApproved")) {
    throw "Expected TaskApproved event in recent event tail."
  }

  if (-not ($eventTail -contains "TaskIntegrated")) {
    throw "Expected TaskIntegrated event in recent event tail."
  }

  if (-not $integratedResponse.integration) {
    throw "Expected integrate response to include integration summary."
  }

  if ($integratedResponse.integration.status -ne "integrated") {
    throw "Expected integrate response status to be 'integrated'."
  }

  if ($integratedResponse.integration.targetBranch -ne "main") {
    throw "Expected integration target branch to be 'main'."
  }

  if (-not $validationRepoPath) {
    throw "Expected a validation repository path for approve-integrate scenario."
  }

  $repoHead = (Invoke-Git -Arguments @("-C", $validationRepoPath, "rev-parse", "HEAD")).Trim()
  $mainContainsWorkerCommit = (Invoke-Git -Arguments @("-C", $validationRepoPath, "branch", "--contains", $workerCommit))
  $integratedFilePath = Join-Path $validationRepoPath "INTEGRATION_SMOKE.md"

  if (-not (Test-Path $integratedFilePath)) {
    throw "Expected INTEGRATION_SMOKE.md to exist on the integrated main branch."
  }

  if ($repoHead -ne $integratedResponse.integration.headSha) {
    throw "Expected repository HEAD to match the integrate response head SHA."
  }

  if ($mainContainsWorkerCommit -notmatch "main") {
    throw "Expected main to contain the worker commit after integration."
  }

  Write-Host "Review queue smoke test passed." -ForegroundColor Green
  Write-Host "Scenario:          $Scenario"
  Write-Host "Task ID:           $($task.id)"
  Write-Host "Worker ID:         $($worker.id)"
  Write-Host "Review State:      $($approvedDetail.summary.reviewState)"
  Write-Host "Final Task Status: $($integratedDetail.task.status)"
  Write-Host "Repo Head:         $repoHead"
  Write-Host "Worker Commit:     $workerCommit"
  Write-Host "Reviewer Note:     $($noteArtifact.pathOrText)"
  Write-Host "Recent Events:     $($eventTail -join ', ')"
}
else {
  Write-Host "Requesting changes with reviewer note..." -ForegroundColor Cyan
  Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks/$($task.id)/review" -Body @{
    action = "request_changes"
    notes = $ReviewNote
  } | Out-Null

  $changesDetail = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/tasks/$($task.id)"
  $noteArtifact = $changesDetail.artifacts | Where-Object { $_.type -eq "note" } | Select-Object -Last 1

  if ($changesDetail.task.status -ne "queued") {
    throw "Expected task status to be 'queued' after requesting changes."
  }

  if ($changesDetail.task.assignedWorkerId) {
    throw "Expected requested-changes task to be unassigned and back in the queue."
  }

  if ($changesDetail.summary.hasActiveRun) {
    throw "Expected no active run after requesting changes."
  }

  if (-not $noteArtifact) {
    throw "Expected a note artifact after requesting changes with reviewer notes."
  }

  if ($noteArtifact.pathOrText -ne $ReviewNote) {
    throw "Reviewer note artifact text did not match the submitted request-changes note."
  }

  Write-Host "Reassigning task to second worker..." -ForegroundColor Cyan
  Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/assignments" -Body @{
    taskId = $task.id
    workerId = $reassignWorker.id
  } | Out-Null

  $reassignedDetail = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/tasks/$($task.id)"

  if ($reassignedDetail.task.status -ne "in_progress") {
    throw "Expected task status to be 'in_progress' after reassignment."
  }

  if ($reassignedDetail.task.assignedWorkerId -ne $reassignWorker.id) {
    throw "Expected task to be assigned to the reassign target worker."
  }

  Write-Host "Returning reassigned task to review..." -ForegroundColor Cyan
  Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks/$($task.id)/transitions" -Body @{
    action = "review"
  } | Out-Null

  $finalDetail = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/tasks/$($task.id)"
  $allEventTypes = $finalDetail.events | ForEach-Object { $_.type }
  $recentEvents = $finalDetail.events | Select-Object -Last 6 | ForEach-Object { $_.type }

  if ($finalDetail.task.status -ne "review") {
    throw "Expected task status to be 'review' after reassigned worker resubmits for review."
  }

  if (-not ($allEventTypes -contains "TaskChangesRequested")) {
    throw "Expected TaskChangesRequested event in task event history."
  }

  if (($allEventTypes | Where-Object { $_ -eq "TaskAssigned" }).Count -lt 2) {
    throw "Expected task to be assigned twice across the request-changes flow."
  }

  Write-Host "Review queue smoke test passed." -ForegroundColor Green
  Write-Host "Scenario:              $Scenario"
  Write-Host "Task ID:               $($task.id)"
  Write-Host "Initial Worker ID:     $($worker.id)"
  Write-Host "Reassign Worker ID:    $($reassignWorker.id)"
  Write-Host "Queued After Changes:  $($changesDetail.task.status)"
  Write-Host "Final Task Status:     $($finalDetail.task.status)"
  Write-Host "Reviewer Note:         $($noteArtifact.pathOrText)"
  Write-Host "Recent Events:         $($recentEvents -join ', ')"
}