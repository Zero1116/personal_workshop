# uninstall.ps1 — 兼容入口（正式脚本在 deploy/uninstall.ps1）

[CmdletBinding()]
param(
  [switch]$RevertConfigs
)
& (Join-Path $PSScriptRoot 'deploy\uninstall.ps1') -RevertConfigs:$RevertConfigs
exit $LASTEXITCODE
