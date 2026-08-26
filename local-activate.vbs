Option Explicit

Dim sh, fso, path, base, i, ok
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
End If

path = WScript.Arguments(0)
base = fso.GetBaseName(path)

' Launch the target with a normal window and do not block.
sh.Run "\"" & path & "\"", 1, False

' Wait for the window to appear.
WScript.Sleep 1200

' Try to activate the window by matching common title patterns.
ok = False
If sh.AppActivate(base) Then ok = True
If Not ok And sh.AppActivate(base & " - ") Then ok = True

If Not ok Then
    ' Fallback: try progressively shorter prefixes of the basename.
    For i = 8 To 3 Step -1
        If Len(base) >= i Then
            If sh.AppActivate(Left(base, i)) Then
                ok = True
                Exit For
            End If
        End If
    Next
End If

WScript.Quit 0
