# @file Restart-ChromeWithCDP.ps1
# @description Close Chrome and relaunch with --remote-debugging-port=9222 (preserves profile/login).
#              After running this, use: npm run dev -- grab-cookie
# @version 1.0.0
# @created 2026-05-27T00:00:00Z
# @lastUpdated 2026-05-27T00:00:00Z

param(
    [int]$Port = 9222,
    [string]$Browser = "chrome"   # "chrome" or "edge"
)

$ErrorActionPreference = "Stop"

function Find-BrowserExe($browser) {
    $pf   = $env:ProgramFiles
    $pf86 = ${env:ProgramFiles(x86)}
    $local = $env:LOCALAPPDATA

    if ($browser -eq "edge") {
        $candidates = @(
            "$pf\Microsoft\Edge\Application\msedge.exe",
            "$pf86\Microsoft\Edge\Application\msedge.exe",
            "$local\Microsoft\Edge\Application\msedge.exe"
        )
        $procName = "msedge"
        $userDataDir = "$local\Microsoft\Edge\User Data"
    } else {
        $candidates = @(
            "$pf\Google\Chrome\Application\chrome.exe",
            "$pf86\Google\Chrome\Application\chrome.exe",
            "$local\Google\Chrome\Application\chrome.exe"
        )
        $procName = "chrome"
        $userDataDir = "$local\Google\Chrome\User Data"
    }

    foreach ($c in $candidates) {
        if (Test-Path $c) { return @{ exe = $c; proc = $procName; data = $userDataDir } }
    }
    return @{ exe = "$browser.exe"; proc = $procName; data = $userDataDir }
}

$info = Find-BrowserExe $Browser
Write-Host "Browser : $($info.exe)"
Write-Host "Profile : $($info.data)"
Write-Host "CDP port: $Port"
Write-Host ""

# Step 1 — Close existing browser
Write-Host "1. Closing $Browser..." -ForegroundColor Cyan
try {
    Stop-Process -Name $info.proc -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-Host "   Closed." -ForegroundColor Green
} catch {
    Write-Host "   $Browser was not running." -ForegroundColor Gray
}

# Step 2 — Relaunch with remote debugging flag
Write-Host "2. Launching $Browser with --remote-debugging-port=$Port..." -ForegroundColor Cyan
$args = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=`"$($info.data)`"",
    "--no-first-run",
    "--no-default-browser-check",
    "https://claude.ai"
)
Start-Process -FilePath $info.exe -ArgumentList $args

# Step 3 — Wait for CDP to be ready
Write-Host "3. Waiting for CDP endpoint..." -ForegroundColor Cyan
$ready = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
    Write-Host "   ..." -ForegroundColor Gray
}

if ($ready) {
    Write-Host "   CDP ready on port $Port." -ForegroundColor Green
    Write-Host ""
    Write-Host "Now run:" -ForegroundColor Yellow
    Write-Host "  npm run dev -- grab-cookie" -ForegroundColor White
    Write-Host "  # or with auto-restart next time:"
    Write-Host "  npm run dev -- grab-cookie --auto-restart"
} else {
    Write-Host "   CDP not ready after 30s. Check that $Browser launched successfully." -ForegroundColor Red
    exit 1
}
