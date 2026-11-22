$ErrorActionPreference = 'Stop'

$TaskName = 'Idea generator'
$RepoDir = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$Action = New-ScheduledTaskAction `
  -Execute 'conhost.exe' `
  -Argument "--headless `"$NodeExe`" server/index.ts" `
  -WorkingDirectory $RepoDir

$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -Priority 7 `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $User in $RepoDir"
