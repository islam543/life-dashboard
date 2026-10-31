' Starts the life dashboard with no window. A copy of this file sits in the Windows Startup folder
' (shell:startup). Delete that copy to stop the dashboard starting at login.
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Users\ialab\Desktop\personal\life-dashboard\scripts\autostart.cmd""", 0, False
