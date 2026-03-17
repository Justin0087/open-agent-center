param(
  [string]$BaseUrl = "http://127.0.0.1:4317",
  [ValidateSet("approve-integrate", "request-changes-reassign")]
  [string]$Scenario = "approve-integrate",
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

Write-Host "Checking controller health at $BaseUrl ..." -ForegroundColor Cyan
$health = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/health"

if (-not $health.ok) {
  throw "Controller health check failed."
}

Write-Host "Creating smoke review worker..." -ForegroundColor Cyan
$worker = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers" -Body @{
  name = $WorkerName
  worktreePath = "C:/temp/$WorkerName"
  assignedBranch = "task/$WorkerName"
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

Write-Host "Assigning task to worker..." -ForegroundColor Cyan
Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/assignments" -Body @{
  taskId = $task.id
  workerId = $worker.id
} | Out-Null

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
  Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/tasks/$($task.id)/review" -Body @{
    action = "integrate"
  } | Out-Null

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

  Write-Host "Review queue smoke test passed." -ForegroundColor Green
  Write-Host "Scenario:          $Scenario"
  Write-Host "Task ID:           $($task.id)"
  Write-Host "Worker ID:         $($worker.id)"
  Write-Host "Review State:      $($approvedDetail.summary.reviewState)"
  Write-Host "Final Task Status: $($integratedDetail.task.status)"
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