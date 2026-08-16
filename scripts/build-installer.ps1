$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ElectronRoot = Join-Path $ProjectRoot "artifacts\electron"

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Command
  )

  Write-Host "`n=== $Label ===" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

Set-Location $ProjectRoot
Write-Host "Building from: $ProjectRoot" -ForegroundColor Green

function Get-GitRemote {
  $remotes = @(git remote)
  if ($remotes -contains "github") { return "github" }
  if ($remotes -contains "origin") { return "origin" }
  throw "No GitHub remote found. Configure a remote named 'github' or 'origin' before building."
}

$GitRemote = Get-GitRemote
$GitStatus = @(git status --porcelain | Where-Object {
  # Electron Builder creates this output locally; it is never source input
  # and must not make an otherwise clean checkout fail the sync guard.
  $_ -notmatch '^\?\?\s+artifacts[\\/]+electron[\\/]+release(?:[\\/]|$)'
})
if ($GitStatus.Count -gt 0) {
  Write-Host "The checkout contains local changes or untracked files:" -ForegroundColor Yellow
  $GitStatus | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
  throw "Refusing to pull/build from a dirty checkout. Commit, stash, or remove these files first."
}

if (@(git diff --name-only --diff-filter=U).Count -gt 0) {
  throw "Unresolved merge conflicts detected. Resolve them and verify 'git status' is clean before building."
}

Invoke-Step "Pull latest GitHub changes" {
  git fetch $GitRemote main
  if ($LASTEXITCODE -ne 0) {
    throw "Fetching latest GitHub changes failed."
  }
  git merge --ff-only "$GitRemote/main"
  if ($LASTEXITCODE -ne 0) {
    throw "Local branch cannot be fast-forwarded from $GitRemote/main. Resolve the divergence manually; no merge was created."
  }
}

Invoke-Step "Install workspace dependencies" {
  pnpm install --no-frozen-lockfile
}

Invoke-Step "Build API server" {
  pnpm --filter @workspace/api-server run build
}

$env:REPL_ID = "ci"
Invoke-Step "Build frontend" {
  pnpm --filter @workspace/dannys-bot run build
}

Set-Location $ElectronRoot

Invoke-Step "Install Electron dependencies" {
  npm install --ignore-scripts
}

Invoke-Step "Build Electron bundle" {
  node build.mjs
}

$env:GYP_MSVS_VERSION = "2022"
$env:npm_config_msvs_version = "2022"

Invoke-Step "Build Windows installer" {
  npx electron-builder --win --publish never
}

$ReleaseDir = Join-Path $ElectronRoot "release"
Write-Host "`nInstaller created in: $ReleaseDir" -ForegroundColor Green
Start-Process explorer.exe $ReleaseDir