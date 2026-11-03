#Requires -Version 5.1
<#
status.ps1 — 查看个人网关状态（Windows：服务 / 各上游凭证 / 最近请求）

用法: .\status.ps1 [端口]      # 缺省用安装时记录的端口，未安装则 8484
#>
[CmdletBinding()]
param(
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

$TaskName = 'PersonalGateway'
if ($env:PGW_RUNTIME_DIR) {
  $RuntimeDir = $env:PGW_RUNTIME_DIR
} else {
  $RuntimeDir = Join-Path $env:LOCALAPPDATA 'personal-gateway'
}
if ($Port -le 0) {
  $portFile = Join-Path $RuntimeDir 'port'
  if (Test-Path -LiteralPath $portFile) {
    $raw = (Get-Content -LiteralPath $portFile -Raw -ErrorAction SilentlyContinue)
    if ($raw -and $raw.Trim() -match '^\d+$') { $Port = [int]$raw.Trim() }
  }
}
if ($Port -le 0) { $Port = 8484 }

$W = 46
Write-Host ("个人网关 personal_gateway  " + ('-' * $W))

# ---- 服务 ----
$taskState = $null
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { $taskState = [string]$task.State }
} catch {}

$healthRaw = $null
try { $healthRaw = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 5 } catch {}

if ($healthRaw) {
  Write-Host "  服务    运行中（端口 $Port）" -ForegroundColor Green
} elseif ($taskState) {
  Write-Host "  服务    已安装但未运行（任务状态: $taskState）" -ForegroundColor Yellow
} else {
  Write-Host "  服务    未安装  启用: .\install.ps1" -ForegroundColor Red
}

if (-not $healthRaw) {
  Write-Host "  接口    http://127.0.0.1:$Port 无响应" -ForegroundColor Red
  $errLog = Join-Path $RuntimeDir 'logs\proxy.err.log'
  if (Test-Path -LiteralPath $errLog) {
    Get-Content -LiteralPath $errLog -Tail 3 -Encoding UTF8 -ErrorAction SilentlyContinue | ForEach-Object {
      Write-Host ("          " + $_.Substring(0, [Math]::Min(100, $_.Length))) -ForegroundColor Red
    }
  }
  Write-Host "✗ 服务不可用" -ForegroundColor Red
  exit 1
}

$up = [int]$healthRaw.uptimeSec
if ($up -ge 3600) { $upText = "$([Math]::Floor($up / 3600))小时$([Math]::Floor(($up % 3600) / 60))分" }
elseif ($up -ge 60) { $upText = "$([Math]::Floor($up / 60))分$($up % 60)秒" }
else { $upText = "${up}秒" }
Write-Host "  接口    http://127.0.0.1:$Port/v1  → $(@($healthRaw.providers).Count) 个订阅上游"
Write-Host "  运行    已运行 $upText"
if ($healthRaw.authRequired) {
  Write-Host "  鉴权    ● 已启用（Bearer token）" -ForegroundColor Green
} else {
  Write-Host "  鉴权    未配置 clientToken" -ForegroundColor Yellow
}

# ---- 各订阅上游 ----
foreach ($p in @($healthRaw.providers)) {
  if ($null -eq $p) { continue }
  $label = "$($p.id) ($($p.protocol))"
  $models = $p.modelsKnown
  $modelsText = if ($models) { "· 模型 $models" } elseif ($p.catalogError) { '· 模型目录异常' } else { '' }
  $jwt = $null
  if ($p.auth) { $jwt = $p.auth.jwt }
  if ($null -ne $jwt) {
    if ($jwt.ok) {
      Write-Host "  上游    ● $label · JWT 有效 $modelsText" -ForegroundColor Green
    } else {
      Write-Host "  上游    ✗ $label · JWT 不可用 $modelsText" -ForegroundColor Red
      Write-Host "          $($jwt.error)" -ForegroundColor Red
      Write-Host "          → 处理：打开 VSCode 的 CANNWork 扩展重新登录，无需重启网关" -ForegroundColor Yellow
    }
  } else {
    if ($p.auth -and $p.auth.ok) {
      Write-Host "  上游    ● $label · Token 有效（$($p.auth.tokenSource)）$modelsText" -ForegroundColor Green
    } else {
      Write-Host "  上游    ✗ $label · Token 缺失 $modelsText" -ForegroundColor Red
      Write-Host "          $($p.auth.error)" -ForegroundColor Red
      Write-Host "          → 处理：在 providers.json 里补 auth 配置（token/tokenEnv/tokenFile）" -ForegroundColor Yellow
    }
  }
}

# ---- 最近请求 ----
Write-Host ("最近请求  " + ('-' * $W))
$logFile = Join-Path $RuntimeDir 'proxy.log'
if (Test-Path -LiteralPath $logFile) {
  $lines = @(Get-Content -LiteralPath $logFile -Tail 6 -Encoding UTF8 -ErrorAction SilentlyContinue)
  if (@($lines).Count -eq 0) {
    Write-Host '  （暂无请求）'
  } else {
    foreach ($line in $lines) { Write-Host "  $line" }
  }
} else {
  Write-Host '  （暂无日志）'
}

if ($healthRaw.ok) {
  Write-Host '✓ 一切正常' -ForegroundColor Green
  exit 0
} else {
  Write-Host '✗ 部分上游凭证异常，相关请求会被拒绝' -ForegroundColor Red
  exit 1
}
