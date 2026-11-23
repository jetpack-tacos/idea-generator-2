# Stop the idea generator. Used by the desktop shortcut "Stop idea generator".
# Stopping the task alone can leave node on the port, so this also stops this repo's server process.
$ErrorActionPreference = 'Stop'
# A full-speed night runs until this shortcut is used (owner's call 2026-11-23), so stopping also ends it: the board goes back to a step every 45 s, 60 an hour, 50 cents a day,
# and end-claude-night.py puts back the cheap models, 08:00-22:00 hours and no Claude plan fallback.
# Both are safe to rerun; the board call is skipped quietly when the server is already down.
try {
  Invoke-RestMethod -Method Patch -Uri 'http://127.0.0.1:8300/api/boards/1' -ContentType 'application/json' -TimeoutSec 10 `
    -Body '{"config":{"autopilotSeconds":45,"rate":{"stepsPerHour":60,"usdPerDay":0.5}}}' | Out-Null
} catch {}
& python -I (Join-Path $PSScriptRoot 'end-claude-night.py')
Stop-ScheduledTask -TaskName 'Idea generator' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server/index\.ts' -and $_.CommandLine -notmatch '--test' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
