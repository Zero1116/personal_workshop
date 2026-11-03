# 个人网关 · personal_gateway

把多个编码订阅（CANNWork、Kimi For Coding、GLM Coding Plan…）接到本机一个端口：按请求里的**模型名**路由到对应订阅，自动注入该订阅的凭证。本机所有 Agent（Claude Code、zcode CLI、opencode、任意 OpenAI/Anthropic 客户端）都从这里调用，业务配置里不需要保存任何上游密钥。

同一个页面上还有**个人工作台**：跨 agent 的待办（人与 agent 共用 `/v1/todos`）与**时间段 AI 工作总结**（读四个 agent 的本地会话记录，两级总结成给上级的汇报）。

- 零依赖：Node ≥ 18 内置模块 + 系统 `sqlite3`，无 `package.json`、无构建步骤、无 lint，测试是可直接 `node` 跑的脚本（§8）。
- 仓库目录仍名 `personal_workshop`；2026-11 项目更名为 `personal_gateway`，运行时目录与登录任务名随之更新（旧路径与 `CANNBOT_*` 变量仍被识别，§9）。

> 按需阅读：只接 agent → §1–§3；要用待办与汇报 → §6；排障 → §8；查 REST / 环境变量 → 附录。

---

## 1. 快速开始

> **仅支持 Windows。** 2026-11 移除了 macOS 部署链路（launchd 安装脚本、plist、`.command` 入口）；
> 服务端代码本身是跨平台的，但仓库不再提供 macOS 的安装与卸载脚本。

前置：Node ≥ 18（`test/robustness.mjs` 用了 `import.meta.dirname`，需 ≥ 20.11）。使用汇报功能（读 zcode / opencode 会话库）另需 `sqlite3` CLI，可用 `PGW_SQLITE3` 指定路径。

```powershell
.\install.ps1                 # 缺省 8484；端口被占时 .\install.ps1 8485
.\status.ps1                  # 服务 + 各上游凭证体检 + 最近请求
.\uninstall.ps1 -RevertConfigs   # 停服务 + 移除登录任务；-RevertConfigs 连 zcode 配置一起回滚
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1   # 执行策略受限时
```

首次安装从 `deploy/providers.template.json` 生成 `%LOCALAPPDATA%\personal-gateway\providers.json`（可用 `PGW_RUNTIME_DIR` 覆盖），含随机 `sk-gw-…` 网关 token，用 `icacls` 收成仅当前用户可读，并打印 token 与两种客户端的接入片段。升级不覆盖已有配置；若项目目录里还留着旧的 `providers.json`，会先把它拷过去（原文件保留）。安装会注册登录自启任务 `PersonalGateway` 并立即启动。

不安装、前台调试：`node server.mjs`（产物落在当前目录）。⚠️ 联调真实配置时把 `PGW_VK_CACHE` / `PGW_LOG_FILE` / `PGW_STATS_FILE` / `PGW_TODOS_FILE` / `PGW_REPORTS_FILE` 指到临时目录——否则活的 VK 凭证会写进源目录（曾发生过）。

**双击入口**：`deploy\打开管理界面.bat` 先探活、未启动则拉起，再打开 `http://127.0.0.1:<端口>/`。它优先 `schtasks /Run` 触发 `PersonalGateway`；没有该任务时在项目目录以最小化窗口跑 `node server.mjs`（源码副本，关窗即停）。

**双目录设计（改代码必读）**：服务跑的是安装脚本拷到 `%LOCALAPPDATA%\personal-gateway\` 的副本，拷贝范围只有 `server.mjs` + `lib/` + `web/index.html` + `web/theme.css`（运行时摊平到根）。改这四个后**必须重跑 `.\install.ps1`**；改 `providers.json` 不用——网关按 mtime + size 热加载。`test/`、`skills/`、`docs/`、`deploy/`、`scripts/` 不参与运行。

## 2. 工作原理

```
Claude Code / zcode / opencode / curl …      Authorization: Bearer <网关 token>
        │  OpenAI /v1/*        Anthropic /v1/messages
        ▼
127.0.0.1:8484（只绑回环）
   ├─ 模型名路由   model → provider（providers.json，热加载）
   ├─ 协议处理     同协议字节级直通；跨协议双向翻译
   ├─ 凭证注入     CANNWork JWT+VK 链 / 静态 token，每请求现取
   ├─ 统计管理台   流量、费用、TTFT/TPOT/ITL/E2E
   ├─ 工作台       待办 /v1/todos + 汇报 /admin/report/*
   └─ 可选二监听   gateway.tv:8490（电视墙）、gateway.sync:8491（双机同步）
        ├→ cannbot  HICANN CANNWork（openai）
        ├→ kimi     api.kimi.com/anthropic（anthropic）
        └→ zcode    api.z.ai/api/anthropic（anthropic）
```

三条不变式（动代码前先守）：

1. **零内容注入**：只选上游、换凭证头与模型名，不改写 system/messages。同协议字节级透传；跨协议翻译以「内容逐字保留、只换结构」为红线。OpenAI 透传唯一的 body 修改是补 `stream_options.include_usage`（`streamUsage: false` 可关）。
2. **凭证每请求现取**：CANNWork 每请求读 `session.json`，静态 token 每请求解析——重登或外部刷新立即生效，不用重启。
3. **防自我代理环路**：`baseUrl` 必须直连上游官方域名，绝不能指向网关自身（管理台写入时会校验）。

| 客户端 \ 上游 | openai 订阅（cannbot…） | anthropic 订阅（kimi、zcode…） |
|---|---|---|
| OpenAI 客户端 | 原样透传（逐字节） | 双向翻译：请求 openai→anth + SSE 状态机 |
| Anthropic 客户端 | 双向翻译：请求 anth→openai + SSE 状态机 | **原样直通**（换凭证头与 model 名，SSE 字节级透传） |

翻译层覆盖 system（字符串/块数组）、文本、base64/url 图片、tools 与 tool_choice、tool_use/tool_result 多轮、stop/temperature/top_p/top_k、完整流式事件序列、thinking↔reasoning_content。已知取舍：跨协议路径上 `document`（PDF）块与 `metadata` 无对应，会被忽略；同协议直通不受影响。

## 3. 接入客户端

**OpenAI 兼容客户端**（zcode、openai SDK、curl）：`Base URL = http://127.0.0.1:8484/v1`，`API Key = gateway.clientToken`，`GET /v1/models` 返回全部订阅的聚合目录（`owned_by` 为 provider id）。

```bash
curl http://127.0.0.1:8484/v1/chat/completions \
  -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d '{"model":"kimi/kimi-k2-thinking","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

**Anthropic 协议客户端**（claude-code、anthropic SDK）：`Base URL = http://127.0.0.1:8484`（SDK 自动拼 `/v1/messages`），`ANTHROPIC_AUTH_TOKEN = 网关 token`。网关照收 `Authorization: Bearer` 或 `x-api-key`；`/messages` 是 `/v1/messages` 的别名，`/v1/v1/...` 这类叠加前缀会被折叠。

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<网关token>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8484",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi/kimi-k2-thinking",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "glm-5.3-flash",
    "API_TIMEOUT_MS": "3000000",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "model": "opus"
}
```

**zcode CLI**：`./scripts/cannbot-creds.sh --sync-zcode` 改写 `~/.zcode/cli/config.json` 的 `provider.cannbot` 并写入 token（首次改写前留 `.bak-cannbot` 备份，二次执行不覆盖）；`~/.zcode/v2/provider_config.json` 把个人 provider 的 `baseUrl` 改成 `http://127.0.0.1:8484/v1`、`apiKey` 改成网关 token。

**鉴权边界（如实说明）**：网关 token 挡的是盲扫 `127.0.0.1:8484` 的无凭证请求与端口误暴露后的外部扫探。单用户机器上同 uid 的进程仍能读到 `providers.json`（或经仅回环可读的 `/admin/config` 取 token）——真正的多用户隔离不在本工具定位内。

## 4. 配置与路由

`providers.json` 是唯一配置源，字段说明都写在 `deploy/providers.template.json` 里。形态：

```jsonc
{
  "gateway": { "clientToken": "sk-gw-…", "upstreamHeadersTimeoutMs": 180000 },
  "providers": [
    { "id": "cannbot", "name": "CANNWork",
      "baseUrl": "https://cannbot.hicann.cn/gateway/compatible-mode",   // 不带尾部 /v1
      "protocol": "openai", "auth": { "type": "cannwork-jwt-vk" },
      "models": { "source": "api", "exclude": [] } },
    { "id": "kimi", "baseUrl": "https://api.kimi.com/anthropic", "protocol": "anthropic",
      "auth": { "type": "static-token", "tokenEnv": "KIMI_API_KEY" },
      "models": { "source": "static", "list": [{ "id": "kimi-k2-thinking" }] },
      "enabled": false }                                                // 填好凭证再改 true
  ],
  "routing": { "defaultProvider": "cannbot", "aliases": { "k2": "kimi/kimi-k2-thinking" } },
  "pricing": { "glm-5.3": { "input": 1.2, "output": 4.5 } }
}
```

- **baseUrl 不带尾部 `/v1`**（粘贴带 `/v1` 的会自动剥一层），代码按协议补 `/v1/chat/completions` 或 `/v1/messages`。
- **auth**：`cannwork-jwt-vk`（opencode `session.json` + VK 链）或 `static-token`。静态 token 按 `token` > `tokenEnv` > `tokenFile`（可加 `tokenJsonPath` 用 `a.b.c` 取字段）每请求解析。launchd 里 shell 环境变量不生效，用 `token`/`tokenFile` 最稳——重跑 `install.sh` 会重新生成 plist，手工加的环境变量会丢；Windows 登录任务继承用户环境变量。
- **models.source**：`api` 拉上游目录（CANNWork 走站点专用接口，其余用标准 `GET /v1/models`），`static` 用 `list`。`exclude` 只从 `/v1/models` 隐藏，请求仍可直接指定。
- **endpoints（可选）**：上游真有对应协议入口时写 `{ "openai": "…", "anthropic": "…" }`，入站按协议绑定、同协议直通。名称含 anthropic 不等于 Anthropic Messages 协议——cannbot 的 `/gateway/anthropic` 实际仍是 OpenAI 兼容口，配错会直通失败。
- **pricing**：美元 / 1M tokens，键为模型名或 `pid/模型名`（后者优先），未列出的用内置参考价。费用是**按牌价折算的等效成本**：订阅制上游实际是月费，金额只用于横向比较；记账时点按当时单价入账，改单价不回溯。
- **workbench**：`reportProvider` / `reportModel`（汇报模型）、`remoteProjects`（不在这台机器上做的项目标签，§6）。
- **monitors**：显示器拓扑，本机事实，永不参与双机同步（§7.3）。
- **quota（可选）**：默认按 `baseUrl` 的 host 自动识别，`quota.kind` 只用于显式覆盖，合法值仅 `kimi` / `zhipu` / `none`。CANNWork 的 cap 型额度按 `auth.type` 识别，写这个键会被静默丢弃。

**路由规则**（`/v1/models` 聚合所有已启用订阅）：

| 请求里的 model | 路由到 |
|---|---|
| `kimi/kimi-k2-thinking` | 显式 `pid/model`，上游模型名剥前缀 |
| 裸名且全局唯一（`glm-5.3`） | 其唯一所属订阅 |
| 裸名重名 | 列表消歧为 `pid/model`，裸名不再命中 |
| `routing.aliases` 里的别名 | 别名指向的目标 |
| 查不到（上游新模型） | `defaultProvider` 原样携带，天然自愈 |

目录缓存 TTL 10 分钟，失败负缓存 30 秒，**刷新失败时旧目录沿用最多 1 小时**——一次上游抖动不会把裸名路由打回 `defaultProvider`。所以「刚加的模型看不到」等十分钟是正常的。401 重试按 provider 分：CANNWork 强制跳缓存重取 VK 再试一次，静态 token 不重试，403（账号权限）一律不重试直接透传。

**热加载边界**——不用重启：`clientToken`、`providers[]` 全部字段（含 `enabled`）、`routing`、`pricing`、`workbench`、`monitors`、`upstreamHeadersTimeoutMs`、`tv.tokens/allowedCidrs/maxPerMinute/cacheSeconds/opencodeSource`、`sync.tokens/allowedCidrs/maxPerMinute`、`syncClient.publishOpenCode`。**必须重启**：`gateway.port`、`gateway.maxBodyMB`、`tv.enabled/port/bind`、`sync.enabled/port/bind`、`syncClient.enabled/url/token/intervalSec/push/deviceId`。

管理台「配置」页可直接增删改供应商（写前整体校验、防自环、原子落盘；token 只显示掩码、编辑留空即沿用），保存即热生效。

## 5. 页面

一个单页应用，左栏两级导航，八个视图（都是可收藏的真链接）：

| 组 | 视图 | 内容 |
|---|---|---|
| 工作台 | `#home` 首屏（默认落地） | 左待办右订阅卡：未完成待办、今日完成、每订阅花费与额度环 |
| | `#opencode` | OpenCode 战况墙（idle/running/done）、电视预览、全屏大屏监控（`#monitor`） |
| | `#todos` 待办 | 增删改、子项、详情、时段、筛选与搜索、清理已完成 |
| | `#report` 汇报 | 生成、进度、Markdown 预览、复制/下载、历史、远程项目标签 |
| 管理台 | `#overview` 总览 | 订阅上游卡（凭证体检）、模型 chips、今日速览、显示器输入源 |
| | `#traffic` 统计 | 趋势图、分供应商汇总、模型表、单价表、性能表 |
| | `#test` 诊断 | 测试台、全模型对比、实时日志 |
| | `#providers` 配置 | 供应商增删改与测试、服务控制（重启/停止） |

- 数字键 1–8 按左栏顺序切视图；`/` 在待办视图聚焦搜索；`Esc` 清空。主题按钮亮/暗二态并记忆，旁边的循环钮切换皮肤（琥珀遥测台 → 刻度·纸面 → 遥测·电光）。
- 轮询按视图分支：`/healthz` 每 3s；`/admin/stats` 仅总览/统计，`/admin/log` 仅诊断，`/admin/home` 仅首屏可见时 30s；`/admin/monitors` 因左栏切屏按钮常驻而 10s（总览页 6s，服务端另有 5s 缓存）。切视图时立即各拉一次；待办与汇报不轮询，切回标签页时静默刷新。
- 旧链接兼容：`/workbench` 强制落待办并改写地址；`#latency`→统计、`#log`→诊断、`#stats`→统计、`#stats-7`/`#stats-30`→统计并预选区间。

**首屏额度环口径**（最容易读错的地方）：Kimi / 智谱按 `baseUrl` 的 **host** 认家；智谱接口回报的 percentage 是**已用**，页面显示的是剩余。**CANNWork 是 cap 型**：站点只给上限（`dailyQuota`/`monthlyQuota`）、没有用量接口，所以「已用」取网关自己的账本（`tin + tout`，缓存读已含在 `tin` 里）——这个限额是**软上限、会超出**：超了环画满并标「已超」（`over: true`），因为空环配 `0%` 会被读成「没额度了」，而「用超了还能继续用」是另一回事。额度查询 60 秒缓存并去重并发，失败**不清空**上次值（15 分钟内继续显示 stale，之后标失败）；单家失败不会拖垮整页——花费照常显示，只有环那个位置写原因。

## 6. 个人工作台（待办 + 汇报）

**待办**：标题 + 紧急程度（urgent/normal/someday）+ 项目标签 + 子项清单 + 详情（note）。进行中 → 待办（紧急在前）→ 已完成（折叠）分组；行内可循环状态、删除、暂停；每行都可展开勾子项、回车加子项、编辑详情与时段表。

- note 是**给自己看的备忘**（上下文、链接、待核对的事）：agent 来源硬上限 300 码位，用户 2000，agent 超了直接 400。生成汇报时交给模型过滤改写，不直接进正文。
- 子项非空且全部完成 → 父自动 `done`（`completed_at` 不重盖）；取消任一子项 → 父回 `in_progress` 并撤章；空清单不派生。显式 `PATCH status` 永远生效。
- 时段 `spans=[{id,start,end}]`（`end=null` 为进行中）的用途是**产出日历事件**，一段一条，不是汇报归属的依据。状态切换自动开闭段；也可整组替换或单段增删改；暂停只闭段不改状态。
- 筛选：项目 / 来源（user / agent）/ 紧急度 + 标题关键字，状态记 localStorage；「清理已完成」是全量口径，编辑中的跳过。数据在运行时目录的 `todos.json`，人与 agent 共用。

**汇报**：选预设区间（今日/昨天/本周/上周/近 7 天/近 30 天）或自定义起止 → 生成 → 2s 轮询进度 → Markdown 预览 + 复制 + 下载 `.md` + 历史存档（可按原时间段重跑）。

- 读 **Claude Code / zcode / opencode / Cursor** 四个 agent 的本地会话（只读、互相独立，单源故障只降级不失败），按项目归并、压缩、脱敏（密钥样式 → `[REDACTED]`）。每源有自己的「什么算真人输入」判别式（Claude Code 看 `promptSource=="typed"`、zcode 看 `semantics`、Cursor 靠 `<user>` 标签锚定时间），thinking / tool_result / 子 agent 注入 / 斜杠命令一律排除——「某段会话没进汇报」先查 `lib/report/sources/` 对应适配器的头部注释，那才是权威口径。
- 两级总结：逐待办/项目小结 → 汇总成稿，失败或空响应自动重试一次。正文按待办分节，对不上任何待办的零散会话落到末尾「## 其他」，整体 ≤ 700 字。
- **归属由模型按内容判断**，不按时间重叠。`remoteProjects` 里的待办不参与归属（避免本机同名无关会话被错配），但仍按子项/备忘进正文并标注在另一台机器上进行。
- 证据分级：有会话 → 模型写；无会话但有子项/备忘 → 材料是待办自身；都没有 → 只写「状态：标题」。
- 用哪个模型：`workbench.reportProvider` / `reportModel`，不配则用默认上游第一个可用模型。**总结质量的调优入口集中在 `lib/report-prompts.mjs`**（prompt、截断阈值、脱敏模式都在这一个文件）。

**让 agent 读写待办**：装 `skills/workbench-todos/` 这个 skill（普通仓库内容，随代码分发）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force .\skills\workbench-todos "$HOME\.claude\skills\workbench-todos"
```

（软链需开发者模式或管理员；直接复制即可，升级后重新拷一次。）

装好后说「记一下这个」「我还有什么没做」「标成完成」就会自动走它。三条纪律：token 从回环 `/admin/config` **现取、绝不写死**；`source` 填自己的名字（决定 note 上限）；**先查再写**，别灌重复条目。REST 明细见附录 A。

## 7. 可选功能

电视墙与双机同步**默认关闭**，都在运行时 `providers.json` 里开启，启动失败只记日志、不影响主监听；显示器切源随硬件可用性自动启用或降级。

### 7.1 电视工作台（Aerial 屏保，只读）

给 `0tomhoyt/aerial-tv` 的 `Workbench` 屏保供数据。网关**同进程**再开一个只挂白名单的 LAN 监听（默认 8490），`8484` 的绑定与鉴权一行不动，`/admin/*`、`/v1/*` 不会因此暴露。

```jsonc
"tv": { "enabled": true, "port": 8490, "bind": "0.0.0.0",
        "tokens": [{ "name": "客厅", "token": "<长随机串>" }],
        "allowedCidrs": ["192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "127.0.0.1/32", "::1/128"],
        "cacheSeconds": 5, "maxPerMinute": 30 }
```

- 只认 `GET /tv/v1/snapshot`、`/tv/v1/opencode`、`/tv/v1/health`，其余一律 404；支持 ETag → 304 与 gzip。
- 四道门：Host 必须是 IP 字面量 / `localhost` / `.local` / `*.ts.net`（挡 DNS rebinding）→ 来源命中 `allowedCidrs` → 路由白名单 → `X-Aerial-Token` → 每 token 每分钟 30 次（失败尝试另按 IP 限速）。
- 每台电视一枚 token，与 `clientToken` 相同会在加载时被丢弃；吊销 = 从数组删掉，下一请求即 401。`enabled/port/bind` 改完要重启，`tokens/allowedCidrs/maxPerMinute` 热生效。
- 快照由 `lib/tv-snapshot.mjs` 现算：不含 `spans/perf/days/prices`，`runningMs`、`doneToday` 由服务端算好（电视不做时间戳推导）。ETag 只哈希数据本身、不含 `now`/`runningMs`，否则每分钟都 304 不命中。
- `opencodeSource` = `local` | `auto` | `spoke:<deviceId>`；spoke 经 `PUT /sync/v1/opencode` 投稿（瘦 6KB 电视帧 + rich 32KB 大屏监控帧，先瘦后 rich，同 deviceId 覆盖）。
- 威胁模型：家庭 LAN 上是明文 HTTP，同网段可嗅探 token；它能读到的只有待办标题/项目/紧急度/备注前 80 字与今日用量，不能调模型、改配置或读凭证。别把 `bind` 改成公网可达地址。

### 7.2 双机同步（`gateway.sync`）

枢纽机（建议常开的那台）开 `gateway.sync`（默认 8491），另一台以 `gateway.syncClient` 轮询；不依赖同一 Wi‑Fi，跨网可上 Tailscale（默认 CIDR 已含 `100.64.0.0/10`）。

```jsonc
"sync": { "enabled": true, "port": 8491, "bind": "0.0.0.0",
          "tokens": [{ "name": "macbook", "token": "<长随机串>" }], "maxPerMinute": 120 },   // 枢纽
"syncClient": { "enabled": true, "url": "http://100.x.x.x:8491", "token": "<同上>",
                "intervalSec": 15, "push": true }                                          // 客户机
```

- 白名单：`GET /sync/v1/health|snapshot|config|stats|opencode`、`POST /sync/v1/todos|stats`、`PUT|PATCH /sync/v1/config`、`PATCH|PUT|DELETE /sync/v1/todos/:id`、`PUT /sync/v1/opencode[?rich=1]`；其余（含 `/admin/*`、`/v1/*`）404。鉴权用 `Authorization: Bearer` 或 `X-Workshop-Token`，token 不得与 `clientToken` / TV token 相同。
- 快照 `?since=` 增量。**两种 rev 不是一回事**：待办快照的 `rev` = 该条 `updated_at`；配置快照的 `rev` = 可共享内容的 sha256 指纹（内容不变 rev 就不变）。PATCH 带过期 `rev` → 409；删除走 30 天墓碑，删除幂等（再删 204），撞墓碑按 LWW 复活。
- 同步范围：`providers` / `routing` / `pricing` / `workbench` / `gateway`（剔除角色键 sync、syncClient、tv）。**`monitors` 永不同步**——它描述这台机器接了哪块屏、走哪个 VCP，搬过去只会让那台的 DDC 调用全部失败；它也不进配置 rev 指纹，改显示屏名字不会让两台机器互相覆盖。
- `enabled/url/token/intervalSec/push/deviceId` 改完需重启，`publishOpenCode` 热生效。自检：`curl -H "X-Workshop-Token: <token>" http://<枢纽IP>:8491/sync/v1/snapshot | head -c 600`。

### 7.3 显示器输入源切换

网关只认硬件事实：屏 = 显示器 UUID，输入 = DDC VCP60 值；**不内置任何方向/主机语义**，名字全由用户在页内自填（留空显示编号）。

> **Windows 上默认不可用。** 内置驱动是 macOS 的 `m1ddc`（Apple Silicon 的 DDC 实现）；Windows 没有等价命令行，因此 `GET /admin/monitors` 返回 `available:false` 并给出原因，左栏切屏区与总览卡自动隐藏，其余功能完全不受影响。想启用可以 `PGW_M1DDC` 指向任何参数兼容的 DDC 工具（`get input` / `set input <n>` 接口）。

- `POST /admin/monitors/switch`：`{"input":VCP}` 全部屏同切，`{"target":"输入源名"}` 按名字切，加 `"display":"屏名或UUID"` 单切一台。
- 界面：左栏底部**一台屏一个按钮**（点一下把那台屏切到下一个输入源，其余屏不受影响），下面每个输入源一个「全部 → x」（各屏当前源不一致时「下一个」对它们不是同一个值，所以全切必须显式指定目标）；总览卡里每屏另有「⇄ 下一输入源」。屏名/输入源名可在页内改名（写入 `monitors` 节，热生效，留空恢复编号）。
- 只画**读得出输入源**的屏：连续两次读失败就隐藏那一行（拔掉的屏既切不动也不该占位），无可用屏时左栏底部整块收起。

## 8. 运维与排障

```powershell
.\status.ps1                                              # 服务 + 各上游凭证 + 最近请求
Get-Content "$env:LOCALAPPDATA\personal-gateway\proxy.log" -Tail 20 -Wait
Get-Content "$env:LOCALAPPDATA\personal-gateway\logs\proxy.err.log" -Tail 50
```

测试都不需要真实订阅或真实 agent 数据；端口硬编码且三个 e2e 区间重叠，**必须串行跑**：

| 命令 | 覆盖 | 规模 |
|---|---|---|
| `node test/smoke.mjs` | 四象限协议、鉴权、路由、统计、供应商 CRUD、待办/子项、报告管线、静态资源 | 约 560 项，~25s（缺 sqlite3 跳过两组 fixture） |
| `node test/robustness.mjs` | 多字节跨 chunk、上游断流、原型污染、跨站、并行 tool_use | 20 项 |
| `node test/tv-unit.mjs` / `tv.mjs` | 电视快照与监听（ETag、CIDR、限速、rich 帧 / 端到端） | 74 / 66 项 |
| `node test/sync-unit.mjs` / `sync.mjs` | 同步（rev 仲裁、墓碑、配置合并 / 端到端） | 42 / 41 项 |
| `node test/home-unit.mjs` | 首屏额度解析、降级、花费聚合、响应组装 | 72 项 |

> `tv-unit.mjs` 与 `home-unit.mjs` 未把 `PGW_LOG_FILE` 指到临时目录，跑完会在当前目录留一份 `proxy.log`（已在 .gitignore，可直接删）。

| 现象 | 原因与处理 |
|---|---|
| 401 `gateway_auth_failed` | 客户端没带/带错网关 token → 用安装脚本打印的 token |
| 502 `jwt_expired` / `jwt_missing` | CANNWork 未登录/过期 → 打开 VSCode 的 CANNWork 扩展重新登录 |
| 502 `provider_auth_missing` | 静态 token 未配置 → 补 `auth`（Windows 登录任务继承用户环境变量，设完重新登录） |
| 上游 403 "Model not allowed" | 订阅账号无该模型权限，与网关无关（403 不重试） |
| 模型不在 `/v1/models` | 检查 `models.source` / `list`；也可显式 `pid/model` 直呼（`defaultProvider` 兜底） |
| 连接拒绝 | 网关没运行 → 跑安装脚本；换过端口则客户端同步改 |
| 改了代码不生效 | 重跑安装脚本（服务跑运行时副本）；改 `providers.json` 则即时生效 |
| 文字竖排 / 左栏溢出 | 左栏布局契约被违反：单行 + `min-width:0` + 省略号，禁 `word-break:break-all` |

**凭证刷新**：CANNWork JWT 过期（约 24h）→ 重新登录扩展即可，网关现读无需重启；VK 失效 → 无需操作，链路自动重取；静态 token 失效 → 管理台配置页粘贴新 token，保存即生效。

**已知注意事项**

- **CANNWork 2.0.2 已适配**：模型列表走 `/cannbot/api/models/list`（旧 `/models/personal` 兜底），VK 存 `~/.local/share/opencode/auth.json`。
- **ZCode.app 可能改回你的配置**：在 UI 里改 provider 时它会把 `~/.zcode/v2/provider_config.json` 的 `baseUrl` 写回 bigmodel。zcode 又报「余额不足」时先 `.\status.ps1`，再 `Select-String '127.0.0.1:8484' ~/.zcode/v2/provider_config.json`（无输出即被改回）。
- **zcode CLI 0.16.9 忽略 `model.main`**：实际用个人 provider 存储里第一个 provider 的第一个模型——这是当初「改接现有 provider」而不是「新增 provider」的原因。

## 9. 卸载与回滚

```powershell
.\uninstall.ps1 -RevertConfigs         # 停服务 + 移除登录任务 + 回滚 zcode 配置
```

卸载前把 `todos.json`、`reports.json`、`providers.json` 与 `*.bad` 自愈现场备份到 `<运行时目录>.data-backup-<时间戳>/`，再清理运行时目录（日志、统计等可再生产物不抢救）。`-RevertConfigs` 还原 zcode 的两份 `.bak-cannbot` 备份；v2 配置若是手工改的（无备份），脚本会给出改回指引。

**更名过渡**：登录任务名从 `PersonalGateway` 起一直未变；旧运行时目录 `%LOCALAPPDATA%\cannbot-gateway-proxy\` 若存在会迁移到新目录（数据保留）。旧 `CANNBOT_*` 环境变量仍被识别（`PGW_` 优先）。

**重启 / 停止**（配置页「服务控制」或 `POST /admin/restart|stop`）：由进程自己关监听后 detached 拉起新实例（restart）或直接退出（stop）——登录任务只在登录时触发，不会把停掉的实例拉回来。

---

## 附录

### A. REST 端点

**待办**（Bearer；`clientToken` 未配置时不校验）——写响应返回整只父待办（DELETE 回 204）：

| 端点 | 说明 |
|---|---|
| `GET /v1/todos?status=` | 列表（仅集合；单条 GET 返回 405，列表已含全部字段） |
| `POST /v1/todos` | 新建，可带 `items:[{title,done?}]`、`spans` |
| `PUT\|PATCH /v1/todos/:id` | 部分更新（同义）；可带 `items`/`spans` 整组替换；`status=done` 盖 `completed_at` |
| `DELETE /v1/todos/:id` | 删除（记 30 天墓碑） |
| `POST .../items` · `PATCH\|PUT\|DELETE .../items/:itemId` | 子项增 / 勾选改名 / 删 |
| `POST .../spans` · `PATCH\|PUT\|DELETE .../spans/:spanId` | 时段单段增删改（`{end:null}` 改回进行中） |
| `POST .../spans/open` · `.../spans/close` | 开一段 / 闭所有未闭合段（都不改 status） |

上限：标题 500、note 2000（agent 300）、项目 60、来源 60、子项标题 200、每条待办子项 50、时段 500。

**健康检查**：`GET /healthz` 返回各上游凭证体检（`providers[]`）。它与 `/`、`/theme.css` 一样**不校验 Host、不要求 token**，只靠「监听绑 127.0.0.1」保护。

**管理台**（以下均仅回环 Host；带 ✱ 的写操作另强制 `application/json`）：

`GET /admin/log` · `GET /admin/config`（含网关 token）· `GET /admin/stats` · `GET /admin/home` · `POST /admin/restart|stop`（只要求 POST + 回环，靠 `sec-fetch-site` 挡跨站，**不要求 JSON**）· `GET /admin/monitors` · `POST /admin/monitors/switch ✱|rename ✱` · `POST /admin/workbench/remote-projects ✱` · `GET /admin/tv-opencode`、`POST /admin/tv-opencode ✱`（`?preview=1&rich=1`）· `POST /admin/report/generate ✱` · `GET /admin/report/job|list|:id`、`DELETE /admin/report/:id` · `GET /admin/providers`、`POST /admin/providers ✱`、`PUT /admin/providers/:id ✱`、`DELETE /admin/providers/:id`、`POST /admin/providers/:id/check ✱`。

### B. 环境变量

前缀 `PGW_`；同名旧 `CANNBOT_` 自动兜底（`PGW_` 优先，空串视为未设置）。下表的「默认」均为运行时目录下的相对路径。

| 变量 | 默认 | 用途 |
|---|---|---|
| `PGW_PROXY_PORT` | `8484` | 主监听端口（启动时读；`gateway.port` 次之） |
| `PGW_MAX_BODY_MB` | `32` | 请求体上限（`gateway.maxBodyMB` 次之） |
| `PGW_CONFIG_FILE` | `providers.json` | 配置路径 |
| `PGW_LOG_FILE` | `proxy.log` | 请求日志（5MB 轮转） |
| `PGW_STATS_FILE` | `stats.json` | 本机统计 |
| `PGW_STATS_SYNC_FILE` | `stats-sync.json` | spoke 拉的枢纽合计视图 |
| `PGW_SYNC_STATS_FILE` | `stats-sync-hub.json` | 枢纽侧统计落点 |
| `PGW_TODOS_FILE` | `todos.json` | 待办数据 |
| `PGW_REPORTS_FILE` | `reports.json` | 汇报存档（上限 200） |
| `PGW_VK_CACHE` | `vk-cache.json` | CANNWork VK 缓存（**含活凭证**） |
| `PGW_SESSION_FILE` | `~/.local/share/opencode/session.json` | CANNWork JWT 来源 |
| `PGW_AUTH_FILE` | `~/.local/share/opencode/auth.json` | CANNWork VK 来源 |
| `PGW_EXCLUDE_MODELS` | 空 | 逗号分隔，追加到各 provider 的隐藏模型 |
| `PGW_CC_DIR` | `~/.claude/projects` | 汇报数据源：Claude Code |
| `PGW_ZCODE_DB` | `~/.zcode/cli/db/db.sqlite` | 汇报数据源：zcode |
| `PGW_OPENCODE_DB` | `~/.local/share/opencode/opencode.db` | 汇报/电视墙数据源：opencode |
| `PGW_CURSOR_DIR` | `~/.cursor/projects` | 汇报数据源：Cursor |
| `PGW_SQLITE3` | 查 PATH | sqlite3 CLI 路径 |
| `PGW_M1DDC` | 空（Windows 不可用） | 显示器切源工具；指向兼容 DDC 工具可启用 |
| `PGW_REPORT_RETRY_DELAY_MS` | `1500` | 报告总结失败重试间隔 |
| `PGW_REPORT_BODY_TIMEOUT_MS` | `120000` | 报告上游响应体读取 deadline |
| `PGW_OPENCODE_TV_DEMO` | 空 | 设 `1` 强制电视演示帧（联调用） |
| `PGW_RUNTIME_DIR` | `%LOCALAPPDATA%\personal-gateway` | **仅 Windows 脚本**：运行时目录（不认旧名） |
| `PGW_SKIP_LAUNCHCTL` | 空 | 已随 macOS 部署脚本移除；仍被解析但无副作用 |
| `PGW_PROXY_URL` / `PGW_CREDS_DIR` / `PGW_CREDS_FILE` | 见脚本 | `scripts/cannbot-creds.sh` 的网关地址与凭证落点 |

供应商静态 token 的 `tokenEnv`（如 `KIMI_API_KEY`、`ZAI_API_KEY`）是用户自定义变量名，不走前缀规则。Windows 的登录任务继承用户环境变量，设成用户级后重新登录即可——但用 `token`/`tokenFile` 最省事。

### C. 目录与模块

```
仓库根
├─ server.mjs          入口：HTTP 服务、路由分发、healthz/admin 端点
├─ lib/                配置、模型路由、上游请求、凭证链、双向翻译、统计、待办、汇报管线、电视墙、同步、显示器
├─ web/                静态资源：index.html（八个视图、左栏两级导航）、theme.css
├─ deploy/             install.ps1 / uninstall.ps1 / status.ps1、providers.template.json、打开管理界面.bat
├─ scripts/            cannbot-creds.sh（凭证诊断；--sync-zcode 改写 zcode 配置）
├─ test/               7 个测试 + 2 个 mock（mock-upstream.mjs、mock-m1ddc.mjs）
├─ skills/             workbench-todos/（给 agent 的待办 skill，随代码分发）
├─ docs/               设计文档与实施计划
├─ install.ps1 / uninstall.ps1 / status.ps1    ← 转发壳，等价于 deploy/ 下的同名脚本
└─ README.md / CLAUDE.md / .gitignore
```

根目录的三个 `.ps1` 只是转发壳，让 `.\install.ps1` 这类命令与文件位置解耦；正式逻辑都在 `deploy/` 下。

### D. 设计文档

`docs/superpowers/specs/`（与 `plans/` 成对）：工作台、子项、统一外壳、首屏、显示器切源。`2026-10-29-todo-time-spans-design.md` 记录了「时段归属」上线即被推翻、改由模型判断归属的完整决策史；`docs/tv-opencode-multisource-draft.md` 是多源电视墙的草案与落地说明。实现级约束（模块职责、为什么这么写）见 `CLAUDE.md`。
