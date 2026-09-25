# Open the workbench in Chrome app mode.
# Ensures the local preview server (port 4173) is running, then launches Chrome.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$NodeExe = 'C:\Users\morty\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
$ProjectDir = 'F:\AI\workbuddyspace\2026-08-02-10-52-19\workbench-REPLICA'
$Port = 4173
$Url = 'http://localhost:' + $Port + '/'
$Vite = Join-Path $ProjectDir 'node_modules\vite\bin\vite.js'

function Test-Up {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

if (-not (Test-Up)) {
    Start-Process -FilePath $NodeExe -ArgumentList ($Vite, 'preview', '--port', [string]$Port, '--strictPort', '--host', '0.0.0.0') -WorkingDirectory $ProjectDir -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
        if (Test-Up) { break }
        Start-Sleep -Seconds 1
    }
}

$chrome = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($chrome) {
    # Round 43: honour the same window mode as launch-workbench.ps1 (window-pref.json).
    # Round 46d: same WB_WINDOW_PREF override, so tests never touch the real pref file.
    $windowMode = 'maximized'
    $prefFile = Join-Path $ProjectDir 'window-pref.json'
    if ($env:WB_WINDOW_PREF) { $prefFile = $env:WB_WINDOW_PREF }
    if (Test-Path $prefFile) {
        try {
            $pref = Get-Content -Path $prefFile -Raw | ConvertFrom-Json
            if ($pref -and ($pref.mode -eq 'remember')) { $windowMode = 'remember' }
        } catch {}
    }
    if ($windowMode -eq 'remember') {
        Start-Process -FilePath $chrome -ArgumentList ('--app=' + $Url)
    } else {
        Start-Process -FilePath $chrome -ArgumentList ('--app=' + $Url), '--window-size=1440,900', '--start-maximized'
    }
} else {
    [System.Windows.Forms.MessageBox]::Show('Chrome not found. Please install Google Chrome.', 'Workbench')
}
