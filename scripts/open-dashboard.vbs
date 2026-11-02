' Opens the life dashboard in the browser, starting it first when it is not running.
' The "Life dashboard" desktop shortcut runs this file. Safe to run any time: if the dashboard
' already answers, it only opens the page.
Option Explicit

Const URL = "http://localhost:4317/"
Const PROBE = "http://127.0.0.1:4317/api/snapshot"
Const START_CMD = """C:\Users\ialab\Desktop\personal\life-dashboard\scripts\autostart.cmd"""
Const WAIT_SECONDS = 90

Dim sh : Set sh = CreateObject("WScript.Shell")

' True when the dashboard answers with 200.
Function IsUp()
  Dim http
  IsUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.Open "GET", PROBE, False
  http.Send
  If Err.Number = 0 Then IsUp = (http.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not IsUp() Then
  ' Same hidden start as at login: builds the web app, then serves it on port 4317.
  sh.Run START_CMD, 0, False
  Dim waited : waited = 0
  Do While Not IsUp() And waited < WAIT_SECONDS
    WScript.Sleep 1000
    waited = waited + 1
  Loop
  If Not IsUp() Then
    MsgBox "The life dashboard did not start within " & WAIT_SECONDS & " seconds." & vbCrLf & _
      "See data\autostart.log in the project folder for the reason.", vbExclamation, "Life dashboard"
    WScript.Quit 1
  End If
End If

sh.Run URL
