# install.ps1 — 兼容入口（正式脚本在 deploy/install.ps1）
#
# 2026-11 目录重排后脚本收进 deploy/，但 `.\install.ps1` 这个入口在文档、习惯和
# 外部脚本里到处都是：保留一个转发壳，比让所有人改命令更划算。
#
# 用法: .\install.ps1 [端口]     # 缺省 8484
[CmdletBinding()]
param(
  [int]$Port = 8484
)
& (Join-Path $PSScriptRoot 'deploy\install.ps1') -Port $Port
exit $LASTEXITCODE
