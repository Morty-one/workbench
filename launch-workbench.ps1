# Workbench launcher (silent, ASCII-only, with a loading splash).

$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot
$NodeExe    = 'C:\Users\morty\.workbuddy\binaries\node\versions\22.22.2\node.exe'
# Point VBS to the 4173 preview so it opens the exact same build as the shared preview (no 5173 dev drift).
$Port        = 4173
$BridgePort  = 4567
$Url         = 'http://localhost:' + $Port + '/'
$BridgeScript = Join-Path $ProjectDir 'local-bridge.cjs'
# PID file recording the node processes WE spawned last launch, so we can kill
# exactly those (not by fragile command-line pattern matching) on next start.
$PidFile = Join-Path $ProjectDir '.wb_pids.txt'

# ---------- Loading splash in a SEPARATE hidden process ----------
# Kept apart so a display-less environment can never block the main flow.
$splashCode = @'
# Declare DPI awareness BEFORE creating any UI, so Windows draws the splash
# at the screen's native pixel resolution instead of bitmap-stretching it
# (which is what makes the text look blurry on 125%/150% scaled displays).
try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WBdpi {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
"@
    [WBdpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-2)) | Out-Null
} catch {}
Add-Type -AssemblyName System.Windows.Forms
$label = [char]0x6B63 + [char]0x5728 + [char]0x542F + [char]0x52A8 + [char]0x5DE5 + [char]0x4F5C + [char]0x53F0 + [char]0x2026
$form = New-Object System.Windows.Forms.Form
$form.Text              = 'Workbench'
$form.Size              = New-Object System.Drawing.Size(360, 140)
$form.MinimumSize       = New-Object System.Drawing.Size(360, 140)
$form.StartPosition     = 'CenterScreen'
$form.FormBorderStyle   = 'FixedDialog'
$form.ControlBox        = $false
$form.TopMost           = $true
$form.ShowInTaskbar     = $false
$form.AutoScaleMode     = 'Dpi'
$form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text      = $label
$lbl.AutoSize  = $false
$lbl.TextAlign = 'MiddleCenter'
$lbl.Dock      = 'Fill'
$lbl.Font      = New-Object System.Drawing.Font('SimSun', 14)
$form.Controls.Add($lbl)
[System.Windows.Forms.Application]::Run($form)
'@

$splashFile = Join-Path $env:TEMP ('wb_splash_' + $PID + '.ps1')
Set-Content -Path $splashFile -Value $splashCode -Encoding ASCII
$psExe = Join-Path $PSHome 'powershell.exe'
$splashProc = Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $splashFile
) -WindowStyle Hidden -PassThru

function Close-Splash {
    try { if (-not $splashProc.HasExited) { Stop-Process -Id $splashProc.Id -Force -ErrorAction SilentlyContinue } } catch {}
    try { Remove-Item $splashFile -Force -ErrorAction SilentlyContinue } catch {}
}

try {
    # 0) Kill precisely the node processes we launched last time (by recorded PID).
    #    This is the most reliable cleanup: it does not depend on command-line
    #    pattern matching, so even orphaned/old bridge processes get removed.
    #    A guard checks the process command line to avoid killing an unrelated
    #    process whose PID was recycled after a reboot.
    if (Test-Path $PidFile) {
        Get-Content -Path $PidFile -ErrorAction SilentlyContinue | ForEach-Object {
            $pidv = $_.Trim()
            if ($pidv -match '^\d+$') {
                try {
                    $proc = Get-WmiObject Win32_Process -Filter ("ProcessId=" + $pidv) -ErrorAction SilentlyContinue
                    if ($proc -and ($proc.CommandLine -like '*local-bridge.cjs*' -or `
                                    $proc.CommandLine -like '*vite*preview*' -or `
                                    $proc.CommandLine -like ('*' + $ProjectDir + '*'))) {
                        Stop-Process -Id ([int]$pidv) -Force -ErrorAction SilentlyContinue
                    }
                } catch {}
            }
        }
        try { Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue } catch {}
    }

    # 1) Kill any stale listener on the port so we always serve the latest build.
    function Kill-PortListener($p) {
        # (a) by TCP owner PID - most precise
        try {
            Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
                ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }
        } catch {}
        # (b) by command line - catches listeners the TCP lookup missed
        try {
            Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object {
                ($_.CommandLine -like '*vite*') -and (($_.CommandLine -like '*preview*') -or ($_.CommandLine -like "*$p*"))
            } | ForEach-Object {
                try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
            }
        } catch {}
    }
    Kill-PortListener $Port
    # 1b) Kill any stale local-bridge helper so the new one can bind 4567.
    Kill-PortListener $BridgePort
    Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*local-bridge.cjs*' } | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    # 1c) Extra safety: also kill any node.exe whose command line points to this project's bridge
    Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*$ProjectDir*local-bridge.cjs*" } | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    # give the OS a moment to release the socket (re-check below still guards slow releases)
    Start-Sleep -Milliseconds 400
    # re-check; if still bound, try once more before giving up
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Kill-PortListener $Port
        Start-Sleep -Milliseconds 1000
    }
    if (Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue) {
        Kill-PortListener $BridgePort
        Start-Sleep -Milliseconds 1000
    }

    # 2) Locate vite
    $vite = Join-Path $ProjectDir 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path $vite)) {
        throw "vite.js not found at: $vite. Run 'npm install' in the project first."
    }

    # 3) Rebuild only when source is newer than the built output (keeps launch fast).
    $needBuild = $true
    $distIndex = Join-Path $ProjectDir 'dist2\index.html'
    if (Test-Path $distIndex) {
        $srcNewest = Get-ChildItem (Join-Path $ProjectDir 'src') -Recurse -File |
                     Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($srcNewest -and ($srcNewest.LastWriteTime -le (Get-Item $distIndex).LastWriteTime)) {
            $needBuild = $false
        }
    }
    if ($needBuild) {
        Start-Process -FilePath $NodeExe -ArgumentList ('"' + $vite + '"', 'build') `
                      -WorkingDirectory $ProjectDir -WindowStyle Hidden -Wait
    }

    # 3b) Append a timestamp to JS/CSS URLs in dist2/index.html to defeat browser caching.
    $distIndexHtml = Join-Path $ProjectDir 'dist2\index.html'
    if (Test-Path $distIndexHtml) {
        $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
        $html = Get-Content -Path $distIndexHtml -Raw -Encoding UTF8
        # strip any existing query string, then add a fresh one
        $html = $html -replace '\?v=\d+"', '"'
        $html = $html -replace '(src="\./assets/[^"]+)"', ('$1?v=' + $ts + '"')
        $html = $html -replace '(href="\./assets/[^"]+)"', ('$1?v=' + $ts + '"')
        [System.IO.File]::WriteAllText($distIndexHtml, $html, [System.Text.Encoding]::UTF8)
    }

    # 4) Launch vite preview (port 4173) via the managed node binary, hidden window.
    #    --strictPort: refuse to start if 4173 is taken, so we never silently serve a stale build.
    $viteProc = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $vite + '"', 'preview', '--port', [string]$Port, '--strictPort', '--host', '0.0.0.0') `
                  -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru

    # 4b) Launch local bridge so web links can open local apps/files.
    $bridgeProc = $null
    if (Test-Path $BridgeScript) {
        $bridgeProc = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $BridgeScript + '"') `
                      -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru
    }

    # 4c) Record the PIDs we just spawned so next launch can kill exactly these.
    $pids = @()
    if ($viteProc -and $viteProc.Id) { $pids += $viteProc.Id }
    if ($bridgeProc -and $bridgeProc.Id) { $pids += $bridgeProc.Id }
    if ($pids.Count -gt 0) {
        try { Set-Content -Path $PidFile -Value $pids -Encoding ASCII -ErrorAction SilentlyContinue } catch {}
    }

    # 4d) Health-check the bridge: ensure the process responding on 4567 is OUR
    #     latest local-bridge.cjs (same mtime, REPLICA path). If an old/foreign
    #     bridge is still answering, kill it and retry once.
    function Test-BridgeHealth() {
        $expectedMs = 0
        try { $expectedMs = ([DateTimeOffset]((Get-Item $BridgeScript).LastWriteTimeUtc)).ToUnixTimeMilliseconds() } catch {}
        $bridgeUrl = 'http://127.0.0.1:' + $BridgePort + '/ping'
        for ($i = 0; $i -lt 40; $i++) {
            try {
                $r = Invoke-WebRequest -Uri $bridgeUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
                if ($r.StatusCode -eq 200) {
                    $data = $r.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
                    $actualMs = 0
                    if ($data) { $actualMs = [long]$data.mtimeMs }
                    $actualPath = ''
                    if ($data) { $actualPath = $data.bridgePath }
                    $pathOk = $actualPath -and ($actualPath -like ('*' + $ProjectDir + '*'))
                    # allow 2 second tolerance for filesystem timestamp precision
                    $mtimeOk = ($actualMs -gt 0) -and ([Math]::Abs($actualMs - $expectedMs) -le 2000)
                    if ($pathOk -and $mtimeOk) { return @{ok=$true; info="bridge ok"} }
                    return @{ok=$false; mtimeMs=$actualMs; path=$actualPath; expectedMs=$expectedMs}
                }
            } catch {}
            Start-Sleep -Milliseconds 500
        }
        return @{ok=$false; info="bridge did not respond"}
    }
    function Kill-All-Bridges() {
        Kill-PortListener $BridgePort
        try {
            Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*local-bridge.cjs*' } | ForEach-Object {
                try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
            }
        } catch {}
        Start-Sleep -Milliseconds 1500
    }
    $bridgeCheck = Test-BridgeHealth
    if (-not $bridgeCheck.ok) {
        Write-Host "Bridge health check failed, killing stale bridges and retrying..."
        Kill-All-Bridges
        # restart bridge
        if ($bridgeProc -and $bridgeProc.Id) {
            try { Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
        if (Test-Path $BridgeScript) {
            $bridgeProc = Start-Process -FilePath $NodeExe -ArgumentList ('"' + $BridgeScript + '"') `
                          -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru
            if ($bridgeProc -and $bridgeProc.Id) { $pids += $bridgeProc.Id }
        }
        $bridgeCheck = Test-BridgeHealth
        if (-not $bridgeCheck.ok) {
            throw ("Bridge health check failed. path=" + $bridgeCheck.path + " mtimeMs=" + $bridgeCheck.mtimeMs + " expectedMs=" + $bridgeCheck.expectedMs + ". Please end all node.exe and retry.")
        }
    }

    # 5) Poll (0.5s steps, up to 30s) for the preview to respond
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        throw "Server did not respond at $Url within 30 seconds."
    }

    # 6) Open the workbench as an app-style window (no address bar / no tabs),
    #    then dismiss the splash.
    #    Preference: Chrome --app > Edge --app > system default browser.
    #    Chrome's --start-maximized is unreliable in --app mode (well-known issue),
    #    so we also force-maximize via Win32 ShowWindow right after launch.
    $openUrl = $Url + '?_=' + [DateTime]::Now.Ticks
    $chromeCandidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    $edgeCandidates = @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )
    $appArgs = @('--app=' + $openUrl, '--window-size=1440,900', '--start-maximized')
    $chromeProc = $null
    $opened = $false
    foreach ($exe in $chromeCandidates) {
        if (Test-Path $exe) {
            $chromeProc = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
            $opened = $true
            break
        }
    }
    if (-not $opened) {
        foreach ($exe in $edgeCandidates) {
            if (Test-Path $exe) {
                $chromeProc = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
                $opened = $true
                break
            }
        }
    }
    if (-not $opened) {
        Start-Process $openUrl
    } else {
        # Dismiss the splash NOW: the browser window is already on its way up,
        # so the user should not stare at the "starting" overlay while we wait
        # to maximize the window (that wait can take a few seconds).
        Close-Splash
        # Win32 helper: maximize the app window owned by our PID; if Chrome
        # delegated to an already-running instance (our process exits right
        # away), fall back to matching the window by its page title instead.
        # Compiled AFTER launching the browser so csc runs in parallel with
        # Chrome's own startup instead of delaying it.
        Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class WinMax {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    public const int SW_MAXIMIZE = 3;
    private static string GetTitle(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, 512);
        return sb.ToString();
    }
    private static bool ProcAlive(uint pid) {
        try { Process p = Process.GetProcessById((int)pid); return !p.HasExited; }
        catch { return false; }
    }
    public static int MaximizeByPid(uint targetPid) {
        int count = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid && IsWindowVisible(hWnd)) {
                string t = GetTitle(hWnd);
                if (t.Length > 0) { ShowWindow(hWnd, SW_MAXIMIZE); SetForegroundWindow(hWnd); count++; }
            }
            return true;
        }, IntPtr.Zero);
        return count;
    }
    public static int MaximizeByTitle(string titlePart, string procNames) {
        string[] names = procNames.Split(';');
        int count = 0;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string pname = "";
            try { pname = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return true; }
            bool nameOk = false;
            foreach (string n in names) { if (n.Length > 0 && pname == n) { nameOk = true; break; } }
            if (!nameOk) return true;
            string t = GetTitle(hWnd);
            if (t.IndexOf(titlePart, StringComparison.Ordinal) >= 0) {
                ShowWindow(hWnd, SW_MAXIMIZE); SetForegroundWindow(hWnd); count++;
            }
            return true;
        }, IntPtr.Zero);
        return count;
    }
    public static int MaximizeSmart(uint pid, string titlePart, string procNames, int maxRetries, int intervalMs) {
        for (int i = 0; i < maxRetries; i++) {
            if (ProcAlive(pid)) {
                int c = MaximizeByPid(pid);
                if (c > 0) return c;
            } else {
                // Chrome delegated to an already-running instance: our PID will
                // never own the new window, so match it by page title instead.
                int c = MaximizeByTitle(titlePart, procNames);
                if (c > 0) return c;
            }
            Thread.Sleep(intervalMs);
        }
        return 0;
    }
}
'@
        if ($chromeProc -and $chromeProc.Id) {
            # Expected page title (built from char codes to keep this file pure ASCII).
            $titleCodes = @(0x4E2A, 0x4EBA, 0x8F7B, 0x91CF, 0x5DE5, 0x4F5C, 0x53F0)
            $expectedTitle = -join ($titleCodes | ForEach-Object { [char]$_ })
            [WinMax]::MaximizeSmart([uint32]$chromeProc.Id, $expectedTitle, 'chrome;msedge', 25, 200) | Out-Null
        }
    }
}
catch {
    Close-Splash
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.MessageBox]::Show(
        ("Workbench failed to start.`r`n`r`n" + $_.Exception.Message +
         "`r`n`r`nPlease run npm install in the project folder if modules are missing."),
        'Workbench', 'OK', 'Error'
    ) | Out-Null
    exit 1
}

Close-Splash
exit 0
