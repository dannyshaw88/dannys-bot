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
    $_ -notmatch '^\?\?\s+artifacts[\\/]+electron[\\/]+package-lock\.json$' -and
    # The helper executable and APK are rebuilt below from verified sources.
    $_ -notmatch '^\?\?\s+artifacts[\\/]+electron[\\/]+resources[\\/]+bin[\\/]+win32[\\/]+gnirehtet(?:[\\/]|$)'
  })
  if ($GitStatus.Count -gt 0) {
    $StashMessage = "build-installer automatic backup $(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Host "The checkout contains local changes. Preserving them in Git stash before syncing:" -ForegroundColor Yellow
    $GitStatus | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
    # Older Windows checkouts can contain large ZIP files whose LFS filters
    # are already broken. Exclude ZIPs from the stash operation so Git does
    # not block on those stale binary filters; the remote checkout below
    # replaces the tracked copies with the verified release versions.
    # Compare stash object IDs, not selectors like stash@{0}; that selector
    # remains unchanged when a new stash is pushed ahead of an existing one.
    $StashBefore = @(git stash list -1 --format="%H")
    git stash push --include-untracked --message $StashMessage -- . ':(exclude)*.zip' ':(exclude)**/*.zip'
    if ($LASTEXITCODE -ne 0) {
      throw "Could not preserve the local checkout in Git stash."
    }
    $StashAfter = @(git stash list -1 --format="%H")
    if ($StashAfter.Count -gt 0 -and ($StashBefore.Count -eq 0 -or $StashAfter[0] -ne $StashBefore[0])) {
      $AutomaticStashRef = @(git stash list -1 --format="%gd")[0]
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

Invoke-Step "Build Windows USB reverse-tether helper" {
  if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Rust Cargo is required to build the USB reverse-tether helper. Install the Rust stable toolchain, then rerun this script."
  }

  cargo build --release --locked --manifest-path artifacts/electron/third_party/gnirehtet-relay-rust/Cargo.toml
  if ($LASTEXITCODE -ne 0) {
    throw "Building the USB reverse-tether relay failed."
  }

  $Target = Join-Path $ElectronRoot "resources\bin\win32\gnirehtet"
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $Relay = Join-Path $ProjectRoot "artifacts\electron\third_party\gnirehtet-relay-rust\target\release\gnirehtet.exe"
  if (-not (Test-Path $Relay -PathType Leaf)) {
    throw "The Windows USB reverse-tether relay was not produced at $Relay"
  }
  Copy-Item $Relay (Join-Path $Target "gnirehtet.exe") -Force

  $Archive = Join-Path $env:TEMP "gnirehtet-rust-win64-v2.5.1.zip"
  $Unpack = Join-Path $env:TEMP ("gnirehtet-rust-win64-v2.5.1-" + [guid]::NewGuid().ToString("N"))
  Invoke-WebRequest `
    -Uri "https://github.com/Genymobile/gnirehtet/releases/download/v2.5.1/gnirehtet-rust-win64-v2.5.1.zip" `
    -OutFile $Archive
  $Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Hash -ne "7f5b1063e7895182aa60def1437e50363c3758144088dcd079037bb7c3c46a1c") {
    throw "Gnirehtet release archive SHA-256 did not match the published checksum."
  }
  Expand-Archive -Force -Path $Archive -DestinationPath $Unpack
  $ApkMatches = @(Get-ChildItem -Path $Unpack -Filter "gnirehtet.apk" -File -Recurse)
  if ($ApkMatches.Count -ne 1) {
    throw "Expected exactly one gnirehtet.apk in the verified archive; found $($ApkMatches.Count)."
  }
  Copy-Item $ApkMatches[0].FullName (Join-Path $Target "gnirehtet.apk") -Force
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

Invoke-Step "Verify reverse-tether installer assets" {
  $Required = @(
    (Join-Path $ElectronRoot "resources\bin\win32\gnirehtet\gnirehtet.exe"),
    (Join-Path $ElectronRoot "resources\bin\win32\gnirehtet\gnirehtet.apk")
  )
  foreach ($Path in $Required) {
    if (-not (Test-Path $Path -PathType Leaf)) {
      throw "Required USB reverse-tether installer asset is missing: $Path"
    }
    Write-Host "Verified: $Path"
  }
}

$env:GYP_MSVS_VERSION = "2022"
$env:npm_config_msvs_version = "2022"

Invoke-Step "Build Windows installer" {
  npx electron-builder --win --publish never
}

$ReleaseDir = Join-Path $ElectronRoot "release"
Write-Host "`nInstaller created in: $ReleaseDir" -ForegroundColor Green
Start-Process explorer.exe $ReleaseDir