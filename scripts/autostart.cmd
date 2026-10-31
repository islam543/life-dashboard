@echo off
rem Builds the web app and serves the dashboard on http://localhost:4317.
rem Launched with no window at Windows login by life-dashboard-startup.vbs. Output goes to data\autostart.log.
cd /d "%~dp0.."
if not exist data mkdir data
echo [%date% %time%] build > data\autostart.log
call npm run build >> data\autostart.log 2>&1
echo [%date% %time%] start >> data\autostart.log
call npm start >> data\autostart.log 2>&1
