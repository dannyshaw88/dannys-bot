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
if (@(git diff --name-only --diff-filter=U).Count -gt 0) {
  throw "Unresolved merge conflicts detected. Resolve them and verify 'git status' is clean before building."
}

$AutomaticStashRef = $null

Invoke-Step "Pull latest GitHub changes" {
  git fetch $GitRemote main
  if ($LASTEXITCODE -ne 0) {
    throw "Fetching latest GitHub changes failed."
  }

  $GitStatus = @(git status --porcelain | Where-Object {
    # Electron Builder creates this output locally; it is never source input
    # and must not make an otherwise clean checkout fail the sync guard.
    $_ -notmatch '^\?\?\s+artifacts[\\/]+electron[\\/]+release(?:[\\/]|$)' -and
    $_ -notmatch '^\?\?\s+artifacts[\\/]+electron[\\/]+package-lock\.json$'
  })
  if ($GitStatus.Count -gt 0) {
    $StashMessage = "build-installer automatic backup $(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Host "The checkout contains local changes. Preserving them in Git stash before syncing:" -ForegroundColor Yellow
    $GitStatus | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    # Older Windows checkouts can contain large ZIP files whose LFS filters
    # are already broken. Exclude ZIPs from the stash operation so Git does
    # not block on those stale binary filters; the remote checkout below
    # replaces the tracked copies with the verified release versions.
    $StashBefore = @(git stash list -1 --format="%gd")
    git stash push --include-untracked --message $StashMessage -- . ':(exclude)*.zip' ':(exclude)**/*.zip'
    if ($LASTEXITCODE -ne 0) {
      throw "Could not preserve the local checkout in Git stash."
    }
    $StashAfter = @(git stash list -1 --format="%gd")
    if ($StashAfter.Count -gt 0 -and ($StashBefore.Count -eq 0 -or $StashAfter[0] -ne $StashBefore[0])) {
      $AutomaticStashRef = $StashAfter[0]
      Write-Host "Preserved non-ZIP local changes as $AutomaticStashRef. They were not reapplied to the release checkout." -ForegroundColor Yellow
    } elseif (@($GitStatus | Where-Object { $_ -notmatch '\.zip$' }).Count -gt 0) {
      throw "Git stash completed but its backup reference could not be identified."
    }
  }

  git merge-base --is-ancestor HEAD "$GitRemote/main"
  if ($LASTEXITCODE -ne 0) {
    throw "Local branch has commits that are not in $GitRemote/main. No local commits were overwritten."
  }
  git reset --hard "$GitRemote/main"
  if ($LASTEXITCODE -ne 0) {
    throw "Could not sync the checkout to $GitRemote/main."
  }
}

if ($null -ne $AutomaticStashRef) {
  Write-Host "Building from the clean synced checkout. Restore the preserved work later with: git stash apply $AutomaticStashRef" -ForegroundColor Yellow
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