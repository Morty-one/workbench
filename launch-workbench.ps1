# Workbench launcher (silent, ASCII-only, with a loading splash).

$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot
$NodeExe    = 'C:\Users\morty\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
# Point VBS to the 4173 preview so it opens the exact same build as the shared preview (no 5173 dev drift).
$Port        = 4173
$BridgePort  = 4567
$Url         = 'http://localhost:' + $Port + '/'
$BridgeScript = Join-Path $ProjectDir 'local-bridge.cjs'
# PID file recording the node processes WE spawned last launch, so we can kill
# exactly those (not by fragile command-line pattern matching) on next start.
$PidFile = Join-Path $ProjectDir '.wb_pids.txt'

# ---------- C# type cache (round 45 speed-up) ----------
# Add-Type compiles the C# source AT RUNTIME with csc (measured ~1.0s). We need a Win32 helper
# here (and again in scripts\win-max.ps1), and that compile used to be paid on every single
# launch / every link click. Compile the same source once into a cached assembly under %TEMP%
# and load that from then on (measured ~0.05s). The file name carries a hash of the source text,
# so editing the C# below automatically produces a NEW file -- nothing to invalidate by hand.
# Returns: cache | compile | fallback | fail. Never throws on its own.
function Get-CachedType {
  param([string]$CacheTag, [string]$Source, [string]$TypeName)
  # measured 2026-09-25: `Add-Type -TypeDefinition X -OutputAssembly f.dll` WRITES the assembly but
  # does not reliably bring the types into this session -- a cache-miss run therefore left the
  # helper type undefined and the caller silently skipped its work. So (a) the cached assembly is
  # always also loaded with -Path, and (b) the outcome is verified by resolving the type NAME.
  $dir = Join-Path $env:TEMP 'wb-type-cache'
  $dll = ''
  try {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $hash = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Source)) | ForEach-Object { $_.ToString('x2') }) -join '')
    try { $sha.Dispose() } catch {}
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $dll = Join-Path $dir ('wb-' + $CacheTag + '-' + $hash.Substring(0, 12) + '.dll')
  } catch { $dll = '' }
  # (1) cache hit: load the prebuilt assembly -- no csc involved (measured ~27ms vs ~1.0s)
  if ($dll -ne '' -and (Test-Path $dll)) {
    try { Add-Type -Path $dll -ErrorAction Stop } catch {}
    $ok = $false
    try { [void][type]$TypeName; $ok = $true } catch {}
    if ($ok) { return 'cache' }
  }
  # (2) miss: compile once into the cache file, then make sure the types really are loaded
  if ($dll -ne '') {
    try { Add-Type -TypeDefinition $Source -OutputAssembly $dll -ErrorAction Stop } catch {}
    if (Test-Path $dll) { try { Add-Type -Path $dll -ErrorAction Stop } catch {} }
    $ok = $false
    try { [void][type]$TypeName; $ok = $true } catch {}
    if ($ok) { return 'compile' }
  }
  # (3) last resort: in-memory compile (temp dir unwritable / assembly locked / csc produced nothing)
  try { Add-Type -TypeDefinition $Source -ErrorAction Stop } catch {}
  $ok = $false
  try { [void][type]$TypeName; $ok = $true } catch {}
  if ($ok) { return 'fallback' }
  return 'fail'
}

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
    #
    #    Round 45 speed-up: take ONE node.exe snapshot and match everything in memory.
    #    The old code called Get-WmiObject six times here plus once per recorded PID
    #    (measured 117-306ms each => ~1.2s of startup just waiting for WMI) and called
    #    Get-NetTCPConnection (CIM, measured 1316ms on first use) unconditionally.
    #    The snapshot is deliberately taken BEFORE anything is killed, so a process we
    #    are about to start can never be matched.
    $nodeSnaps = @()
    try { $nodeSnaps = @(Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue) } catch {}

    # Cheap port probe: a 200ms TCP connect instead of the CIM query. We only need to know
    # "is anything still listening here"; WHO owns it only matters if the cheap pass missed it.
    function Test-PortBusy([int]$p) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $iar = $client.BeginConnect('127.0.0.1', $p, $null, $null)
            if ($iar.AsyncWaitHandle.WaitOne(200)) { $client.EndConnect($iar); return $true }
            return $false
        } catch { return $false } finally { try { $client.Close() } catch {} }
    }

    if (Test-Path $PidFile) {
        Get-Content -Path $PidFile -ErrorAction SilentlyContinue | ForEach-Object {
            $pidv = $_.Trim()
            if ($pidv -match '^\d+$') {
                try {
                    $proc = $nodeSnaps | Where-Object { $_.ProcessId -eq [int]$pidv } | Select-Object -First 1
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
    #    Round 45: order flipped to cheap-first. The command-line pass runs unconditionally
    #    (it catches our own vite preview / anything with the port in its command line), and
    #    the expensive TCP-owner lookup only happens if the port is STILL busy afterwards.
    #    The set of processes killed is unchanged -- this only avoids paying ~1.3s for a CIM
    #    query that the first pass has already solved.
    function Kill-PortListener($p) {
        # (a) by command line - catches listeners the TCP lookup would have found
        foreach ($proc in $nodeSnaps) {
            try {
                if (($proc.CommandLine -like '*vite*') -and (($proc.CommandLine -like '*preview*') -or ($proc.CommandLine -like "*$p*"))) {
                    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
                }
            } catch {}
        }
        # (b) still busy => something the command line cannot identify owns it; ask TCP who
        if (Test-PortBusy $p) {
            try {
                Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
                    ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }
            } catch {}
        }
    }
    Kill-PortListener $Port
    # 1b) Kill any stale local-bridge helper so the new one can bind 4567.
    Kill-PortListener $BridgePort
    # 1c) The bridge itself. The old 1b/1c pair was redundant ('*local-bridge.cjs*' already
    #     covers the project-path variant), so one pass over the snapshot replaces both.
    foreach ($proc in $nodeSnaps) {
        try {
            if ($proc.CommandLine -like '*local-bridge.cjs*') {
                Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
            }
        } catch {}
    }
    # give the OS a moment to release the socket (re-check below still guards slow releases)
    Start-Sleep -Milliseconds 400
    # re-check; if still bound, try once more before giving up
    if (Test-PortBusy $Port) {
        Kill-PortListener $Port
        Start-Sleep -Milliseconds 1000
    }
    if (Test-PortBusy $BridgePort) {
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
    #    Preference: Edge --app > Chrome --app > system default browser.
    #    Edge routes Web Speech to Microsoft's service (works in China); Chrome
    #    routes it to Google (blocked in China), so Edge is preferred for voice.
    #    Chrome's --start-maximized is unreliable in --app mode (well-known issue),
    #    so we also force-maximize via Win32 ShowWindow right after launch.
    $openUrl = $Url + '?_=' + [DateTime]::Now.Ticks
    # Window mode (round 43): read window-pref.json, which the web UI writes through the local
    # bridge (Settings -> browser & open-with). The web page cannot tell us anything here --
    # it does not exist yet -- so the choice has to be persisted to a file.
    #   maximized (default) = pass the COMPUTED work-area size + --start-maximized, then
    #                         force-maximize via Win32 (see round 46b note below: the size must be
    #                         handed in, otherwise the window is born small and jumps later)
    #   remember            = pass NO size/maximize flag at all, so the browser restores its own
    #                         last window placement for this URL (Edge/Chrome remember it per app)
    $windowMode = 'maximized'
    $prefFile = Join-Path $ProjectDir 'window-pref.json'
    # Round 46d: WB_WINDOW_PREF overrides the pref file path so automated tests can point at
    # their own temp file and never touch the real window-pref.json. (The sandbox has a per-turn
    # file-delete quota; when the cleanup unlink fails it is swallowed, which once silently left
    # the user's setting stuck on 'remember' -- i.e. click-to-maximize quietly disabled.)
    if ($env:WB_WINDOW_PREF) { $prefFile = $env:WB_WINDOW_PREF }
    if (Test-Path $prefFile) {
        try {
            $pref = Get-Content -Path $prefFile -Raw | ConvertFrom-Json
            if ($pref -and ($pref.mode -eq 'remember')) { $windowMode = 'remember' }
        } catch {}
    }
    $edgeCandidates = @(
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )
    $chromeCandidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    if ($windowMode -eq 'remember') {
        $appArgs = @('--app=' + $openUrl)
    } else {
        # Round 46b (2026-09-25): HAND THE BORN SIZE IN AGAIN -- computed, not the old literal 1440,900.
        # Round 45 removed --window-size completely, and that made the window appear at whatever size
        # the browser remembered and only grow to maximized about a second later -- reported by the
        # user as "it opens a non-fullscreen window first, then jumps to fullscreen".
        # --start-maximized cannot cover that on its own: when the browser is ALREADY running, the new
        # window is created by that existing process, which never sees the switch (measured: the switch
        # is read by the process that creates the window, and a forwarded launch has no such switch).
        # So the born geometry is decided ONLY by --window-size / --window-position.
        # Target = the work area (taskbar kept), i.e. exactly what MaximizeSmart verifies against
        # below, so the later SW_MAXIMIZE only pushes the invisible resize border off-screen
        # (measured 7 DIP px) and there is no visible jump.
        # Units: Chromium reads --window-size in DIP (logical) pixels. This process never sets a DPI
        # awareness context (only the splash child does), so WinForms already reports the work area in
        # that same virtualized space -- measured 1463,866 here, vs 2560,1516 physical at 175%.
        $bornSize = ''
        try {
            Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
            $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
            if ($wa -and $wa.Width -gt 200 -and $wa.Height -gt 200) {
                $bornSize = ('' + $wa.Width + ',' + $wa.Height)
            }
        } catch {}
        if ($bornSize -ne '') {
            $appArgs = @('--app=' + $openUrl, '--window-position=0,0', '--window-size=' + $bornSize, '--start-maximized')
        } else {
            # No display / WinForms unavailable: fall back to the plain round-45 behaviour.
            $appArgs = @('--app=' + $openUrl, '--start-maximized')
        }
    }
    $edgeProc = $null
    $opened = $false
    foreach ($exe in $edgeCandidates) {
        if (Test-Path $exe) {
            $edgeProc = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
            $opened = $true
            break
        }
    }
    if (-not $opened) {
        foreach ($exe in $chromeCandidates) {
            if (Test-Path $exe) {
                $edgeProc = Start-Process -FilePath $exe -ArgumentList $appArgs -PassThru
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
        # Round 45: still compiled AFTER launching the browser (so the browser's own startup
        # is not delayed), but now through Get-CachedType -- only the very first run on a
        # machine pays the ~1.0s csc compile, later runs load a prebuilt assembly (~0.05s),
        # which also means the force-maximize below runs ~1s sooner than before.
        $typeMode = Get-CachedType -CacheTag 'winmax-launch' -TypeName 'WinMax' -Source @'
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
            // Round 46b (2026-09-25): try BOTH branches every round instead of gating the title
            // branch on ProcAlive(pid)==false. Measured reasoning: when the browser is already
            // running, our launch process delegates and then LINGERS for a while; during that time
            // MaximizeByPid finds nothing (the new window belongs to the long-lived browser process,
            // not to us) and the title branch never ran, so the window stayed small until the
            // launcher exited -- the "opens small, then jumps to full screen" the user reported.
            // Running the title branch immediately is a strict superset of the old behaviour: it
            // only adds attempts in cases where nothing was attempted before, and a title match is
            // by definition a window of the target page (the pid branch is still tried first).
            int c = 0;
            if (ProcAlive(pid)) c = MaximizeByPid(pid);
            if (c == 0) c = MaximizeByTitle(titlePart, procNames);
            if (c > 0) return c;
            Thread.Sleep(intervalMs);
        }
        return 0;
    }
}
'@
        if ($edgeProc -and $edgeProc.Id -and ($windowMode -ne 'remember')) {
            # 'remember' mode must NOT be force-maximized -- the whole point is to let the
            # browser restore the size/position the user last used for this app window.
            # Expected page title (built from char codes to keep this file pure ASCII).
            $titleCodes = @(0x4E2A, 0x4EBA, 0x8F7B, 0x91CF, 0x5DE5, 0x4F5C, 0x53F0)
            $expectedTitle = -join ($titleCodes | ForEach-Object { [char]$_ })
            # Wrapped: the browser window is ALREADY up at this point, so a helper failure
            # (type unavailable) must never surface as "workbench failed to start".
            # Round 46b: cadence tightened from (25, 200ms) to (60, 60ms) -- the window is checked
            # roughly every 60ms instead of every 200ms, so the maximize lands right after the window
            # exists instead of up to 200ms later (same 3.6s overall budget as the old 5s).
            try {
                [WinMax]::MaximizeSmart([uint32]$edgeProc.Id, $expectedTitle, 'chrome;msedge', 60, 60) | Out-Null
            } catch {}
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
