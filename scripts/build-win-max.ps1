# build-win-max.ps1 - compile scripts/win-max-src.cs into scripts/win-max.exe
#
# WHY: the bridge must start its window watcher BEFORE opening the link, so the watcher's
# start-up cost lands on the user's click. Measured 2026-09-25 on this machine:
#   powershell.exe -NoProfile -Command exit   ~1122 ms
#   the .exe produced by this script            ~64 ms
#
# BEHAVIOUR
#   - skips compiling when the exe already matches the current source hash (reads the sidecar)
#     -> costs one small file read on a normal launch
#   - -Force recompiles unconditionally
#   - always verifies the result by RUNNING it (`--mode list` must print SCREEN=), because a
#     compiler that writes a file is not proof that the file works
#   - exit codes: 0 = exe ready, 2 = source missing, 3 = compile failed, 4 = built but unusable
#
# ASCII ONLY - Windows PowerShell 5.1 parses this file with the system ANSI code page (GBK on
# this machine); a single non-ASCII byte corrupts the whole script.
param(
  [switch]$Force,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$src = Join-Path $root 'win-max-src.cs'
$exe = Join-Path $root 'win-max.exe'
$side = Join-Path $root 'win-max.exe.sha1'

function Say([string]$m) { if (-not $Quiet) { [Console]::Out.WriteLine($m) } }

if (-not (Test-Path $src)) { Say 'BUILD_WINMAX=source-missing'; exit 2 }

$text = ''
try { $text = [System.IO.File]::ReadAllText($src) } catch { Say 'BUILD_WINMAX=source-unreadable'; exit 2 }
$ascii = $true
foreach ($ch in $text.ToCharArray()) { if ([int]$ch -gt 127) { $ascii = $false; break } }
if (-not $ascii) { Say 'BUILD_WINMAX=source-not-ascii'; exit 2 }

$sha = [System.Security.Cryptography.SHA1]::Create()
$hash = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join '')
try { $sha.Dispose() } catch {}

# ---- skip when up to date ----
if (-not $Force -and (Test-Path $exe) -and (Test-Path $side)) {
  $old = ''
  try { $old = ([System.IO.File]::ReadAllText($side)).Trim() } catch {}
  if ($old -eq $hash) { Say ('BUILD_WINMAX=up-to-date ' + $hash.Substring(0, 12)); exit 0 }
}

Say ('BUILD_WINMAX=compiling ' + $hash.Substring(0, 12))
try { if (Test-Path $exe) { Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue } } catch {}

$compiled = $false
try {
  Add-Type -TypeDefinition $text -OutputAssembly $exe -OutputType ConsoleApplication -ErrorAction Stop
  $compiled = $true
} catch {
  Say ('BUILD_WINMAX=compile-error ' + $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' '))
}
if (-not $compiled -or -not (Test-Path $exe)) { Say 'BUILD_WINMAX=compile-failed'; exit 3 }

$size = 0
try { $size = (Get-Item -LiteralPath $exe).Length } catch {}
Say ('BUILD_WINMAX=compiled bytes=' + $size)

# ---- verify by running it (a written file is not a working file) ----
$probeLog = Join-Path $env:TEMP ('wb-winmax-selftest-' + $hash.Substring(0, 8) + '.log')
try { if (Test-Path $probeLog) { [System.IO.File]::WriteAllText($probeLog, '') } } catch {}
$ran = $false
try {
  $p = Start-Process -FilePath $exe -ArgumentList @('--mode', 'list', '--proc', '__wb_selftest__', '--logfile', $probeLog) -NoNewWindow -Wait -PassThru
  $ran = ($p.ExitCode -eq 0)
} catch { $ran = $false }
$probe = ''
try { $probe = [System.IO.File]::ReadAllText($probeLog) } catch {}
if (-not $ran -or $probe.IndexOf('SCREEN=') -lt 0) {
  Say ('BUILD_WINMAX=unusable ran=' + $ran + ' log=[' + $probe.Replace("`r", ' ').Replace("`n", ' ; ') + ']')
  exit 4
}

try { [System.IO.File]::WriteAllText($side, $hash) } catch {}
Say ('BUILD_WINMAX=ok ' + $hash.Substring(0, 12) + ' probe=[' + $probe.Replace("`r", ' ').Replace("`n", ' ; ') + ']')
exit 0
