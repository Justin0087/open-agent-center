param(
  [string]$BaseUrl = "http://127.0.0.1:4317"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$startedController = $null
$controllerStdOut = $null
$controllerStdErr = $null

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

function Invoke-TextRequest {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri
  )

  return Invoke-WebRequest -Uri $Uri -NoProxy -UseBasicParsing
}

function Test-ControllerHealth {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri
  )

  try {
    $health = Invoke-JsonRequest -Method GET -Uri "$Uri/health"
    return $health.ok -eq $true
  } catch {
    return $false
  }
}

function Start-LocalController {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Uri,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryPath
  )

  $uriObject = [Uri]$Uri
  $tsxCommand = Join-Path $RepositoryPath "node_modules\.bin\tsx.cmd"
  $launcher = if (Test-Path $tsxCommand) { $tsxCommand } else { "npx.cmd" }
  $arguments = if (Test-Path $tsxCommand) { @("src/index.ts") } else { @("tsx", "src/index.ts") }

  $logRoot = Join-Path $env:TEMP ("open-agent-center-dashboard-runtime-smoke-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $logRoot | Out-Null
  $stdoutPath = Join-Path $logRoot "controller.stdout.log"
  $stderrPath = Join-Path $logRoot "controller.stderr.log"

  $originalPort = $env:PORT
  $env:PORT = [string]$uriObject.Port
  try {
    $process = Start-Process -FilePath $launcher -ArgumentList $arguments -WorkingDirectory $RepositoryPath -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  } finally {
    $env:PORT = $originalPort
  }

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-ControllerHealth -Uri $Uri) {
      return [pscustomobject]@{
        Process = $process
        StdOutPath = $stdoutPath
        StdErrPath = $stderrPath
      }
    }

    if ($process.HasExited) {
      break
    }
  }

  $stdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { "" }
  $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }
  throw "Failed to start local controller for smoke test.`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
}

try {
  Write-Host "Checking controller health at $BaseUrl ..." -ForegroundColor Cyan
  if (-not (Test-ControllerHealth -Uri $BaseUrl)) {
    Write-Host "No controller detected. Starting a temporary local controller..." -ForegroundColor Yellow
    $startedController = Start-LocalController -Uri $BaseUrl -RepositoryPath $repoRoot
    $controllerStdOut = $startedController.StdOutPath
    $controllerStdErr = $startedController.StdErrPath
  }

  $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $vscodeWorkerName = "smoke-runtime-vscode-$timestamp"
  $openclawWorkerName = "smoke-runtime-openclaw-$timestamp"

  Write-Host "Creating one launch-capable worker and one unsupported-runtime worker..." -ForegroundColor Cyan
  $vscodeWorker = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers" -Body @{
    name = $vscodeWorkerName
    runtimeKind = "vscode-copilot"
    worktreePath = "C:/temp/$vscodeWorkerName"
    assignedBranch = "task/$vscodeWorkerName"
  }

  $openclawWorker = Invoke-JsonRequest -Method POST -Uri "$BaseUrl/api/workers" -Body @{
    name = $openclawWorkerName
    runtimeKind = "openclaw"
    worktreePath = "C:/temp/$openclawWorkerName"
    assignedBranch = "task/$openclawWorkerName"
  }

  Write-Host "Fetching worker board response with derived runtime capabilities..." -ForegroundColor Cyan
  $workers = Invoke-JsonRequest -Method GET -Uri "$BaseUrl/api/workers?includeDiff=false"
  $vscodeSummary = $workers.items | Where-Object { $_.workerId -eq $vscodeWorker.id } | Select-Object -First 1
  $openclawSummary = $workers.items | Where-Object { $_.workerId -eq $openclawWorker.id } | Select-Object -First 1

  if (-not $vscodeSummary) {
    throw "Launch-capable worker was not found in GET /api/workers."
  }

  if (-not $openclawSummary) {
    throw "Unsupported-runtime worker was not found in GET /api/workers."
  }

  if (-not $vscodeSummary.runtimeCapabilities) {
    throw "Expected runtimeCapabilities on the vscode-copilot worker summary."
  }

  if (-not $openclawSummary.runtimeCapabilities) {
    throw "Expected runtimeCapabilities on the openclaw worker summary."
  }

  if ($vscodeSummary.runtimeCapabilities.canOpenEditor -ne $true) {
    throw "Expected vscode-copilot runtime to report canOpenEditor=true."
  }

  if ($openclawSummary.runtimeCapabilities.canOpenEditor -ne $false) {
    throw "Expected openclaw runtime to report canOpenEditor=false."
  }

  Write-Host "Fetching dashboard assets to confirm capability UX wiring..." -ForegroundColor Cyan
  $dashboardHtml = Invoke-TextRequest -Uri "$BaseUrl/dashboard"
  $dashboardJs = Invoke-TextRequest -Uri "$BaseUrl/dashboard.js"

  if ($dashboardHtml.Content -notmatch 'id="runtime-capability-hint"') {
    throw "Expected dashboard HTML to include the runtime capability hint container."
  }

  if ($dashboardJs.Content -notmatch 'runtimeCapabilities') {
    throw "Expected dashboard JS to reference runtimeCapabilities."
  }

  if ($dashboardJs.Content -notmatch 'canOpenEditor') {
    throw "Expected dashboard JS to gate launch behavior using canOpenEditor."
  }

  Write-Host "Dashboard runtime capability smoke test passed." -ForegroundColor Green
  Write-Host "VS Code Worker ID:   $($vscodeWorker.id)"
  Write-Host "OpenClaw Worker ID:  $($openclawWorker.id)"
  Write-Host "Launch Capability:   vscode-copilot=$($vscodeSummary.runtimeCapabilities.canOpenEditor) | openclaw=$($openclawSummary.runtimeCapabilities.canOpenEditor)"
} finally {
  if ($startedController -and $startedController.Process -and -not $startedController.Process.HasExited) {
    Write-Host "Stopping temporary local controller..." -ForegroundColor Yellow
    Stop-Process -Id $startedController.Process.Id -Force
  }

  if ($controllerStdOut -and (Test-Path $controllerStdOut)) {
    Remove-Item $controllerStdOut -Force -ErrorAction SilentlyContinue
  }

  if ($controllerStdErr -and (Test-Path $controllerStdErr)) {
    Remove-Item $controllerStdErr -Force -ErrorAction SilentlyContinue
  }
}
