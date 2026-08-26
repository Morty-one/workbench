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
  [System.IO.File]::WriteAllText($resultPath, $json, [System.Text.Encoding]::UTF8)
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
$skipPat  = $dbg + '|' + $end
$clickPat = $ok + '|' + $yes + '|' + $qy + '|' + $jx + '|' + $yk + '|' + $fg + '|' + $del + '|' + $sv + '|OK|Yes|Enable|Continue|Allow|Overwrite|Save|Delete'
$target = __TARGETPID__
$deadline = (Get-Date).AddSeconds(280)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $wc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
    $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $wc)
    foreach ($w in $wins) {
      try {
        $pidv = $w.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::ProcessIdProperty)
        if ($target -gt 0 -and $pidv -ne $target) { continue }
        $bc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
        $btns = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $bc)
        # Only small windows (1-4 buttons) are confirmation dialogs. The Excel main
        # window has dozens of ribbon buttons and must never be auto-clicked.
        # NOTE: we intentionally do NOT require WindowPattern.IsModal - VBA MsgBox
        # and UserForm dialogs often report IsModal=false (or lack the pattern),
        # which is why confirmations were previously left on screen.
        if ($btns.Count -lt 1 -or $btns.Count -gt 4) { continue }
        $skipIt = $false
        $confirm = $null
        foreach ($bt in $btns) {
          $nm = $bt.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
          if ($nm -match $skipPat) { $skipIt = $true; break }
          if ($null -eq $confirm -and $nm -match $clickPat -and $nm -notmatch ('^' + $neg)) { $confirm = $bt }
        }
        if ($skipIt) { continue }
        if ($confirm) {
          try { $ip = $confirm.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $ip.Invoke() } catch {}
        }
      } catch {}
    }
  } catch {}
}
'@
  $body = $body.Replace('__TARGETPID__', [string]$targetPid)
  $wPath = Join-Path $jobDir ('_dlgwatch_' + (Get-Date -Format 'HHmmssfff') + '.ps1')
  [System.IO.File]::WriteAllText($wPath, $body, [System.Text.Encoding]::ASCII)
  $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $p = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -STA -File "' + $wPath + '"') -PassThru
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
  try { $excelPid = (Get-Process | Where-Object { $_.MainWindowHandle -eq $excel.Hwnd }).Id } catch { $excelPid = $null }
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
          $pickScript = @'
param([string]$ArgFile)
$aPath = [System.IO.File]::ReadAllText($ArgFile, [System.Text.Encoding]::UTF8).Trim()
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 2000
[System.Windows.Forms.Clipboard]::SetText($aPath)
$wsh = New-Object -ComObject WScript.Shell
try { $wsh.AppActivate('Excel') } catch {}
Start-Sleep -Milliseconds 500
try { $wsh.SendKeys('%n') } catch {}
Start-Sleep -Milliseconds 300
try { $wsh.SendKeys('^v') } catch {}
Start-Sleep -Milliseconds 400
try { $wsh.SendKeys('~') } catch {}
'@
          [System.IO.File]::WriteAllText($pickHelper, $pickScript, [System.Text.Encoding]::ASCII)
          $psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
          $pickProc = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -STA -File "' + $pickHelper + '" -ArgFile "' + $pickArgFile + '"') -PassThru
          Write-Log ("macro2 auto-pick helper started pid=" + $pickProc.Id)
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

  # ---------- WPS Spreadsheets COM ----------
  # NOTE: 'ET.Application' is NOT registered on this machine (only KWPS/KET are the
  # real WPS Spreadsheets COM ProgIDs, and Excel.Application is also available). Use
  # the registered ones so we never end up with a broken/null Workbooks object.
  $progIds = @('KWPS.Application', 'KET.Application', 'Excel.Application')
  $et = $null; $usedPid = ''
  foreach ($progId in $progIds) {
    try { $et = New-Object -ComObject $progId; $usedPid = $progId; break } catch {}
  }
  if (-not $et) {
    Add-Step 'openWps' $false 'WPS/Excel COM not available (KWPS/KET/Excel all failed)'
    throw 'FAILED openWps: WPS/Excel COM not available'
  }
  Start-Sleep -Milliseconds 1200
  if ($null -eq $et.Workbooks) {
    Add-Step 'openWps' $false ("COM object created ($usedPid) but Workbooks is null")
    throw 'FAILED openWps: Workbooks is null'
  }
  try { $et.DisplayAlerts = $false } catch {}
  $et.Visible = $true
  $wbW = $null
  try {
    $wbW = $et.Workbooks.Open($wpsUrl)
    Add-Step 'openWps' $true ("opened via $usedPid")
  } catch {
    Add-Step 'openWps' $false ("WPS open link failed ($usedPid): " + $wpsUrl + " - " + $_.Exception.Message)
    throw ('FAILED openWps: ' + $_.Exception.Message)
  }

  foreach ($s in $sheets) {
    $local = $s.local; $online = $s.online; $src = $s.src; $dst = $s.dst
    Write-Log "SHEET $local -> $online  src=$src dst=$dst"
    if (-not (Sheet-Exists $wbC $local)) {
      Add-Step ('paste:' + $local) $false ("Local sheet not found: " + $local + ". Available: " + (Sheet-List $wbC))
      throw ('FAILED paste:' + $local + ' local sheet not found')
    }
    if (-not (Sheet-Exists $wbW $online)) {
      Add-Step ('paste:' + $online) $false ("Online sheet not found: " + $online + ". Available: " + (Sheet-List $wbW))
      throw ('FAILED paste:' + $online + ' online sheet not found')
    }

    $ws = $wbC.Sheets.Item($local)
    $rng = $ws.Range($src)
    $vals = $rng.Value2

    $lines = @()
    if ($vals -is [System.Object[,]]) {
      $rows = $vals.GetLength(0); $cols = $vals.GetLength(1)
      for ($r = 1; $r -le $rows; $r++) {
        $row = @()
        for ($cc = 1; $cc -le $cols; $cc++) { $row += [string]$vals[$r, $cc] }
        $lines += ($row -join "`t")
      }
    } else {
      $lines += [string]$vals
    }
    $txt = Join-Path $txtDir ("docout_" + $online + ".txt")
    Set-Content -Path $txt -Value $lines -Encoding UTF8

    $srcD = Get-RangeDims $src
    $dstD = Get-RangeDims $dst
    if ($srcD.rows -ne $dstD.rows -or $srcD.cols -ne $dstD.cols) {
      Add-Step ('paste:' + $local) $false ("Dimension mismatch: source " + $srcD.rows + "x" + $srcD.cols + " != target " + $dstD.rows + "x" + $dstD.cols)
      throw ('FAILED paste:' + $local + ' dimension mismatch')
    }

    $readLines = Get-Content -Path $txt -Encoding UTF8
    $rc = $readLines.Count
    $cc2 = if ($rc -gt 0) { ($readLines[0] -split "`t").Count } else { 0 }
    $arr = New-Object 'object[,]' $rc, $cc2
    for ($r = 0; $r -lt $rc; $r++) {
      $cells = $readLines[$r] -split "`t"
      for ($k = 0; $k -lt $cc2; $k++) { $arr[$r, $k] = $cells[$k] }
    }

    $wsW = $wbW.Sheets.Item($online)
    $wsW.Range($dst).Value2 = $arr
    Start-Sleep -Milliseconds 300

    Remove-Item $txt -Force -ErrorAction SilentlyContinue
    Add-Step ('paste:' + $local) $true ('-> ' + $online)
  }

  try { $wbW.Save(); $wbW.Close() } catch { Write-Log "WARN save/close WPS: $_" }
  try { $wbC.Close() } catch { Write-Log "WARN close copy: $_" }
  try { $et.Quit() } catch {}
  try { $excel.Quit() } catch {}
  Write-Log "JOB DONE"
  Set-Result $true $null
} catch {
  Write-Log ("ERROR: " + $_)
  # Write result FIRST so the web UI knows the job failed and which step failed.
  Set-Result $false ($lastFail -or ($_.Exception.Message))
  # Then try to release COM objects; if they hang, force-kill only the Excel we opened.
  try { if ($et) { $et.Quit() } } catch {}
  try { if ($excel) { $excel.Quit() } } catch {}
  Start-Sleep -Milliseconds 1500
  if ($excelPid) { try { Stop-Process -Id $excelPid -Force -ErrorAction SilentlyContinue } catch {} }
  # Keep the window open so the user can read the error message.
  Write-Host ''
  Write-Host 'Execution failed. Press Enter to close this window.'
  Read-Host
}
