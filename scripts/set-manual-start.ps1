# Turn off the "Idea generator" task's start-at-login trigger, so the app runs only when started
# (owner's choice, 2026-11-22), and put the Open and Stop shortcuts on the desktop.
# Revert: scripts\install-startup.ps1 registers the task with start-at-login again.
$ErrorActionPreference = 'Stop'
$TaskName = 'Idea generator'
$Scripts = $PSScriptRoot

$task = Get-ScheduledTask -TaskName $TaskName
foreach ($t in $task.Triggers) { $t.Enabled = $false }
Set-ScheduledTask -InputObject $task | Out-Null

$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$ps = (Get-Command powershell).Source
foreach ($s in @(
  @{ Name = 'Open idea generator'; Script = 'start-idea-generator.ps1'; Icon = "$env:SystemRoot\System32\imageres.dll,76" },
  @{ Name = 'Stop idea generator'; Script = 'stop-idea-generator.ps1'; Icon = "$env:SystemRoot\System32\imageres.dll,93" }
)) {
  $link = $shell.CreateShortcut((Join-Path $desktop "$($s.Name).lnk"))
  $link.TargetPath = $ps
  $link.Arguments = "-NoProfile -WindowStyle Hidden -File `"$(Join-Path $Scripts $s.Script)`""
  $link.WorkingDirectory = Split-Path -Parent $Scripts
  $link.IconLocation = $s.Icon
  $link.Save()
}
# The old shortcut only opened the page, which shows nothing when the app is stopped.
Remove-Item -LiteralPath (Join-Path $desktop 'Open idea generator.url') -ErrorAction SilentlyContinue
Write-Host "Start at login is off; desktop shortcuts are in $desktop"
