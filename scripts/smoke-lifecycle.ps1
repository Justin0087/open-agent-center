param(
  [string]$BaseUrl = "http://127.0.0.1:4317",
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$DefaultBranch = "main"
)

$ErrorActionPreference = "Stop"

function Invoke-SmokeStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Label,

    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Host "==> $Label" -ForegroundColor Cyan
  & $Action
  Write-Host "    passed: $Label" -ForegroundColor Green
}

Write-Host "Running lifecycle smoke suite against $BaseUrl" -ForegroundColor Cyan

Invoke-SmokeStep -Label "Browser-first onboarding" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-provision-worktree.ps1") `
    -BaseUrl $BaseUrl `
    -RepoPath $RepoPath `
    -DefaultBranch $DefaultBranch
}

Invoke-SmokeStep -Label "Worker cleanup success" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-worker-cleanup.ps1") `
    -BaseUrl $BaseUrl `
    -RepoPath $RepoPath `
    -DefaultBranch $DefaultBranch `
    -Scenario success
}

Invoke-SmokeStep -Label "Worker cleanup blocked" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-worker-cleanup.ps1") `
    -BaseUrl $BaseUrl `
    -RepoPath $RepoPath `
    -DefaultBranch $DefaultBranch `
    -Scenario blocked
}

Invoke-SmokeStep -Label "Project archive success" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-project-archive.ps1") `
    -BaseUrl $BaseUrl `
    -RepoPath $RepoPath `
    -DefaultBranch $DefaultBranch `
    -Scenario success
}

Invoke-SmokeStep -Label "Project archive blocked" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-project-archive.ps1") `
    -BaseUrl $BaseUrl `
    -RepoPath $RepoPath `
    -DefaultBranch $DefaultBranch `
    -Scenario blocked
}

Invoke-SmokeStep -Label "Review approve integrate" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-review-queue.ps1") `
    -BaseUrl $BaseUrl `
    -SourceRepoPath $RepoPath `
    -Scenario approve-integrate
}

Invoke-SmokeStep -Label "Review request changes reassign" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-review-queue.ps1") `
    -BaseUrl $BaseUrl `
    -SourceRepoPath $RepoPath `
    -Scenario request-changes-reassign
}

Invoke-SmokeStep -Label "Review integrate conflict" -Action {
  pwsh -File (Join-Path $PSScriptRoot "smoke-review-queue.ps1") `
    -BaseUrl $BaseUrl `
    -SourceRepoPath $RepoPath `
    -Scenario approve-conflict
}

Write-Host "Lifecycle smoke suite passed." -ForegroundColor Green