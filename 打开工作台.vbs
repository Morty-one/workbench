' True silent launcher. No CMD popup, no console window.
' Uses FSO to derive its own directory and WScript.Shell to spawn
' the BAT with the hidden window style. All content is ASCII;
' the Chinese filename is built char-by-char to avoid encoding issues.

Option Explicit

Dim fso, sh, scriptDir, batName, batPath

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' Build the BAT filename char-by-char from Unicode code points.
' Codes: 0x6253 0x5F00 0x5DE5 0x4F5C 0x53F0
batName = ChrW(&H6253) & ChrW(&H5F00) & ChrW(&H5DE5) & ChrW(&H4F5C) & ChrW(&H53F0) & ".bat"

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath  = fso.BuildPath(scriptDir, batName)

sh.CurrentDirectory = scriptDir
sh.Run """" & batPath & """", 0, False

Set sh  = Nothing
Set fso = Nothing
