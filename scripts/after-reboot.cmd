@echo off
rem Run once, soon after a reboot. Needs --prepare-reboot to have run first.
rem Results go to bench-resultsfter-reboot.json, and the test folders are deleted.
cd /d "%~dp0.."
set "PATH=%USERPROFILE%\.cargoin;%PATH%"
node scripts/bench.mjs --hdd D:\ --after-reboot
pause
