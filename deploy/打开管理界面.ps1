#Requires -Version 5.1
<#
打开管理界面 —— 双击入口的实际逻辑（由同目录的 open-console.bat 调用）

为什么逻辑不写在 .bat 里：cmd.exe 按字节偏移解析批处理，文件里一旦同时出现
UTF-8 BOM、chcp 65001 和多字节中文，偏移就会错位——@echo off 失效、中文行的尾巴
被当成命令执行（曾报「'unchd' is not recognized」）。所以 .bat 只保留纯 ASCII 的
一行转发，中文与判断全部放在这里（PowerShell 能正确读 UTF-8）。

行为：探活 → 已在运行就打开浏览器；否则优先触发登录自启任务 PersonalGateway，
没有该任务则在项目目录后台起一个 node（关窗即停，常驻请跑 install.ps1），
探活成功后打开浏览器。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot   # 本文件在 deploy/ 下
$TaskName = 'PersonalGateway'

function Info([string]$m) { Write-Host "[open-console] $m" }
function Fail([string]$m) { Write-Host "[open-console] 错误: $m" -ForegroundColor Red; exit 1 }

# ---- 1) 端口：环境变量 > 安装时记录的 port 文件 > 8484 --------------------
function Resolve-Port {
  foreach ($name in @('PGW_PROXY_PORT', 'CANNBOT_PROXY_PORT')) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ($v -and $v -match '^\d+$') { return [int]$v }
  }
  $dirs = @()
  if ($env:PGW_RUNTIME_DIR) { $dirs += $env:PGW_RUNTIME_DIR }
  if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA 'personal-gateway') }
  if ($env:USERPROFILE) {
    $dirs += (Join-Path $env:USERPROFILE '.local\share\personal-gateway')
    $dirs += (Join-Path $env:USERPROFILE '.local\share\cannbot-gateway-proxy')
  }
  foreach ($d in $dirs) {
    $f = Join-Path $d 'port'
    if (Test-Path -LiteralPath $f) {
      $raw = (Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue)
      if ($raw -and $raw.Trim() -match '^\d+$') { return [int]$raw.Trim() }
    }
  }
  return 8484
}

$Port = Resolve-Port
$Url = "http://127.0.0.1:$Port/"

function Test-Alive {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

Info "正在检查个人网关（端口 $Port）…"

# ---- 2) 已在运行：直接开浏览器 -------------------------------------------
if (Test-Alive) {
  Info '网关已在运行。'
  Info "打开个人网关管理台：$Url"
  Start-Process $Url
  exit 0
}

# ---- 3) 未运行：拉起 ------------------------------------------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Info '网关未启动，正在通过登录自启任务拉起…'
  try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop }
  catch { Info "触发登录任务失败：$($_.Exception.Message)" }
} else {
  # 没有登录任务：在项目目录后台跑源码，最小化且隐藏窗口；关闭终端即停。
  # node 用 PATH 查找——找不到就明确提示，而不是静默起不来。
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Fail '未找到 node，请先安装 Node.js 18+（或先运行 .\install.ps1 注册登录自启任务）'
  }
  Info '网关未启动，正在后台启动 node server.mjs（关窗即停；常驻请运行 .\install.ps1）…'
  if (-not $env:PGW_PROXY_PORT) { $env:PGW_PROXY_PORT = [string]$Port }
  Start-Process -FilePath $nodeCmd.Source -ArgumentList 'server.mjs' `
    -WorkingDirectory $ProjectDir -WindowStyle Hidden
}

# ---- 4) 等它就绪（最多 20 次 × 500ms）------------------------------------
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Alive) { $ok = $true; break }
}
if (-not $ok) {
  Fail "网关启动失败（端口 $Port 无响应）。常见原因：端口被占用、node 不在 PATH。可运行 .\status.ps1 查看详情。"
}

Info "打开个人网关管理台：$Url"
Start-Process $Url
exit 0
