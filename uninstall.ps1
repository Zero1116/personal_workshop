#Requires -Version 5.1
<#
uninstall.ps1 — 停用个人网关（Windows）

用法:
  .\uninstall.ps1                  停止服务、移除登录自启任务与运行时副本（保留 zcode 配置指向）
  .\uninstall.ps1 -RevertConfigs   同上，并把 zcode 相关配置回滚到接入前备份

回滚涉及的备份文件（-RevertConfigs 时还原）:
  %USERPROFILE%\.zcode\v2\provider_config.json.bak-cannbot（若存在；v2 接入是手动改的）
  %USERPROFILE%\.zcode\cli\config.json.bak-cannbot（cannbot-creds.sh --sync-zcode 创建）
#>
[CmdletBinding()]
param(
  [switch]$RevertConfigs
)

$ErrorActionPreference = 'Stop'

$TaskName = 'PersonalGateway'
if ($env:PGW_RUNTIME_DIR) {
  $RuntimeDir = $env:PGW_RUNTIME_DIR
} else {
  $RuntimeDir = Join-Path $env:LOCALAPPDATA 'personal-gateway'
}
# 防手滑：运行时目录 = 项目目录时，下面的 Remove-Item -Recurse 会删掉源文件
$projFull = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$rtFull = [System.IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\')
if ($projFull -eq $rtFull) {
  Write-Host '[uninstall] 错误: 运行时目录等于项目目录，拒绝递归删除；请检查 PGW_RUNTIME_DIR' -ForegroundColor Red
  exit 1
}

$Port = 8484
$portFile = Join-Path $RuntimeDir 'port'
if (Test-Path -LiteralPath $portFile) {
  $raw = (Get-Content -LiteralPath $portFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw.Trim() -match '^\d+$') { $Port = [int]$raw.Trim() }
}

function Msg([string]$m) { Write-Host "[uninstall] $m" }

# 1) 停止并移除登录自启任务
try {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Msg "已移除登录自启任务: $TaskName（开机自启一并取消）"
  } else {
    Msg "未发现登录自启任务: $TaskName（本就未安装）"
  }
} catch {
  Msg "任务清理失败: $($_.Exception.Message)"
}

# 2) 停掉指向运行时目录的 node 进程（任务停掉后可能仍有残留子进程）
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.CommandLine -and $_.CommandLine.IndexOf($RuntimeDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine -match 'server\.mjs') {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}

# 3) 用户创作数据先抢救到备份目录，再清理运行时副本
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$DataBackup = "$RuntimeDir.data-backup-$stamp"
if (Test-Path -LiteralPath $RuntimeDir) {
  foreach ($f in @('todos.json', 'reports.json', 'providers.json')) {
    $src = Join-Path $RuntimeDir $f
    if (Test-Path -LiteralPath $src) {
      New-Item -ItemType Directory -Force -Path $DataBackup | Out-Null
      Copy-Item -LiteralPath $src -Destination $DataBackup -Force
    }
  }
  Get-ChildItem -LiteralPath $RuntimeDir -Filter '*.bad*' -File -ErrorAction SilentlyContinue | ForEach-Object {
    New-Item -ItemType Directory -Force -Path $DataBackup | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $DataBackup -Force
  }
}
if (Test-Path -LiteralPath $DataBackup) {
  Msg "用户数据已备份: $DataBackup（providers.json 凭证 / todos.json 待办 / reports.json 报告存档）"
}

Remove-Item -LiteralPath $RuntimeDir -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $RuntimeDir) {
  Msg "警告: 运行时目录未能完全删除，请手动清理: $RuntimeDir"
} else {
  Msg "已清理运行时副本 $RuntimeDir"
}

Start-Sleep -Seconds 1
try {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Msg "警告: $Port 端口仍被占用，请手动检查: Get-NetTCPConnection -LocalPort $Port"
  }
} catch {}

# 4) 可选：回滚 zcode 配置
if ($RevertConfigs) {
  $pairs = @(
    @{ Target = (Join-Path $env:USERPROFILE '.zcode\v2\provider_config.json'); Backup = (Join-Path $env:USERPROFILE '.zcode\v2\provider_config.json.bak-cannbot') },
    @{ Target = (Join-Path $env:USERPROFILE '.zcode\cli\config.json'); Backup = (Join-Path $env:USERPROFILE '.zcode\cli\config.json.bak-cannbot') }
  )
  foreach ($pair in $pairs) {
    $target = $pair.Target
    $backup = $pair.Backup
    if (Test-Path -LiteralPath $backup) {
      Copy-Item -LiteralPath $backup -Destination $target -Force
      Msg "已回滚 $target ← $(Split-Path -Leaf $backup)"
    } elseif ($target -like '*\.zcode\v2\provider_config.json') {
      Msg "⚠️  无备份可回滚: $target"
      Msg "    v2 接入是手动改的、没有自动备份。请手工把该文件里个人 provider 的"
      Msg "    baseUrl 改回官方端点（apiKey 同步换回对应订阅的 key），否则该链路不可用。"
    } else {
      Msg "跳过 $target（无备份 $backup）"
    }
  }
  Msg "注意: 回滚后 zcode CLI 回到接入前状态（glm provider → bigmodel 按量 key，无余额会报 429）"
}

Msg "完成。重新启用: .\install.ps1"
