# Stop the idea generator. Used by the desktop shortcut "Stop idea generator".
# Stopping the task alone can leave node on the port, so this also stops this repo's server process.
$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'Idea generator' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server/index\.ts' -and $_.CommandLine -notmatch '--test' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
