# win-max.ps1 - maximize the browser window that local-bridge.cjs is about to open.
#
# Why this exists: when the browser is ALREADY running, launching it with a URL makes the
# existing browser process create the new window/tab, and command-line switches
# (--start-maximized) are NOT applied to it. Measured 2026-09-25: with the browser up,
# `chrome.exe --start-maximized <url>` created no new window at all and maximized nothing.
# So the only reliable way is the Win32 call below.
#
# Contract with the bridge (order matters!):
#   1. bridge spawns this process with -Mode watch
#   2. this process enumerates the window handles that ALREADY exist for -Proc, then writes
#      "TAG=<tag> SNAP n=<count>" to -LogFile  (readiness marker)
#   3. bridge waits for that marker, then asks the browser to open the link
#   4. this process polls for a NEW window handle of -Proc and maximizes it
# => only windows created AFTER the snapshot are ever touched; pre-existing windows (e.g.
#    the workbench's own --app window) are never maximized by this path.
#
# Windows that are not resizable are SKIPPED (WS_THICKFRAME missing). Measured 2026-09-25:
# Chromium's "Restore pages?" bubble is such a window and appears BEFORE the real page, so
# it used to eat the maximize and the actual page stayed small.
#
# Round 45 fix #2 (measured): an "IsZoomed -> ALREADY -> exit" early out was WRONG. On a
# browser whose profile had been killed uncleanly, the crash-restore flow created the page
# window in a transient zoomed state, so IsZoomed read True, we exited without calling
# ShowWindow, and the window ended up NOT maximized (log showed ALREADY while an independent
# read later said zoomed=false). SW_MAXIMIZE on an already maximized window is a no-op, so
# there is nothing to save by checking: always call it, then VERIFY and retry.
#
# Verification is deliberately independent of IsZoomed: a maximized window's rect equals the
# monitor work area (taskbar preserved), so we compare GetWindowRect to SPI_GETWORKAREA.
#
# Modes:
#   -Mode list  : dump windows of -Proc with zoomed / resizable / rect / work area (diagnostics)
#   -Mode watch : snapshot + wait + maximize + verify (see contract above)
#
# ASCII ONLY - Windows PowerShell 5.1 parses this file with the system ANSI code page (GBK on
# this machine); a single non-ASCII byte corrupts the whole script.
param(
  [string]$Mode = 'watch',
  [string]$Proc = '',
  [string]$Tag = '',
  [string]$LogFile = '',
  [string]$SnapFile = '',
  [int]$TimeoutMs = 8000,
  [int]$IntervalMs = 150,
  [int]$Attempts = 3,
  [int]$VerifyDelayMs = 450
)

# ---------- C# type cache (round 45 speed-up) ----------
# Add-Type compiles the C# below AT RUNTIME with csc (measured ~1.0s when cold), and the bridge
# has to WAIT for our readiness marker before it launches the browser -- so that compile used to
# be paid on every single link click (~1.35s measured end to end). Compile the same source once
# into a cached assembly under %TEMP% and load that from then on (measured ~0.05s).
# The file name carries a hash of the source text, so editing the C# below automatically
# produces a NEW file -- there is nothing to invalidate by hand.
# Returns: cache | compile | fallback | fail. This function never throws.
function Get-CachedType {
  param([string]$CacheTag, [string]$Source, [string]$TypeName)
  # measured 2026-09-25: `Add-Type -TypeDefinition X -OutputAssembly f.dll` WRITES the assembly but
  # does not reliably bring the types into this session -- a cache-miss run therefore left [WbWin]
  # undefined and the script died right after writing its readiness marker. So (a) the cached
  # assembly is always also loaded with -Path, and (b) the outcome is verified by resolving the name.
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

$typeMode = Get-CachedType -CacheTag 'winmax-watch' -TypeName 'WbWin' -Source @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class WbWin {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, out RECT data, uint winIni);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
    public const int SW_MAXIMIZE = 3;
    public const int GWL_STYLE = -16;
    public const int WS_THICKFRAME = 0x00040000;
    public const uint SPI_GETWORKAREA = 0x0030;
    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    public static string Title(IntPtr h) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }
    public static string ProcName(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        try { return Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { return ""; }
    }
    public static bool IsResizable(IntPtr h) {
        return (GetWindowLong(h, GWL_STYLE) & WS_THICKFRAME) != 0;
    }
    public static string RectStr(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) { return "n/a"; }
        return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    }
    public static string WorkStr() {
        RECT w;
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out w, 0)) { return "n/a"; }
        return w.Left + "," + w.Top + "," + w.Right + "," + w.Bottom;
    }
    // Primary monitor size, for proving the taskbar is still there (work area < screen).
    public static string ScreenStr() {
        return GetSystemMetrics(SM_CXSCREEN) + "x" + GetSystemMetrics(SM_CYSCREEN);
    }
    // Independent of IsZoomed: a maximized window covers the monitor work area (taskbar kept).
    // Measured 2026-09-25: on this 175%-scaled 2560x1600 display a maximized window reports
    // rect = (-7,-7,1470,873) while the work area is (0,0,1463,866) -- modern Windows makes a
    // maximized window bleed past the work area by the invisible resize border (7px here).
    // So "maximized" = covers the work area, overshoot within Tolerance, and same size +-2*Tol.
    public const int WORK_TOL = 20;
    public static bool FillsWorkArea(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) { return false; }
        RECT w;
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out w, 0)) { return false; }
        int tol = WORK_TOL;
        bool covers = r.Left <= w.Left && r.Top <= w.Top && r.Right >= w.Right && r.Bottom >= w.Bottom;
        bool close = r.Left >= w.Left - tol && r.Top >= w.Top - tol && r.Right <= w.Right + tol && r.Bottom <= w.Bottom + tol;
        bool sameSize = Math.Abs((r.Right - r.Left) - (w.Right - w.Left)) <= 2 * tol
                     && Math.Abs((r.Bottom - r.Top) - (w.Bottom - w.Top)) <= 2 * tol;
        return covers && close && sameSize;
    }
    public static string WorkDelta(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) { return "n/a"; }
        RECT w;
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, out w, 0)) { return "n/a"; }
        return "dL" + (r.Left - w.Left) + ",dT" + (r.Top - w.Top) + ",dR" + (r.Right - w.Right) + ",dB" + (r.Bottom - w.Bottom);
    }
    public static List<IntPtr> All(string procName) {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p) {
            if (!IsWindowVisible(h)) return true;
            if (ProcName(h) != procName) return true;
            if (Title(h).Length == 0) return true;
            list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@

function Write-Log([string]$text) {
  if ($LogFile -ne '') {
    try { Add-Content -Path $LogFile -Value $text -Encoding UTF8 } catch {}
  }
  [Console]::Out.WriteLine($text)
}

# The Win32 type must exist before anything below touches [WbWin]. If it does not, say so in the
# log and exit -- the bridge treats a missing readiness marker as a timeout and still opens the
# link (maximizing is best-effort, opening is not).
if ($typeMode -eq 'fail') {
  Write-Log ("TAG=$Tag ERROR=addtype-failed")
  exit 3
}

if ($Proc -eq '') {
  Write-Log ("TAG=$Tag ERROR=missing-proc")
  exit 2
}
$procName = $Proc.ToLowerInvariant()

if ($Mode -eq 'list') {
  Write-Log ("SCREEN=" + [WbWin]::ScreenStr())
  Write-Log ("WORK=" + [WbWin]::WorkStr())
  $all = [WbWin]::All($procName)
  if ($all.Count -eq 0) {
    Write-Log ("NONE proc=$procName")
    exit 0
  }
  foreach ($h in $all) {
    Write-Log ("HWND=" + [int64]$h + " zoomed=" + [WbWin]::IsZoomed($h) + " resizable=" + [WbWin]::IsResizable($h) + " fills=" + [WbWin]::FillsWorkArea($h) + " rect=" + [WbWin]::RectStr($h) + " delta=" + [WbWin]::WorkDelta($h) + " title=[" + [WbWin]::Title($h) + "]")
  }
  exit 0
}

if ($Mode -ne 'watch') {
  Write-Log ("TAG=$Tag ERROR=bad-mode mode=$Mode")
  exit 2
}

# ---- 1) snapshot the windows that already exist ----
$before = [WbWin]::All($procName)
$known = @{}
foreach ($h in $before) { $known[[int64]$h] = $true }
if ($SnapFile -ne '') {
  try {
    $snapText = ($before | ForEach-Object { [int64]$_ }) -join ","
    Set-Content -Path $SnapFile -Value $snapText -Encoding UTF8
  } catch {}
}
# type= tells you whether this run paid the csc compile (compile) or reused the cached
# assembly (cache) -- if it says compile on every click, the %TEMP% cache is not working.
Write-Log ("TAG=$Tag SNAP n=" + $before.Count + " proc=$procName type=$typeMode")

# ---- 2) wait for a NEW resizable window of that process ----
$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$target = [IntPtr]::Zero
$skipped = @{}
while ([DateTime]::UtcNow -lt $deadline) {
  foreach ($h in [WbWin]::All($procName)) {
    if ($known.ContainsKey([int64]$h)) { continue }
    if (-not [WbWin]::IsResizable($h)) {
      # log each non-resizable window only once (the poll loop runs every $IntervalMs)
      if (-not $skipped.ContainsKey([int64]$h)) {
        $skipped[[int64]$h] = $true
        Write-Log ("TAG=$Tag SKIP_NORESIZE hwnd=" + [int64]$h + " title=[" + [WbWin]::Title($h) + "]")
      }
      continue
    }
    $target = $h
    break
  }
  if ($target -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds $IntervalMs
}

if ($target -eq [IntPtr]::Zero) {
  Write-Log ("TAG=$Tag NOMAX known=" + $before.Count)
  exit 0
}

# ---- 3) maximize it, then verify and retry ----
# Never trust one ShowWindow: Chromium can (re)apply its own placement right after the window
# is created, and IsZoomed can read True for a window that is not actually maximized.
$attempt = 0
$ok = $false
while ($attempt -lt $Attempts) {
  $attempt++
  $pre = [WbWin]::IsZoomed($target)
  [void][WbWin]::ShowWindow($target, [WbWin]::SW_MAXIMIZE)
  [void][WbWin]::SetForegroundWindow($target)
  Write-Log ("TAG=$Tag MAXED hwnd=" + [int64]$target + " title=[" + [WbWin]::Title($target) + "] attempt=$attempt preZoomed=$pre")
  Start-Sleep -Milliseconds $VerifyDelayMs
  if ([WbWin]::IsZoomed($target) -and [WbWin]::FillsWorkArea($target)) { $ok = $true; break }
}
Write-Log ("TAG=$Tag VERIFY zoomed=$ok attempts=$attempt rect=" + [WbWin]::RectStr($target) + " work=" + [WbWin]::WorkStr() + " screen=" + [WbWin]::ScreenStr() + " delta=" + [WbWin]::WorkDelta($target))
exit 0
