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

Invoke-Step "Pull latest GitHub changes" {
  git pull origin main
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