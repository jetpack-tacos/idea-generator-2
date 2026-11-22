# Restart the "Idea generator" scheduled task so the server runs the current code.
# Stopping the task closes its hidden console but can leave node running on the port,
# so this also stops any node process running this repo's server/index.ts.
$ErrorActionPreference = 'Stop'
$TaskName = 'Idea generator'
$RepoDir = Split-Path -Parent $PSScriptRoot

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$servers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server/index\.ts' -and $_.ExecutablePath -and (Get-Process -Id $_.ProcessId).Path -and ($_.CommandLine -notmatch '--test') }
foreach ($p in $servers) {
  Write-Host "Stopping server pid $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -Confirm:$false
}
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6
try {
  $code = (Invoke-WebRequest -UseBasicParsing http://localhost:8300/api/status -TimeoutSec 5).StatusCode
  Write-Host "Server answers: HTTP $code"
} catch {
  Write-Host "Server did not answer yet: $($_.Exception.Message)"
  exit 1
}
