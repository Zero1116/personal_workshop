#Requires -Version 5.1
<#
install.ps1 — 启用个人网关（Windows：任务计划程序登录自启 + 运行时副本）

用法: .\install.ps1 [端口]      # 缺省 8484（仓库根的 install.ps1 是转发壳，两者等价）
停用: .\uninstall.ps1
状态: .\status.ps1

目录设计：
  项目源目录 = 本脚本所在目录的上一级（仓库根，维护 server.mjs / lib/ 的地方）；
  运行时目录 = %LOCALAPPDATA%\personal-gateway（可用 PGW_RUNTIME_DIR 覆盖），
  安装时把 server.mjs + lib/ + web/index.html + web/theme.css 拷贝过去（运行时摊平到根）；
  任务计划程序在登录时用隐藏窗口启动该副本。
  因此改动代码后需重跑本脚本才生效；providers.json 改动不用（网关按 mtime 热加载）。
#>
[CmdletBinding()]
param(
  [int]$Port = 8484
)

$ErrorActionPreference = 'Stop'

$TaskName = 'PersonalGateway'
# 本脚本在 deploy/ 下：项目源在上一级
$ProjectDir = Split-Path -Parent $PSScriptRoot
if ($env:PGW_RUNTIME_DIR) {
  $RuntimeDir = $env:PGW_RUNTIME_DIR
} else {
  $RuntimeDir = Join-Path $env:LOCALAPPDATA 'personal-gateway'
}
$ProvidersJson = Join-Path $RuntimeDir 'providers.json'
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# 防手滑：运行时目录 = 项目目录时，下面的「先删 lib 再拷」会删掉源文件
$projFull = [System.IO.Path]::GetFullPath($ProjectDir).TrimEnd('\')
$rtFull = [System.IO.Path]::GetFullPath($RuntimeDir).TrimEnd('\')
if ($projFull -eq $rtFull) {
  Write-Host '[install] 错误: 运行时目录不能等于项目目录（安装会覆盖源文件）；请去掉 PGW_RUNTIME_DIR 或指向别处' -ForegroundColor Red
  exit 1
}

function Msg([string]$m) { Write-Host "[install] $m" }
function Die([string]$m) { Write-Host "[install] 错误: $m" -ForegroundColor Red; exit 1 }

# 单引号转义：生成 .ps1 启动器时把路径安全地嵌进去
function PsQuote([string]$s) { return "'" + $s.Replace("'", "''") + "'" }

# Windows 没有 0600：尽量把凭证文件 ACL 收成当前用户（失败不阻塞安装）
function Protect-CredentialFile([string]$Path) {
  try {
    & icacls $Path /inheritance:r /grant:r "$($UserId):F" | Out-Null
  } catch {}
}

function New-RandomHex([int]$Bytes) {
  $buf = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
  return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

if ($Port -lt 1 -or $Port -gt 65535) { Die "端口必须是 1-65535 的整数，收到: $Port" }

# 1) 找 node（>=18，需要内置 fetch）
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe') }
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA 'npm\node.exe') }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
  }
}
# 安装到自定义目录（如 C:\Software\nodejs）时 PATH 里可能还没有它：查注册表 InstallPath
if (-not $node) {
  try {
    $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Node.js' -ErrorAction Stop
    if ($reg.InstallPath) {
      $candidate = Join-Path $reg.InstallPath 'node.exe'
      if (Test-Path -LiteralPath $candidate) { $node = $candidate }
    }
  } catch {}
}
if (-not $node) { Die '未找到 node，请先安装 Node.js >= 18（安装后重开终端）' }
$nodeVer = (& $node --version).Trim()
$major = 0
[void][int]::TryParse(($nodeVer -replace '^v', '').Split('.')[0], [ref]$major)
if ($major -lt 18) { Die "node 版本过低（$nodeVer），需要 >= 18" }
Msg "node: $node ($nodeVer)"
if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
  Msg '提示: 未找到 sqlite3；汇报功能会降级（zcode / opencode 会话读不到）。可安装 sqlite.org tools 并加入 PATH，或用 PGW_SQLITE3 指定完整路径'
}

# 2) 先停旧实例（任务 + 指向运行时目录的 node 进程），保证升级能覆盖运行中的旧版本
try {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  }
} catch {}
try {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $cmdline = $_.CommandLine
    # 运行时副本，或用户此前从项目源目录前台起的同一网关（两者都算旧实例）
    if ($cmdline -and $cmdline -match 'server\.mjs' -and (
        $cmdline.IndexOf($RuntimeDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $cmdline.IndexOf($ProjectDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
} catch {}
Start-Sleep -Seconds 1

# 3) 端口检查（上面的旧实例已停；仍被别的进程占用就明确报错）
try {
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Die "端口 $Port 仍被非本服务进程占用（可换端口: .\install.ps1 8485；Get-NetTCPConnection -LocalPort $Port 查占用者）"
  }
} catch {}

# 4) 拷贝运行时副本
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeDir 'logs') | Out-Null
Set-Content -LiteralPath (Join-Path $RuntimeDir 'port') -Value $Port -Encoding Ascii -NoNewline
Copy-Item -LiteralPath (Join-Path $ProjectDir 'server.mjs') -Destination $RuntimeDir -Force
foreach ($f in @('index.html', 'theme.css')) {
  $src = Join-Path (Join-Path $ProjectDir 'web') $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $RuntimeDir -Force }
}
$libSrc = Join-Path $ProjectDir 'lib'
if (-not (Test-Path -LiteralPath $libSrc)) { Die '源目录缺少 lib/，请勿单独拷贝 server.mjs' }
$libDst = Join-Path $RuntimeDir 'lib'
if (Test-Path -LiteralPath $libDst) { Remove-Item -LiteralPath $libDst -Recurse -Force }
Copy-Item -LiteralPath $libSrc -Destination $RuntimeDir -Recurse -Force
foreach ($f in @('admin.html', 'workbench.html', 'workbench.css')) {
  Remove-Item -LiteralPath (Join-Path $RuntimeDir $f) -Force -ErrorAction SilentlyContinue
}

# 5) providers.json 引导：首次安装从模板生成（含随机网关 token），绝不覆盖已有配置
if (-not (Test-Path -LiteralPath $ProvidersJson)) {
  $tpl = Join-Path $PSScriptRoot 'providers.template.json'
  # 旧用法（直接从仓库目录 .bat 起网关）会在项目目录留一份 providers.json：
  # 首次安装时把它迁过来，别让用户重新填一遍凭证（原文件保留不删）
  $legacyProviders = Join-Path $ProjectDir 'providers.json'
  if (Test-Path -LiteralPath $legacyProviders) {
    Copy-Item -LiteralPath $legacyProviders -Destination $ProvidersJson -Force
    Protect-CredentialFile $ProvidersJson
    Msg "已从项目目录迁移 providers.json 到运行时目录（原文件保留）"
  } elseif (Test-Path -LiteralPath $tpl) {
    $token = 'sk-gw-' + (New-RandomHex 24)
    $raw = [System.IO.File]::ReadAllText($tpl, [System.Text.Encoding]::UTF8)
    $raw = $raw.Replace('__CLIENT_TOKEN__', $token)
    [System.IO.File]::WriteAllText($ProvidersJson, $raw, (New-Object System.Text.UTF8Encoding($false)))
    Protect-CredentialFile $ProvidersJson
    Msg "已生成 $ProvidersJson（仅当前用户可读，含随机网关 token）—— 请编辑填入各订阅的凭证"
  } else {
    Msg '警告: 未找到 providers.template.json，跳过配置生成（网关以内置默认配置运行，仅 cannbot 上游）'
  }
} else {
  Protect-CredentialFile $ProvidersJson
  Msg "保留已有 $ProvidersJson（升级不覆盖凭证；改动无需重启，网关热加载）"
}

# 6) 生成隐藏启动器 + 登录任务
$launcherPath = Join-Path $RuntimeDir 'start-gateway.ps1'
$serverPath = Join-Path $RuntimeDir 'server.mjs'
$errLog = Join-Path $RuntimeDir 'logs\proxy.err.log'
$launcherBody = @(
  ('$env:PGW_PROXY_PORT = ' + (PsQuote ([string]$Port))),
  ('Set-Location -LiteralPath ' + (PsQuote $RuntimeDir)),
  # stderr 只在启动崩溃时才有内容；落盘便于隐藏窗口下排障
  ('& ' + (PsQuote $node) + ' ' + (PsQuote $serverPath) + ' 2>> ' + (PsQuote $errLog))
) -join "`r`n"
[System.IO.File]::WriteAllText($launcherPath, $launcherBody, (New-Object System.Text.UTF8Encoding($true)))

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`""
$registered = $false
try {
  $action = New-ScheduledTaskAction -Execute $psExe -Argument $taskArgument
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
  $principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description '个人网关 personal_gateway（登录自启）' -Force | Out-Null
  $registered = $true
  Msg "已注册登录自启任务: $TaskName"
} catch {
  Msg "任务计划程序注册失败: $($_.Exception.Message)"
}
if (-not $registered) {
  $taskCmd = 'schtasks /Create /TN "' + $TaskName + '" /SC ONLOGON /TR "' + $psExe + ' ' + $taskArgument.Replace('"', '\"') + '" /RL LIMITED /F'
  & cmd.exe /c $taskCmd | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Msg '⚠️  创建登录自启任务失败：本次仍会启动网关，但重启电脑后需手工运行 .\install.ps1 或双击 打开管理界面.bat'
  } else {
    $registered = $true
    Msg "已注册登录自启任务: $TaskName"
  }
}

# 7) 立即启动并健康检查
try {
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
} catch {
  & $psExe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $launcherPath
}

$health = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 500
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2; break } catch {}
}
if (-not $health) {
  Die "服务启动后健康检查未通过。请手动运行 `"$node`" `"$serverPath`" 查看报错（常见：端口占用 / node 不在 PATH）"
}

Msg "✅ 服务已启动: http://127.0.0.1:$Port/v1"
foreach ($p in @($health.providers)) {
  if ($null -eq $p) { continue }
  $jwt = $null
  if ($p.auth) { $jwt = $p.auth.jwt }
  if ($null -ne $jwt) {
    if ($jwt.ok) { $state = 'JWT 有效' } else { $state = "JWT 不可用: $($jwt.error)" }
    $mark = if ($jwt.ok) { '✓' } else { '✗' }
  } else {
    if ($p.auth -and $p.auth.ok) { $state = 'Token 有效'; $mark = '✓' } else { $state = "Token 缺失: $($p.auth.error)"; $mark = '✗' }
  }
  Msg "  $mark $($p.id) ($($p.protocol)): $state"
}

if (Test-Path -LiteralPath $ProvidersJson) {
  try {
    $cfg = Get-Content -LiteralPath $ProvidersJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $token = $cfg.gateway.clientToken
    if ($token) {
      Msg "网关 token: $token"
      Msg "OpenAI 客户端接入:    base_url = http://127.0.0.1:$Port/v1   api_key = $token"
      Msg "Anthropic 客户端接入: ANTHROPIC_BASE_URL = http://127.0.0.1:$Port   ANTHROPIC_AUTH_TOKEN = $token"
    } else {
      Msg '警告: providers.json 未配置 gateway.clientToken，/v1/* 不做客户端鉴权'
    }
  } catch {}
}

Msg "运行时目录: $RuntimeDir（日志: logs\ 与 proxy.log）"
Msg "停用: .\uninstall.ps1    状态: .\status.ps1"
