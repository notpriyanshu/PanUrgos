# Adds or removes a folder from the *user* PATH without expanding existing %VARIABLES%.
param([ValidateSet('add', 'remove')][string]$Mode, [string]$Dir)
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$norm = { param($p) $p.Trim().TrimEnd('\').ToLowerInvariant() }
$target = & $norm $Dir
$parts = @($cur -split ';' | Where-Object { $_.Trim() -ne '' -and (& $norm $_) -ne $target })
if ($Mode -eq 'add') { $parts += $Dir }
$key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
$key.Close()
