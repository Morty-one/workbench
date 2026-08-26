# Scheduled runner for DocOutput. ASCII-only.
# Ensures the local bridge is listening, then triggers the last saved job.
# Invoked by Windows Task Scheduler (created from the DocOutput UI).

$ErrorActionPreference = 'Stop'
$port = 4567
$proj = Split-Path $PSScriptRoot -Parent
$bridgeScript = Join-Path $proj 'local-bridge.cjs'

$node = $null
foreach ($cand in @('C:\Users\morty\.workbuddy\binaries\node\versions\22.22.2\node.exe', 'node')) {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $node = $cand; break }
}
if (-not $node) { Write-Host 'node not found'; exit 1 }

$listening = $false
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $tcp.Connect('127.0.0.1', $port)
  $listening = $true
  $tcp.Close()
} catch {}

if (-not $listening) {
  Write-Host 'bridge not running, starting it'
  Start-Process -FilePath $node -ArgumentList ("`"$bridgeScript`"") -WorkingDirectory $proj -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$port/doc-output-run" -Method Post -TimeoutSec 15
  Write-Host 'triggered doc-output-run'
} catch {
  Write-Host "trigger failed: $_"
}
