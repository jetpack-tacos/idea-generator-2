$ErrorActionPreference = 'Stop'

$TaskName = 'Idea generator'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'"
} else {
  Write-Host "Scheduled task '$TaskName' was not present"
}
