' Scrybox launcher — starts the local server (if not already running) and opens it in Firefox.
' Double-click this file to launch the app. No console window will appear.

Dim shell, fso, scriptDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Start the local HTTP server hidden. If one is already running on this port,
' this second attempt just fails silently in the background and the existing
' server keeps serving — that's expected and fine.
shell.Run "cmd /c cd /d """ & scriptDir & """ && python -m http.server 8000", 0, False

' Give the server a moment to start up before opening the browser.
WScript.Sleep 1500

' Open the app in Firefox. "start firefox" uses Windows' App Paths registry
' entry for Firefox, so it works even if firefox.exe isn't on the PATH.
shell.Run "cmd /c start firefox http://localhost:8000", 0, False
