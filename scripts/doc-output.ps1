# DocOutput orchestrator. ASCII-only source (PowerShell 5.1 on GBK-Windows mis-parses
# any non-ASCII bytes). Chinese names/paths come from the job JSON at runtime (UTF-8),
# never as script literals. Step names + error templates are English; the web UI
# translates them to Chinese. This lets the user see exactly which step failed and why.

param(
  [Parameter(Mandatory = $true)][string]$Job
)

$ErrorActionPreference = 'Stop'

$jobDir = Split-Path $Job -Parent
$logPath = Join-Path $jobDir 'doc-output.log'
$resultPath = Join-Path $jobDir 'doc-output-result.json'

try { Remove-Item $logPath -Force -ErrorAction SilentlyContinue } catch {}
try { Remove-Item $resultPath -Force -ErrorAction SilentlyContinue } catch {}

function Write-Log($msg) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

$steps = @()
$stepIdx = 0
$lastFail = ''
function Add-Step($name, $ok, $detail) {
  $script:steps += @{ step = $script:stepIdx; name = $name; ok = $ok; detail = $detail }
  $script:stepIdx++
  if (-not $ok) { $script:lastFail = $detail }
}

function Set-Result($ok, $err) {
  $obj = @{
    ok        = $ok
    finishedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    steps     = $steps
    error     = $err
  }
  $json = $obj | ConvertTo-Json -Compress
  # UTF8Encoding($false) = UTF-8 WITHOUT BOM. PowerShell 5.1 [System.Text.Encoding]::UTF8
  # and Set-Content -Encoding UTF8 both emit a BOM, which makes Node JSON.parse throw
  # ("Unexpected token"). The bridge reads this file via JSON.parse, so a BOM breaks
  # the web UI status. Write BOM-less.
  [System.IO.File]::WriteAllText($resultPath, $json, (New-Object System.Text.UTF8Encoding $false))
}

function Sheet-List($wb) {
  $names = @()
  foreach ($sh in $wb.Sheets) { $names += $sh.Name }
  return ($names -join ', ')
}
function Sheet-Exists($wb, $name) {
  try { $x = $wb.Sheets.Item($name); return $true } catch { return $false }
}

# Parse "A1" / "$A$1" into row/col numbers (1-based).
function Get-RowCol($cell) {
  $cell = [string]$cell -replace '[^\w]', ''
  if ($cell -match '^([A-Za-z]+)(\d+)$') {
    $colStr = $Matches[1].ToUpper()
    $row = [int]$Matches[2]
    $col = 0
    for ($i = 0; $i -lt $colStr.Length; $i++) {
      $col = $col * 26 + ([int][char]$colStr[$i] - 64)
    }
    return @{ row = $row; col = $col }
  }
  return @{ row = 1; col = 1 }
}

function Get-RangeDims($range) {
  $parts = ([string]$range -split ':')
  $a = $parts[0]; $b = if ($parts.Length -gt 1) { $parts[1] } else { $a }
  $ra = Get-RowCol $a; $rb = Get-RowCol $b
  return @{
    rows = [math]::Abs($rb.row - $ra.row) + 1
    cols = [math]::Abs($rb.col - $ra.col) + 1
  }
}

# Run a macro by name, trying multiple resolution strategies so that personal
# macros (often stored in PERSONAL.XLSB) and macros in any open workbook are found.
$script:personalLoaded = $false
function Invoke-Macro($macro, $label) {
  $tried = @()
  # 1) bare name - Excel searches active + open workbooks + add-ins
  try { $excel.Run($macro); return }
  catch { $tried += ('bare: ' + $_.Exception.Message) }
  # 2) qualify with PERSONAL.XLSB (the usual home of personal macros)
  if ($script:personalLoaded) {
    try { $excel.Run("'PERSONAL.XLSB'!" + $macro); return }
    catch { $tried += ('PERSONAL.XLSB!: ' + $_.Exception.Message) }
  }
  # 3) iterate all open workbooks and qualify explicitly
  foreach ($wb in $excel.Workbooks) {
    try {
      $excel.Run($wb.Name + '!' + $macro)
      Write-Log ("Macro '$macro' resolved in workbook: " + $wb.Name)
      return
    } catch { $tried += ($wb.Name + '!: ' + $_.Exception.Message) }
  }
  # 4) iterate installed add-ins and try "AddInName!macro"
  foreach ($addIn in $excel.AddIns) {
    if (-not $addIn.Installed) { continue }
    try {
      $excel.Run($addIn.Name + '!' + $macro)
      Write-Log ("Macro '$macro' resolved in add-in: " + $addIn.Name)
      return
    } catch { $tried += ($addIn.Name + '!: ' + $_.Exception.Message) }
  }
  throw ("All strategies failed for macro '$macro': " + ($tried -join ' | '))
}

# Search common Excel/WPS add-in folders for a file name or full path passed from config.
function Find-AddIn($name) {
  if (-not $name) { return $null }
  # If the user pasted a full path, use it directly.
  if ($name -match '^[A-Za-z]:\\' -or $name -match '^\\\\') {
    if (Test-Path $name) { return $name }
    return $null
  }
  $aDir = if ($aPath) { Split-Path $aPath -Parent } else { $null }
  $bDir = if ($bPath) { Split-Path $bPath -Parent } else { $null }
  $progFiles = if ($env:ProgramFiles) { $env:ProgramFiles } else { 'C:\Program Files' }
  $progFilesX86 = if (${env:ProgramFiles(x86)}) { ${env:ProgramFiles(x86)} } else { 'C:\Program Files (x86)' }
  $dirs = @(
    (Join-Path $env:APPDATA 'Microsoft\Excel\XLSTART'),
    (Join-Path $env:APPDATA 'Microsoft\AddIns'),
    (Join-Path $env:APPDATA 'Kingsoft\office6'),
    (Join-Path $env:LOCALAPPDATA 'Kingsoft\WPS Office'),
    (Join-Path $env:APPDATA 'WPS Office'),
    (Join-Path $progFiles 'WPS Office\office6\addins'),
    (Join-Path $progFilesX86 'WPS Office\office6\addins'),
    (Join-Path $env:USERPROFILE 'Documents'),
    $aDir,
    $bDir,
    $jobDir
  )
  foreach ($dir in $dirs) {
    if (-not $dir -or -not (Test-Path $dir)) { continue }
    $exact = Join-Path $dir $name
    if (Test-Path $exact) { return $exact }
    try {
      $found = Get-ChildItem -Path $dir -Filter $name -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { return $found.FullName }
    } catch {}
  }
  # Last resort: shallow search under the user profile (depth-limited to keep it fast).
  try {
    $profileDir = $env:USERPROFILE
    if ($profileDir -and (Test-Path $profileDir)) {
      $found = Get-ChildItem -Path $profileDir -Filter $name -Recurse -Depth 5 -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  } catch {}
  return $null
}

function Open-AddInIfFound($addInName) {
  if (-not $addInName) { return }
  $p = Find-AddIn $addInName
  if (-not $p) {
    Write-Log ("AddIn file not found: " + $addInName)
    return
  }
  try {
    $alreadyOpen = $false
    foreach ($wb in $excel.Workbooks) {
      if ($wb.FullName -eq $p) { $alreadyOpen = $true; break }
    }
    if (-not $alreadyOpen) {
      $excel.Workbooks.Open($p) | Out-Null
      Write-Log ("AddIn workbook opened: " + $p)
    } else {
      Write-Log ("AddIn workbook already open: " + $p)
    }
  } catch {
    Write-Log ("WARN could not open add-in workbook " + $addInName + ": " + $_)
  }
}

# Auto-confirm Excel modal dialogs that are plain confirmations (OK/Yes style),
# but LEAVE ALONE any dialog that has a Debug or End button - those are
# VBA runtime errors the user wants to inspect manually.
# Runs in a separate STA process scoped to the automation Excel instance (targetPid),
# so it never touches other Excel windows the user might have open.
function Start-DialogWatcher($targetPid) {
  $body = @'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
# ---------------------------------------------------------------------------
# Win32 window inventory (diagnostic only, never clicks).
# UIAutomation's root Children only expose control-view windows; the modal dialog
# that blocks the macro does not show up there (the 19:38 run saw only XLMAIN for
# pid 24364 while a dialog was demonstrably on screen). EnumWindows/EnumChildWindows
# see EVERY top-level + child HWND, so this dump is the ground truth for "what
# windows exist". Written to a dedicated file to keep it readable.
# ---------------------------------------------------------------------------
$script:winLog = Join-Path $env:TEMP 'docoutput_windows.log'
try { if ((Test-Path $script:winLog) -and ((Get-Item $script:winLog).Length -gt 4MB)) { Remove-Item $script:winLog -Force -ErrorAction SilentlyContinue } } catch {}
try {
  $cs = @(
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class W32Inv {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);',
    '}'
  ) -join [char]10
  Add-Type -TypeDefinition $cs
  $script:winApiOk = $true
} catch { $script:winApiOk = $false }
function WInfo($h) {
  $t = New-Object System.Text.StringBuilder 512
  $null = [W32Inv]::GetWindowText($h, $t, 512)
  $c = New-Object System.Text.StringBuilder 256
  $null = [W32Inv]::GetClassName($h, $c, 256)
  $p = 0
  $null = [W32Inv]::GetWindowThreadProcessId($h, [ref]$p)
  $v = [W32Inv]::IsWindowVisible($h)
  return @{ t = $t.ToString(); c = $c.ToString(); p = [int]$p; v = $v }
}
function DumpWin32() {
  if (-not $script:winApiOk) { return }
  try { Add-Content -Path $script:winLog -Value ('----- W32DUMP ' + (Get-Date -Format 'HH:mm:ss') + ' target=' + $target + ' -----') -Encoding UTF8 } catch {}
  $script:wtops = New-Object System.Collections.Generic.List[object]
  $cb = [W32Inv+EnumProc]{ param($h, $l) [void]$script:wtops.Add($h); return $true }
  try { $null = [W32Inv]::EnumWindows($cb, [IntPtr]::Zero) } catch {}
  foreach ($h in $script:wtops) {
    $i = WInfo $h
    if (-not $i.v) { continue }
    try { Add-Content -Path $script:winLog -Value ('TOP  pid=' + $i.p + ' cls=' + $i.c + ' title=' + $i.t) -Encoding UTF8 } catch {}
    if ($target -gt 0 -and $i.p -eq $target) {
      $script:wkids = New-Object System.Collections.Generic.List[object]
      $cb2 = [W32Inv+EnumProc]{ param($h2, $l2) [void]$script:wkids.Add($h2); return $true }
      try { $null = [W32Inv]::EnumChildWindows($h, $cb2, [IntPtr]::Zero) } catch {}
      foreach ($k in $script:wkids) {
        $ki = WInfo $k
        if (-not $ki.v) { continue }
        if ($ki.t.Length -eq 0 -and $ki.c -notmatch 'Frame|Dialog|DialogClass|^#|Ctrl|Button|Edit|Static') { continue }
        try { Add-Content -Path $script:winLog -Value ('  CH pid=' + $ki.p + ' cls=' + $ki.c + ' title=' + $ki.t) -Encoding UTF8 } catch {}
      }
    }
  }
}
# ---------------------------------------------------------------------------
# Win32 dialog dismisser - the REAL fix for "the macro popup is not closed".
#
# Why UIA was the wrong tool: the VBA in this job only ever shows MsgBoxes with
# EXACTLY ONE button, which the old 1-4-button heuristic should have matched - yet
# the 19:38 run logged no such window at all (it even caught a 0-button hidden
# XLMAIN). So the failure was never the threshold: UIAutomation simply never saw
# these windows. EnumWindows does, and a standard button accepts BM_CLICK (0x00F5)
# without needing focus or the window to be foreground - which SendKeys must have.
#
# Safety rules (deliberately narrow):
#   * only windows owned by the SAME pid as the Excel/COM target are acted on;
#   * exactly 1 button  -> click it (a one-button modal can only mean "acknowledge");
#   * more buttons      -> click only if NO button is a cancel/discard/delete/save/
#                          overwrite button AND one button is on the safe whitelist.
#     The macro2 file dialog (GetOpenFilename) has many buttons incl. a cancel one, so it is
#     never clicked here - it is filled by the pick helper instead.
#   * a 1-button dialog that survives two BM_CLICKs also gets WM_CLOSE (0x0010);
#     for an OK-only MessageBox WM_CLOSE returns IDOK, i.e. same as pressing the OK button.
# ---------------------------------------------------------------------------
$script:w32Tries = @{}
function W32Dlg() {
  if (-not $script:winApiOk) { return }
  $script:dts = New-Object System.Collections.Generic.List[object]
  $cbd = [W32Inv+EnumProc]{ param($h, $l) [void]$script:dts.Add($h); return $true }
  try { $null = [W32Inv]::EnumWindows($cbd, [IntPtr]::Zero) } catch { return }
  foreach ($h in $script:dts) {
    try {
      $i = WInfo $h
      if (-not $i.v) { continue }
      if ($target -le 0) { continue }
      if ($i.p -ne $target) { continue }
      if ($i.c -ne '#32770') { continue }
      $script:dbs = New-Object System.Collections.Generic.List[object]
      $cbb = [W32Inv+EnumProc]{ param($h2, $l2) [void]$script:dbs.Add($h2); return $true }
      $null = [W32Inv]::EnumChildWindows($h, $cbb, [IntPtr]::Zero)
      $btns = New-Object System.Collections.Generic.List[object]
      foreach ($b in $script:dbs) {
        $bi = WInfo $b
        if (-not $bi.v) { continue }
        if ($bi.c -ne 'Button') { continue }
        $btns.Add(@{ h = $b; t = $bi.t })
      }
      $names = @()
      foreach ($b in $btns) { $names += $b.t }
      $key = '' + $i.p + '|' + $i.t
      $n = 0
      if ($script:w32Tries.ContainsKey($key)) { $n = [int]$script:w32Tries[$key] }
      # A dialog can stay on screen for minutes (the macro2 file picker waits for the
      # helper), so log the first sighting and then only every 10th probe instead of
      # twice a second - otherwise this repeats the BROADEN-spam mistake.
      if ($n -eq 0 -or ($n % 10) -eq 0) {
        Log ("W32DLG title=" + $i.t + " btns=" + $btns.Count + " names=" + ($names -join ',') + " tries=" + $n + " at " + (Get-Date -Format 'HH:mm:ss'))
      }
      $script:w32Tries[$key] = $n + 1
      $pick = $null
      $oneOnly = ($btns.Count -eq 1)
      if ($oneOnly) { $pick = $btns[0] }
      else {
        $danger = 'CANCEL|Cancel|No|' + $cancel + '|' + $no + '|' + $qc + '|' + $del + '|' + $sv + '|' + $fg + '|' + $neg
        $safe = $ok + '|' + $jx + '|' + $yk + '|' + $qy + '|OK|Continue|Allow|Enable|' + $wc + '|' + $cg
        $hasDanger = $false
        foreach ($b in $btns) { if ($b.t -match $danger) { $hasDanger = $true } }
        if (-not $hasDanger) { foreach ($b in $btns) { if ($b.t -match $safe) { $pick = $b; break } } }
      }
      if ($pick) {
        $null = [W32Inv]::PostMessage([IntPtr]$pick.h, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
        if ($n -le 1 -or ($n % 10) -eq 0) {
          Log ("W32CLICK title=" + $i.t + " button=" + $pick.t + " try=" + $n + " at " + (Get-Date -Format 'HH:mm:ss'))
        }
        if ($oneOnly -and $n -ge 2 -and (($n % 10) -eq 2)) {
          $null = [W32Inv]::PostMessage([IntPtr]$h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
          Log ("W32CLOSE title=" + $i.t + " (BM_CLICK had no effect) at " + (Get-Date -Format 'HH:mm:ss'))
        }
      }
    } catch {}
  }
}
function ch { param([int]$c) ([char]$c).ToString() }
$dbg  = (ch 0x8C03) + (ch 0x8BD5)
$end  = (ch 0x7ED3) + (ch 0x675F)
$ok   = (ch 0x786E) + (ch 0x5B9A)
$yes  = ch 0x662F
$del  = (ch 0x5220) + (ch 0x9664)
$qy   = (ch 0x542F) + (ch 0x7528)
$jx   = (ch 0x7EE7) + (ch 0x7EED)
$yk   = (ch 0x5141) + (ch 0x8BB8)
$fg   = (ch 0x8986) + (ch 0x76D6)
$sv   = (ch 0x4FDD) + (ch 0x5B58)
$neg  = ch 0x4E0D
$cancel = (ch 0x53D6) + (ch 0x6D88)
$no     = ch 0x5426
$qc     = (ch 0x653E) + (ch 0x5F03)
$wc     = (ch 0x5B8C) + (ch 0x6210)
$cg     = (ch 0x6210) + (ch 0x529F)
$skipPat  = $dbg + '|' + $end
$clickPat = $ok + '|' + $yes + '|' + $qy + '|' + $jx + '|' + $yk + '|' + $fg + '|' + $del + '|' + $sv + '|OK|Yes|Enable|Continue|Allow|Overwrite|Save|Delete|' + $wc + '|' + $cg
# Buttons we must NEVER click as a "primary" action (they cancel / discard / refuse).
$avoidPat = $neg + '|' + $cancel + '|' + $no + '|' + $qc
$target = __TARGETPID__
$log = Join-Path $env:TEMP 'docoutput_dlgwatch.log'
# APPEND, never truncate: several watchers run per job (macro phase + delete-sheet
# phase); the old WriteAllText wiped the earlier watcher's evidence, which is exactly
# what we needed to diagnose an unclosed macro dialog. Only rotate when very large.
try { if ((Test-Path $log) -and ((Get-Item $log).Length -gt 4MB)) { Remove-Item $log -Force -ErrorAction SilentlyContinue } } catch {}
try { Add-Content -Path $log -Value ("===== WATCHER START target=" + $target + " at " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " =====") -Encoding UTF8 } catch {}
function Log($m) { try { Add-Content -Path $log -Value $m -Encoding UTF8 } catch {} }
# Process one candidate window: if it is a small confirmation/info dialog owned by the
# target process, click its primary button. Returns $true when the window LOOKS like a
# dialog candidate (1-4 buttons, plausible dialog size) even if nothing was clicked, so
# the caller can tell "we have seen the macro's window" from "only the main window".
# Also logs what it sees (title/class/size/buttons) for diagnosis.
function Proc($win) {
  $candidate = $false
  try {
    $title = $win.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
    $cls = ''
    try { $cls = [string]$win.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ClassNameProperty) } catch {}
    $w = 0; $h = 0
    try { $r = $win.Current.BoundingRectangle; $w = [int]$r.Width; $h = [int]$r.Height } catch {}
    $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bc)
    # Always log dialog-class windows - even when the button-count heuristic rejects
    # them. A file-open dialog (#32770 with an Explorer/ShellTab child) has far more
    # than 4 buttons, so it used to be dropped silently; the log only ever showed the
    # Excel main window, which is why the blocking dialog stayed unidentified.
    $bnames = @()
    foreach ($bt0 in $btns) { try { $bnames += $bt0.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty) } catch {} }
    if ($cls -eq '#32770' -or $cls -like '*Dialog*' -or $cls -eq 'ThunderDFrame') {
      Log ("DLGCLASS title=" + $title + " class=" + $cls + " rect=" + $w + "x" + $h + " btns=" + $btns.Count + " names=" + ($bnames -join ',') + " at " + (Get-Date -Format 'HH:mm:ss'))
    }
    # Dialog heuristic: 1-4 buttons. The Excel/WPS main window hosts far more than 4
    # buttons (ribbon), so this alone filters it out. Size filter strips stray
    # zero-area windows and full-screen windows, keeps normal dialogs.
    if ($btns.Count -lt 1 -or $btns.Count -gt 4) { return $false }
    if ($w -gt 0 -and ($w -lt 80 -or $w -gt 1280 -or $h -lt 50 -or $h -gt 960)) { return $false }
    $candidate = $true
    $names = @()
    $confirm = $null; $hasAvoid = $false; $skipIt = $false
    foreach ($bt in $btns) {
      $nm = $bt.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
      $names += $nm
      if ($nm -match $skipPat) { $skipIt = $true; break }
      if ($nm -match $avoidPat) { $hasAvoid = $true }
      if ($null -eq $confirm -and $nm -match $clickPat -and $nm -notmatch ('^' + $neg)) { $confirm = $bt }
    }
    if ($skipIt) { Log ("SKIP title=" + $title + " class=" + $cls + " rect=" + $w + "x" + $h + " btns=" + $btns.Count + " names=" + ($names -join ',')); return $candidate }
    # Fallback: a small dialog (1-3 buttons) with NO allow-listed button but ALSO no
    # dangerous (cancel / no / discard) button is almost always a macro completion or
    # info box. Click its first (primary) button so it does not block the job.
    if (($null -eq $confirm) -and ($btns.Count -le 3) -and (-not $hasAvoid)) { $confirm = $btns[0] }
    Log ("DIALOG title=" + $title + " class=" + $cls + " rect=" + $w + "x" + $h + " btns=" + $btns.Count + " names=" + ($names -join ',') + " -> confirm=" + $(if($confirm){"yes"}else{"none"}))
    if ($confirm) {
      try { $ip = $confirm.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $null = $ip.Invoke(); Log ("INVOKED title=" + $title) } catch { Log ("INVOKE FAIL title=" + $title + " : " + $_) }
    }
  } catch {}
  return $candidate
}
$wcWin = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
# Diagnostic-only: count buttons on any top-level window so we can log every distinct
# window we ever see (title/class/pid/size/button count). Pure observation - it never
# clicks anything; it exists so an unmatched macro dialog leaves a trace.
$bcWin = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$lastDump = (Get-Date).AddSeconds(-10)
$lastW32 = (Get-Date).AddSeconds(-10)
$lastW32d = (Get-Date).AddSeconds(-10)
# Nested UIA descend-scan is expensive; it must NOT run every iteration or it
# drags the cheap Win32 click path (W32Dlg) out to ~1s between attempts.
$lastNested = (Get-Date).AddSeconds(-10)
$seenSigs = @{}
$deadline = (Get-Date).AddSeconds(280)
# Safety net: if the watcher sees NO candidate dialog owned by the target process
# within 20s, broaden to system-wide top-level scanning for the rest of the run.
# Covers the case where the macro dialog lives in a DIFFERENT process than the COM
# target (WPS pops its dialogs from another pid), which the pid-scoped scan would
# never see. Broadening still only clicks allow-listed safe buttons.
#
# NOTE: $seenTarget is only set when Proc flags a real dialog CANDIDATE (1-4 buttons,
# dialog size). Seeing the main window alone does NOT count - otherwise the Excel/WPS
# main window would instantly suppress broadening and a cross-process dialog would
# never be reached.
$broadenAt = (Get-Date).AddSeconds(20)
$seenTarget = $false
$broadAnnounced = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 150
  # Win32 dialog pass FIRST: cheap, focus-independent, and it must not sit behind the
  # (slow) UIAutomation queries below. This is what actually dismisses the VBA MsgBoxes
  # (title "tip" + body "current operation complete" after macro1; "all operations
  #  complete!" after macro2 - both verified against the real screenshots).
  if (((Get-Date) - $lastW32d).TotalMilliseconds -ge 250) {
    $lastW32d = Get-Date
    W32Dlg
  }
  $broad = ($target -le 0) -or ((-not $seenTarget) -and ((Get-Date) -ge $broadenAt))
  # Announce once only - this used to log EVERY iteration and drowned the log
  # (192 BROADEN lines vs a handful of real evidence lines).
  if ($broad -and -not $seenTarget -and -not $broadAnnounced) {
    Log ("BROADEN: no candidate dialog seen by " + $broadenAt + ", scanning system-wide top-level windows")
    $broadAnnounced = $true
  }
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wcWin)
    foreach ($w in $wins) {
      if (-not $broad) {
        $pv = $null
        try { $pv = $w.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty) } catch {}
        if ($target -gt 0 -and $pv -ne $target) { continue }
      }
      if (Proc $w) { if (-not $broad) { $seenTarget = $true } }
    }
    # Nested / owned dialogs: some VBA dialogs (UserForm class "ThunderDFrame", WPS
    # custom dialogs) hang BELOW the main window in the UIAutomation tree instead of
    # appearing as root children. Walk target-owned windows' descendants too.
    # NO class filter here on purpose: the old #32770-only nested scan missed every
    # non-#32770 dialog (UserForms, WPS dialogs) entirely.
    # Runs even in broad mode: it is already bounded to target-pid windows, and the
    # 19:38 evidence showed the blocking dialog was NEVER a UIA root child - so the
    # nested walk is the one path that can still find it.
    # NOTE: #32770 / dialog classes are matched by the dump too, so the old
    # "#32770 only" special case is gone.
    if (((Get-Date) - $lastNested).TotalMilliseconds -ge 900) {
      $lastNested = Get-Date
      foreach ($w in $wins) {
        try {
          $pv = $null
          try { $pv = $w.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty) } catch {}
          if ($target -gt 0 -and $pv -ne $target) { continue }
          $nested = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $wcWin)
          foreach ($n in $nested) { if (Proc $n) { $seenTarget = $true } }
        } catch {}
      }
    }
    # ---- Diagnostic window dump (observation only; never clicks) ------------------
    # Every distinct top-level window we can see is logged once, so a dialog that our
    # click heuristic REJECTS still leaves title/class/pid/size/button-count evidence.
    # Gated to once per 2s, deduped by signature, to keep the log small.
    if (((Get-Date) - $lastW32).TotalSeconds -ge 4) {
      $lastW32 = Get-Date
      DumpWin32
    }
    if (((Get-Date) - $lastDump).TotalMilliseconds -ge 2000) {
      $lastDump = Get-Date
      foreach ($dw in $wins) {
        try {
          $dwt = ''; $dcls = ''; $dpid = 0; $dnb = 0; $dw2 = 0; $dh2 = 0
          try { $dwt = [string]$dw.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty) } catch {}
          try { $dcls = [string]$dw.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ClassNameProperty) } catch {}
          try { $dpid = [int]$dw.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty) } catch {}
          try { $dr = $dw.Current.BoundingRectangle; $dw2 = [int]$dr.Width; $dh2 = [int]$dr.Height } catch {}
          try { $dnb = $dw.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bcWin).Count } catch {}
          if ($dwt.Length -eq 0 -and $dpid -ne $target -and ($dnb -lt 1 -or $dnb -gt 10)) { continue }
          $dsig = $dwt + '|' + $dcls + '|' + $dpid + '|' + $dw2 + 'x' + $dh2 + '|' + $dnb
          if (-not $seenSigs.ContainsKey($dsig)) {
            $seenSigs[$dsig] = 1
            Log ("SEEN pid=" + $dpid + " class=" + $dcls + " rect=" + $dw2 + "x" + $dh2 + " btns=" + $dnb + " title=" + $dwt + " at " + (Get-Date -Format 'HH:mm:ss'))
          }
        } catch {}
      }
      # Nested / owned dialogs: a dialog can be a Window-typed DESCENDANT of its owner
      # (WPS custom dialogs, owned popups) instead of a root child, so it would never
      # appear in the root loop above. Walk descendants of each root window and log any
      # Window node too. Observation only - never clicks.
      foreach ($rw in $wins) {
        try {
          $nestedW = $rw.FindAll([System.Windows.Automation.TreeScope]::Descendants, $wcWin)
          foreach ($nw in $nestedW) {
            try {
              $nwt = ''; $ncls = ''; $npid = 0; $nnb = 0; $nw2 = 0; $nh2 = 0
              try { $nwt = [string]$nw.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty) } catch {}
              try { $ncls = [string]$nw.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ClassNameProperty) } catch {}
              try { $npid = [int]$nw.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty) } catch {}
              try { $nr = $nw.Current.BoundingRectangle; $nw2 = [int]$nr.Width; $nh2 = [int]$nr.Height } catch {}
              try { $nnb = $nw.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bcWin).Count } catch {}
              if ($nwt.Length -eq 0 -and $npid -ne $target -and ($nnb -lt 1 -or $nnb -gt 10)) { continue }
              $nsig = 'N|' + $nwt + '|' + $ncls + '|' + $npid + '|' + $nw2 + 'x' + $nh2 + '|' + $nnb
              if (-not $seenSigs.ContainsKey($nsig)) {
                $seenSigs[$nsig] = 1
                Log ("SEEN-NESTED pid=" + $npid + " class=" + $ncls + " rect=" + $nw2 + "x" + $nh2 + " btns=" + $nnb + " title=" + $nwt + " at " + (Get-Date -Format 'HH:mm:ss'))
              }
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}
}
'@
  $body = $body.Replace('__TARGETPID__', [string]$targetPid)
  $wPath = Join-Path $jobDir ('_dlgwatch_' + (Get-Date -Format 'HHmmssfff') + '.ps1')
  [System.IO.File]::WriteAllText($wPath, $body, [System.Text.Encoding]::ASCII)
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $p = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -STA -File "' + $wPath + '"') -WindowStyle Hidden -PassThru
  Write-Log ("dialog watcher started pid=" + $p.Id + " targetPid=" + $targetPid)
  return $p
}

function Stop-DialogWatcher($p) {
  if ($p) {
    try { $p.WaitForExit(2000) } catch {}
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    try { Remove-Item (Join-Path $jobDir '_dlgwatch_*.ps1') -Force -ErrorAction SilentlyContinue } catch {}
  }
}

$excel = $null
$et = $null
$excelPid = $null

try {
  Add-Type -AssemblyName System.Windows.Forms

  $cfgRaw = Get-Content -Path $Job -Encoding UTF8 -Raw
  $jobObj = $cfgRaw | ConvertFrom-Json
  $aPath = $jobObj.aPath
  $bPath = $jobObj.bPath
  $c = $jobObj.config

  $fixedName = if ($c.fixedName) { $c.fixedName } else { 'DocOutput' }
  $outDir = if ($c.outDir) { $c.outDir } else { Join-Path $env:USERPROFILE 'Documents' }
  if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  $deleteSheet = if ($c.deleteSheet) { $c.deleteSheet } else { 'SheetToDelete' }
  $wpsUrl = $c.wpsUrl
  $txtDir = if ($c.txtDir) { $c.txtDir } else { $env:TEMP }
  if (-not (Test-Path $txtDir)) { New-Item -ItemType Directory -Path $txtDir -Force | Out-Null }
  $macro1 = $c.macro1
  $macro1AddIn = $c.macro1AddIn
  $macro2 = $c.macro2
  $macro2AddIn = $c.macro2AddIn
  $macro2Pick = if ($null -ne $c.macro2NeedsFilePick) { $c.macro2NeedsFilePick } else { $true }
  $sheets = $c.sheets

  Write-Log "JOB START aPath=$aPath bPath=$bPath outDir=$outDir"

  # ---------- Excel COM (kept Visible: macro2 uses a file dialog driven by SendKeys) ----------
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $true
  $excel.DisplayAlerts = $false
  # Resolve the Excel/WPS process id from its main window handle reliably.
  # The old idiom (Get-Process | Where MainWindowHandle -eq $excel.Hwnd) is fragile:
  # IntPtr/int comparison quirks can match the WRONG process, so the dialog watcher
  # ends up scoped to a pid that owns none of Excel's dialogs and never clicks them.
  try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinApiPid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId); }
'@
    $pidOut = 0
    [WinApiPid]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$pidOut) | Out-Null
    if ($pidOut -gt 0) { $excelPid = $pidOut } else { $excelPid = $null }
  } catch { $excelPid = $null }
  $wsh = New-Object -ComObject wscript.shell

  # Start the confirmation-dialog auto-confirmer EARLY - macro-security prompts
  # ("enable macros") can appear while loading PERSONAL.XLSB / add-ins, long
  # before macro1 even runs. Runs through openA/macro1/openB/macro2.
  $dlgWatcher = Start-DialogWatcher $excelPid

  # Excel COM automation does not always auto-load PERSONAL.XLSB (where user macros live).
  # Since A is typically .xlsx (cannot contain macros), explicitly load PERSONAL.XLSB
  # before running macro1 so Application.Run can find the macro.
  $personalXlsb = Join-Path $env:APPDATA 'Microsoft\Excel\XLSTART\PERSONAL.XLSB'
  if (Test-Path $personalXlsb) {
    try {
      $alreadyOpen = $false
      foreach ($wb in $excel.Workbooks) {
        if ($wb.FullName -like '*PERSONAL.XLSB*') { $alreadyOpen = $true; break }
      }
      if ($alreadyOpen) {
        $script:personalLoaded = $true
        Write-Log "PERSONAL.XLSB already open"
      } else {
        $excel.Workbooks.Open($personalXlsb) | Out-Null
        $script:personalLoaded = $true
        Write-Log "PERSONAL.XLSB loaded"
        Start-Sleep -Milliseconds 500
      }
    } catch {
      Write-Log "WARN could not load PERSONAL.XLSB: $_"
    }
  }

  # Excel add-ins (.xlam/.xla) may contain the user's macros and are sometimes not
  # auto-loaded in a fresh COM automation session. Enumerate installed add-ins and
  # open them as workbooks so Application.Run can resolve macros stored inside them.
  try {
    foreach ($addIn in $excel.AddIns) {
      if ($addIn.Installed -and $addIn.FullName -and (Test-Path $addIn.FullName)) {
        $alreadyOpen = $false
        foreach ($wb in $excel.Workbooks) {
          if ($wb.FullName -eq $addIn.FullName) { $alreadyOpen = $true; break }
        }
        if (-not $alreadyOpen) {
          try {
            $excel.Workbooks.Open($addIn.FullName) | Out-Null
            Write-Log ("AddIn opened: " + $addIn.Name)
          } catch { Write-Log ("WARN could not open add-in " + $addIn.Name + ": " + $_) }
        }
      }
    }
    Start-Sleep -Milliseconds 300
  } catch { Write-Log "WARN enumerate AddIns failed: $_" }

  # Open user-specified add-in workbooks (.xlam/.xla) before running macros.
  # The macro names come from the job config; the add-in file names also come
  # from config. We search common add-in folders plus A/B/job folders.
  Open-AddInIfFound $macro1AddIn
  Open-AddInIfFound $macro2AddIn
  Start-Sleep -Milliseconds 200

  # Step 1: open A
  try {
    if (-not (Test-Path $aPath)) { throw ("A file not found: " + $aPath) }
    $wbA = $excel.Workbooks.Open($aPath)
    Add-Step 'openA' $true ''
  } catch {
    Add-Step 'openA' $false ($_.Exception.Message)
    throw ('FAILED openA: ' + $_.Exception.Message)
  }

  # (dialog watcher was already started before PERSONAL.XLSB / add-ins load)

  # Step 2: macro1 on A
  if ($macro1) {
    try {
      $wbNames = @()
      foreach ($wb in $excel.Workbooks) { $wbNames += $wb.Name }
      Write-Log ("Workbooks before macro1: " + ($wbNames -join ', '))
      Invoke-Macro $macro1 'macro1'
      Add-Step 'macro1' $true ''
    } catch {
      Add-Step 'macro1' $false ("Macro1 run failed: " + $macro1 + " - " + $_.Exception.Message)
      throw ('FAILED macro1: ' + $_.Exception.Message)
    }
  } else {
    Add-Step 'macro1' $true 'skipped (not configured)'
  }
  try { $wbA.Save(); $wbA.Close() } catch { Write-Log "WARN save/close A: $_" }

  # Step 3: open B
  try {
    if (-not (Test-Path $bPath)) { throw ("B file not found: " + $bPath) }
    $wbB = $excel.Workbooks.Open($bPath)
    Add-Step 'openB' $true ''
  } catch {
    Add-Step 'openB' $false ($_.Exception.Message)
    throw ('FAILED openB: ' + $_.Exception.Message)
  }

  # Step 4: macro2 on B (may pop a file dialog -> auto-fill A path)
  # IMPORTANT: $excel.Run blocks PowerShell until the macro finishes, so the keystrokes
  # must be sent WHILE the dialog is waiting. We launch a separate STA helper process to
  # do the SendKeys, then call the macro on the main thread (which blocks). The helper
  # sends the keystrokes to the modal dialog, NOT to the worksheet cell (which is why
  # the old code pasted the path into F2 instead of the file dialog).
  if ($macro2) {
    try {
      $pickProc = $null
      if ($macro2Pick) {
        try {
          $pickArgFile = Join-Path $jobDir ('_macro2arg_' + (Get-Date -Format 'HHmmssfff') + '.txt')
          [System.IO.File]::WriteAllText($pickArgFile, $aPath, [System.Text.Encoding]::UTF8)
          $pickHelper = Join-Path $jobDir ('_macro2pick_' + (Get-Date -Format 'HHmmssfff') + '.ps1')
          $pickLogPath = Join-Path $env:TEMP 'docoutput_pick.log'
          $pickScript = @'
param([string]$ArgFile, [string]$PickLog, [int]$ExcelPid)
$aPath = [System.IO.File]::ReadAllText($ArgFile, [System.Text.Encoding]::UTF8).Trim()
function PL($m) { try { Add-Content -Path $PickLog -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) -Encoding UTF8 } catch {} }
PL ('pick: start pid=' + $ExcelPid + ' path=' + $aPath)
Add-Type -AssemblyName System.Windows.Forms
$cs = @(
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class PickW {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '}'
) -join [char]10
try { Add-Type -TypeDefinition $cs } catch { PL ('pick: addtype fail ' + $_) }
# Find the file-open dialog with EnumWindows, NOT UIAutomation. The macro1 MsgBox
# proved that UIA reports ZERO buttons (and can miss the window entirely) for these
# dialogs, so UIA is not a reliable way to find the picker either.
# Strong signal: class #32770 owned by the Excel pid (Application.GetOpenFilename
# produces a standard common dialog). Weak signal: a select/open/browse title --
# matched through regex \u escapes so this generated file stays pure ASCII.
$dlgHwnd = [IntPtr]::Zero
$dlgTitle = ''
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 150
  $script:tops = New-Object System.Collections.Generic.List[object]
  $cb = [PickW+EnumProc]{ param($h, $l) [void]$script:tops.Add($h); return $true }
  try { $null = [PickW]::EnumWindows($cb, [IntPtr]::Zero) } catch {}
  foreach ($h in $script:tops) {
    try {
      $tb = New-Object System.Text.StringBuilder 512
      $null = [PickW]::GetWindowText($h, $tb, 512)
      $cbx = New-Object System.Text.StringBuilder 256
      $null = [PickW]::GetClassName($h, $cbx, 256)
      $pp = 0
      $null = [PickW]::GetWindowThreadProcessId($h, [ref]$pp)
      if (-not [PickW]::IsWindowVisible($h)) { continue }
      if ($ExcelPid -gt 0 -and [int]$pp -ne $ExcelPid) { continue }
      $cls = $cbx.ToString()
      $ttl = $tb.ToString()
      if ($cls -eq 'XLMAIN') { continue }
      if ($cls -eq '#32770' -or $ttl -match 'Open|open|Select|Browse|\u6253\u5f00|\u53e6\u5b58\u4e3a|\u8bf7\u9009\u62e9|\u6e90\u6570\u636e|\u9009\u62e9\u6587\u4ef6|\u6d4f\u89c8') {
        $dlgHwnd = [IntPtr]$h
        $dlgTitle = $ttl
        PL ('pick: dialog found cls=' + $cls + ' title=' + $ttl + ' pid=' + $pp + ' hwnd=' + $h)
        break
      }
    } catch {}
  }
  if ($dlgHwnd -ne [IntPtr]::Zero) { break }
}
if ($dlgHwnd -eq [IntPtr]::Zero) {
  PL 'pick: no dialog found in 60s -> fallback AppActivate(Excel)'
  $wsh0 = New-Object -ComObject WScript.Shell
  try { $wsh0.AppActivate('Excel') | Out-Null } catch {}
} else {
  # When the helper window is hidden it is no longer the foreground process, so Windows
  # foreground-lock may block SetForegroundWindow. AppActivate('Excel') first (the old inline
  # approach) brings Excel and its file dialog to front reliably, then SetForegroundWindow locks it.
  $wshEX = New-Object -ComObject WScript.Shell
  try { $wshEX.AppActivate('Excel') | Out-Null } catch {}
  try { [void][PickW]::SetForegroundWindow($dlgHwnd) } catch { PL ('pick: SetForegroundWindow fail ' + $_) }
  Start-Sleep -Milliseconds 300
}
try { [System.Windows.Forms.Clipboard]::SetText($aPath) } catch { PL ('pick: clipboard fail ' + $_) }
for ($k = 0; $k -lt 4; $k++) {
  if ($dlgHwnd -ne [IntPtr]::Zero) { try { [void][PickW]::SetForegroundWindow($dlgHwnd) } catch {}; Start-Sleep -Milliseconds 150 }
  try { [System.Windows.Forms.SendKeys]::SendWait('%n') } catch {}
  Start-Sleep -Milliseconds 150
  try { [System.Windows.Forms.SendKeys]::SendWait('^a') } catch {}
  Start-Sleep -Milliseconds 100
  try { [System.Windows.Forms.SendKeys]::SendWait('^v') } catch {}
  Start-Sleep -Milliseconds 250
  try { [System.Windows.Forms.SendKeys]::SendWait('~') } catch {}
  # Poll for the dialog to disappear instead of a flat 900ms wait: the file
  # dialog normally closes within ~200-400ms of the Enter, so polling returns
  # control immediately and removes most of the perceived lag.
  $gone = $false
  for ($t = 0; $t -lt 10; $t++) {
    Start-Sleep -Milliseconds 100
    if ($dlgHwnd -eq [IntPtr]::Zero) { $gone = $true; break }
    try { if (-not [PickW]::IsWindow($dlgHwnd)) { $gone = $true; break } } catch { $gone = $true; break }
  }
  PL ('pick: attempt ' + $k + ' done, dialogGone=' + $gone)
  if ($gone) { break }
}
PL 'pick: end'
'@
          [System.IO.File]::WriteAllText($pickHelper, $pickScript, [System.Text.Encoding]::ASCII)
          $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
          try { [System.IO.File]::WriteAllText($pickLogPath, '', [System.Text.Encoding]::UTF8) } catch {}
          $pickPidArg = if ($excelPid -gt 0) { [int]$excelPid } else { 0 }
          $pickProc = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -STA -File "' + $pickHelper + '" -ArgFile "' + $pickArgFile + '" -PickLog "' + $pickLogPath + '" -ExcelPid ' + $pickPidArg) -WindowStyle Hidden -PassThru
          Write-Log ("macro2 auto-pick helper started pid=" + $pickProc.Id + " log=" + $pickLogPath)
        } catch {
          Write-Log ("WARN could not start macro2 auto-pick helper: " + $_)
        }
      }
      Invoke-Macro $macro2 'macro2'
      if ($pickProc) {
        try { $pickProc.WaitForExit(15000) } catch {}
        try { Stop-Process -Id $pickProc.Id -Force -ErrorAction SilentlyContinue } catch {}
        try { Remove-Item (Join-Path $jobDir '_macro2pick_*.ps1') -Force -ErrorAction SilentlyContinue } catch {}
        try { Remove-Item (Join-Path $jobDir '_macro2arg_*.txt') -Force -ErrorAction SilentlyContinue } catch {}
      }
      Add-Step 'macro2' $true ''
    } catch {
      Add-Step 'macro2' $false ("Macro2 run failed: " + $macro2 + " - " + $_.Exception.Message)
      throw ('FAILED macro2: ' + $_.Exception.Message)
    }
  } else {
    Add-Step 'macro2' $true 'skipped (not configured)'
  }
  Stop-DialogWatcher $dlgWatcher
  try { $wbB.Save(); $wbB.Close() } catch { Write-Log "WARN save/close B: $_" }

  # Step 5: copy + rename (fixed name + current date)
  try {
    $stamp = (Get-Date -Format 'yyyy.M.d')
    $copyName = "${fixedName}${stamp}.xlsx"
    $copyPath = Join-Path $outDir $copyName
    Copy-Item -Path $bPath -Destination $copyPath -Force
    Add-Step 'copyRename' $true $copyName
  } catch {
    Add-Step 'copyRename' $false ("Copy/rename failed: " + $_.Exception.Message)
    throw ('FAILED copyRename: ' + $_.Exception.Message)
  }

  # Step 6: open copy, delete the designated sheet
  $wbC = $excel.Workbooks.Open($copyPath)
  if ($deleteSheet) {
    if (Sheet-Exists $wbC $deleteSheet) {
      $delWatcher = Start-DialogWatcher $excelPid
      try {
        $excel.DisplayAlerts = $false
        $wbC.Sheets.Item($deleteSheet).Delete()
        $wbC.Save()
        Add-Step 'deleteSheet' $true $deleteSheet
      } catch {
        Add-Step 'deleteSheet' $false ("Delete sheet failed: " + $deleteSheet + " - " + $_.Exception.Message)
        throw ('FAILED deleteSheet: ' + $_.Exception.Message)
      } finally {
        Stop-DialogWatcher $delWatcher
      }
    } else {
      Add-Step 'deleteSheet' $false ("Sheet to delete not found: " + $deleteSheet + ". Available: " + (Sheet-List $wbC))
      throw ('FAILED deleteSheet: sheet not found')
    }
  } else {
    Add-Step 'deleteSheet' $true 'skipped (empty name)'
  }
  try { $wbC.Save() } catch { Write-Log ("WARN save copy after step6: " + $_) }

  # ---------- Plan B (Browser automation via Playwright) ----------
  # The WPS desktop COM path was unreliable for kdocs: a browser login does NOT
  # carry into a WPS/KET COM session, so the link opened as a guest and the
  # sheets got renamed to "singlesign_*". We now use a Node + Playwright
  # Chromium with a persistent user-data-dir so the kdocs login cookie
  # (set up once via `node planB.cjs --login`) survives across runs. The
  # first-time login is a manual one-off; subsequent runs are headless + auto.
  $projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $planBProfile = Join-Path $projectRoot '_pw_kdocs_profile'
  $planBOut = Join-Path $jobDir '_planB_done.png'
  $planBNodeLog = Join-Path $jobDir '_planB_node.log'
  $planBScript = Join-Path $PSScriptRoot 'planB.cjs'
  $managedNode = 'C:\Users\morty\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'

  # 1) Read the 4 source ranges from the open copy ($wbC) and write TSV files.
  $mapping = New-Object System.Collections.Generic.List[object]
  for ($i = 0; $i -lt $sheets.Count; $i++) {
    $s = $sheets[$i]
    if (-not (Sheet-Exists $wbC $s.local)) {
      Add-Step ('paste:' + $s.local) $false ("Local sheet not found: " + $s.local + ". Available: " + (Sheet-List $wbC))
      throw ('FAILED paste:' + $s.local + ' local sheet not found')
    }
    $ws = $wbC.Sheets.Item($s.local)
    $rng = $ws.Range($s.src)
    $vals = $rng.Value2
    $rows = New-Object System.Collections.Generic.List[string]
    if ($vals -is [System.Object[,]]) {
      # Excel COM Value2 returns a 1-BASED SAFEARRAY; PowerShell preserves those bounds.
      # Iterating 0..GetLength()-1 therefore read index 0 out of bounds (blank) and never
      # read the last index - which is exactly why every TSV gained a blank first row +
      # column and lost its last row + column, so pasted data landed one cell down-right
      # of the configured dst (F2 -> G3). Use the array's REAL bounds (works for both
      # 0-based and 1-based arrays).
      $r0 = $vals.GetLowerBound(0); $r1 = $vals.GetUpperBound(0)
      $c0 = $vals.GetLowerBound(1); $c1 = $vals.GetUpperBound(1)
      for ($r = $r0; $r -le $r1; $r++) {
        $cells = New-Object System.Collections.Generic.List[string]
        for ($k = $c0; $k -le $c1; $k++) {
          $v = $vals[$r, $k]
          $sv = if ($null -eq $v) { '' } else { [string]$v }
          $sv = $sv -replace "`t", ' '
          $sv = $sv -replace "`r`n", ' '
          $sv = $sv -replace "`n", ' '
          $sv = $sv -replace "`r", ' '
          [void]$cells.Add($sv)
        }
        [void]$rows.Add(($cells -join "`t"))
      }
    } else {
      $sv = if ($null -eq $vals) { '' } else { [string]$vals }
      $sv = $sv -replace "`t", ' '
      $sv = $sv -replace "`r`n", ' '
      $sv = $sv -replace "`n", ' '
      $sv = $sv -replace "`r", ' '
      [void]$rows.Add($sv)
    }
    $tsvPath = Join-Path $jobDir ("_planB_{0}.tsv" -f $i)
    # BOM-LESS on purpose. [System.Text.Encoding]::UTF8 emits a UTF-8 BOM, which then
    # glues itself to the FIRST cell ("\ufeff4191") and gets pasted into the online
    # sheet. That was invisible while the off-by-one bug put an empty cell first, and
    # became visible the moment the first cell started carrying real data.
    [System.IO.File]::WriteAllText($tsvPath, ($rows -join "`n"), (New-Object System.Text.UTF8Encoding $false))
    Write-Log ("TSV " + $tsvPath + " rows=" + $rows.Count)
    [void]$mapping.Add(@{
      online = [string]$s.online
      local  = [string]$s.local
      src    = [string]$s.src
      dst    = [string]$s.dst
      tsv    = $tsvPath
    })
  }
  $mappingPath = Join-Path $jobDir '_planB_mapping.json'
  # Write BOM-less: planB.cjs does JSON.parse on this file, and a UTF-8 BOM makes
  # Node throw "Unexpected token". PowerShell 5.1 Set-Content -Encoding UTF8 adds a BOM,
  # so use UTF8Encoding($false) instead.
  $mappingJson = ($mapping | ConvertTo-Json -Depth 6 -Compress)
  [System.IO.File]::WriteAllText($mappingPath, $mappingJson, (New-Object System.Text.UTF8Encoding $false))
  Write-Log ("mapping json: " + $mappingPath)

  # 2) Run the browser automation. Headless by default.
  # NOTE: node MUST run with its own console window. Through the
  # local-bridge -> powershell -> node chain no console is attached, and
  # Playwright's Chromium spawn triggers a libuv assertion
  # ("Assertion failed: process_title ... uv/src/win/util.c") that crashes node
  # before any work starts. Start-Process -WindowStyle Minimized allocates a real
  # console for the node process and avoids the crash. node writes its own
  # detailed log to $planBNodeLog via the PLANB_LOG env var.
  try { [System.IO.File]::WriteAllText($planBNodeLog, '', [System.Text.Encoding]::UTF8) } catch {}
  $env:PLANB_LOG = $planBNodeLog
  $planBArgs = @(
    $planBScript,
    '--mode', 'paste',
    '--wpsUrl', $wpsUrl,
    '--mapping', $mappingPath,
    '--profile', $planBProfile,
    '--out', $planBOut
  )
  Write-Log ("planB start profile=" + $planBProfile)
  $planBProc = Start-Process -FilePath $managedNode -ArgumentList $planBArgs -WindowStyle Minimized -Wait -PassThru
  $planBExit = $planBProc.ExitCode
  Write-Log ("planB exit=" + $planBExit)
  if ($planBExit -ne 0) {
    Add-Step 'planB' $false ("planB.cjs exit=" + $planBExit + " (see " + $planBNodeLog + ")")
    throw ('FAILED planB: exit ' + $planBExit)
  }
  Add-Step 'planB' $true $planBOut

  # 3) Cleanup: close the local copy and quit Excel.
  try { $wbC.Close() } catch { Write-Log "WARN close copy: $_" }
  try { $excel.Quit() } catch {}
  Write-Log "JOB DONE"
  Set-Result $true $null
} catch {
  Write-Log ("ERROR: " + $_)
  # Write result FIRST so the web UI knows the job failed and which step failed.
  Set-Result $false ($lastFail -or ($_.Exception.Message))
  # Then try to release COM objects; if they hang, force-kill only the Excel we opened.
  if ($etWatcher) { try { Stop-DialogWatcher $etWatcher } catch {} }
  try { if ($et -and -not $attached) { $et.Quit() } } catch {}
  try { if ($excel) { $excel.Quit() } } catch {}
  Start-Sleep -Milliseconds 1500
  if ($excelPid) { try { Stop-Process -Id $excelPid -Force -ErrorAction SilentlyContinue } catch {} }
  # Keep the window open so the user can read the error message.
  Write-Host ''
  Write-Host 'Execution failed. Press Enter to close this window.'
  Read-Host
}
