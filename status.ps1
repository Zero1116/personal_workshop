# status.ps1 — 兼容入口（正式脚本在 deploy/status.ps1）

[CmdletBinding()]
param(
  [int]$Port = 0
)
if ($Port -gt 0) {
  & (Join-Path $PSScriptRoot 'deploy\status.ps1') -Port $Port
} else {
  & (Join-Path $PSScriptRoot 'deploy\status.ps1')
}
exit $LASTEXITCODE
