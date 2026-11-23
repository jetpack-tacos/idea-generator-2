# Start the idea generator if it is not running, wait until it answers, then open its page.
# Used by the desktop shortcut "Open idea generator". The app no longer starts at login (owner's choice, 2026-11-22).
$ErrorActionPreference = 'Stop'
$TaskName = 'Idea generator'
# 127.0.0.1, not localhost: localhost tries another route first and stalls about 2 s on this PC.
$Url = 'http://127.0.0.1:8300'

function Test-Server {
  try { return (Invoke-WebRequest -UseBasicParsing "$Url/api/status" -TimeoutSec 5).StatusCode -eq 200 } catch { return $false }
}

if (-not (Test-Server)) {
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Server)) {
    if ((Get-Date) -gt $deadline) {
      Add-Type -AssemblyName PresentationFramework
      [System.Windows.MessageBox]::Show("The idea generator did not start within 30 seconds. Its log is logs\server.log in $(Split-Path -Parent $PSScriptRoot).", 'Idea generator') | Out-Null
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
}
Start-Process $Url
