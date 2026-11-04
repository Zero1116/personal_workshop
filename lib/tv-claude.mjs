// 电视 Claude Code 战况墙快照：把本机 Claude Code 最近会话裁成「够用的一小份 JSON」，
// 供客厅电视屏保 / 指挥台轮询（GET /tv/v1/claude，帧契约与旧 tv-opencode 逐字段一致，
// 所以电视端屏保与前端渲染代码都不用改）。
//
// 数据源：~/.claude/projects/<路径编码目录>/<sessionId>.jsonl（纯文本，会话追加写）。
// 相比旧实现（OpenCode 的 SQLite）少一个外部依赖——不需要 sqlite3 CLI。
//
// ⚠️ 三个实测结论决定了本文件的写法（2026-11-04 对本机 2718 行 / 5.77MB 会话采样）：
//   ① **token 必须按 message.id 去重**。一条上游响应流式期间会拆成多行写入
//      （apiBlockIndex 0..3），每行都复制同一份 usage；直接累加虚高 1.66 倍。
//   ② **绝不能用文件 mtime 判活跃**。启动/恢复会追加 mode/permission-mode/atis-latch/
//      last-prompt 这类无 timestamp 的元数据行，把 mtime 刷新却不产生对话内容
//      （实测 mtime 比最后内容新 86,822 秒）。只看「带 timestamp 的内容行」。
//   ③ **状态判据按优先级**：在飞 api-request（等模型）→ 未配对 tool_use（跑工具）→
//      末行是 assistant 且很近（流式未完）→ 末行 typed user（等模型）→
//      system/turn_duration（回合结束）→ 否则 idle。
//
// 纯函数 [buildClaudeSnapshot] 可注入，便于单测；文件 IO 只出现在 [claudeSnapshotNow]。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { envOf } from './env.mjs';
import { clip } from './tv-snapshot.mjs';

const MAX_TOOLS = 8;
const TITLE_MAX = 80;
const STEP_MAX = 80;
const PROJECT_MAX = 40;
const MODEL_MAX = 48;
const BRANCH_MAX = 40;
const AGENT_MAX = 24;
const TARGET_MAX = 40;

export const SESSIONS_MAX = 3;
export const RICH_LIMITS = { tools: 24, sessions: 8, targetMax: 200, titleMax: 160 };
const RICH_TITLE_MAX = 160;
const BRIEF_TITLE_MAX = 40;
const BRIEF_STEP_MAX = 40;
const BRIEF_PROJECT_MAX = 24;

const STATUSES = new Set(['idle', 'running', 'waiting', 'done', 'failed']);
const TOOL_STATES = new Set(['running', 'ok', 'failed']);

// 非当前会话没有实时工具流可参照：最后内容超过这个时长没更新，按 idle 报。
const BRIEF_RUNNING_STALE_MS = 10 * 60_000;
// 「最近还在动」的窗口：末行 content 距今多久内算活跃。
// 实测 api-request → assistant 延迟 p99=19s / max=37s，所以 60s 足够宽。
const LIVE_WINDOW_MS = 60_000;
// 等用户回答的工具：AskUserQuestion p50=155s、max=65min，不能当成卡死。
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
// 尾部读取回退量：单行 p50 1.27KB / p99 17.8KB / max 103KB，256KB 够覆盖最近几轮。
const TAIL_BYTES = 256 * 1024;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const tsOf = (j) => Date.parse(j?.timestamp || '') || 0;
const basename = (p) => {
  const s = String(p || '').replace(/[/\\]+$/, '');
  if (!s) return undefined;
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return clip(i >= 0 ? s.slice(i + 1) : s, PROJECT_MAX);
};

function projectsRoot() {
  return envOf('PGW_CC_DIR') || path.join(os.homedir(), '.claude', 'projects');
}

// 无 timestamp 的元数据行：不参与任何「最近/最活跃」判断（见文件头 ②）。
const META_ONLY_TYPES = new Set([
  'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'tools-used',
  'cost-state', 'file-history-snapshot', 'file-history-delta', 'queue-operation',
  'api-request-blob', 'api-request-shape', 'attachment', 'ai-title',
]);
const isContentLine = (j) => j && typeof j === 'object' && !META_ONLY_TYPES.has(j.type);

/** 最后一条内容行的时间戳（不信任 mtime）。 */
export function lastContentAt(lines) {
  let t = 0;
  for (const j of lines || []) {
    if (!isContentLine(j)) continue;
    const ts = tsOf(j);
    if (ts > t) t = ts;
  }
  return t;
}

/**
 * 工具事件（最新优先）。Claude Code 只有「已发生的 tool_use / tool_result 对」，
 * 没有状态字段：配不上 tool_result 就是还在跑。
 */
export function extractTools(lines, { limit = MAX_TOOLS, targetMax = TARGET_MAX } = {}) {
  const uses = [];
  const results = new Map();
  for (const j of lines || []) {
    const c = j?.message?.content;
    if (!Array.isArray(c)) continue;
    const at = tsOf(j);
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.id && b.name) {
        uses.push({ id: String(b.id), name: String(b.name), input: b.input, at });
      } else if (b.type === 'tool_result' && b.tool_use_id) {
        results.set(String(b.tool_use_id), { isError: !!b.is_error, at: tsOf(j) });
      }
    }
  }
  uses.sort((a, b) => b.at - a.at);
  const out = [];
  for (const u of uses) {
    const r = results.get(u.id);
    out.push({
      id: clip(u.id, 128) || u.id,
      name: clip(u.name, 16) || u.name,
      target: toolTarget(u.input, targetMax),
      status: r ? (r.isError ? 'failed' : 'ok') : 'running',
      at: r?.at || u.at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function toolTarget(input, max = TARGET_MAX) {
  if (!input || typeof input !== 'object') return undefined;
  for (const k of ['file_path', 'filePath', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt']) {
    if (input[k] != null && String(input[k]).trim()) return clip(String(input[k]), max);
  }
  return undefined;
}

/** 标题 / 项目 / 分支 / 模型 / 去重后 token。 */
export function extractMeta(lines, { titleMax = TITLE_MAX } = {}) {
  let title = '';
  let cwd = '';
  let branch = '';
  let model = '';
  let tokens = 0;
  const seenMsg = new Set(); // ① 按 message.id 去重
  for (const j of lines || []) {
    if (j?.type === 'ai-title' && j.aiTitle) title = String(j.aiTitle);
    if (typeof j?.cwd === 'string' && j.cwd) cwd = j.cwd;
    if (typeof j?.gitBranch === 'string' && j.gitBranch) branch = j.gitBranch;
    const msg = j?.message;
    if (!msg || typeof msg !== 'object') continue;
    // 模型：取最新一条（后面的回合可能换模型）
    if (msg.model) model = String(msg.model);
    else if (j.requestedModel) model = String(j.requestedModel);
    // token：同一 message.id 只算一次
    const u = msg.usage;
    if (u && msg.id && !seenMsg.has(msg.id)) {
      seenMsg.add(msg.id);
      tokens += num(u.input_tokens) + num(u.output_tokens);
    }
  }
  return {
    title: clip(title, titleMax),
    project: basename(cwd),
    branch: clip(branch, BRANCH_MAX),
    model: clip(model, MODEL_MAX),
    tokens,
    // 会话主题（ai-title）与当前话题（last-prompt）是两回事，后者更贴近「现在在干嘛」
    topic: clip(lines?.reduce?.((acc, j) => (j?.type === 'last-prompt' && j.lastPrompt ? String(j.lastPrompt) : acc), ''), TITLE_MAX),
  };
}

/** 会话状态：返回 { status, pendingTools, inFlightRequest }。 */
export function deriveSessionState(lines, now = Date.now()) {
  const arr = Array.isArray(lines) ? lines : [];
  const tools = extractTools(arr, { limit: 64 });
  const pending = tools.filter((t) => t.status === 'running');

  // ① 在飞 api-request：有请求但没有同 requestRef 的 assistant 返回 = 正在等模型
  const answered = new Set();
  for (const j of arr) if (j?.requestRef) answered.add(String(j.requestRef));
  let inFlight = false;
  for (let i = arr.length - 1; i >= 0; i--) {
    const j = arr[i];
    if (j?.type === 'api-request' && j.id && !answered.has(String(j.id))) {
      inFlight = true;
      break;
    }
  }
  if (inFlight) return { status: 'running', pendingTools: pending, inFlightRequest: true };

  // ② 未配对的 tool_use：区分「在跑工具」与「在等用户回答」
  if (pending.length) {
    const asking = pending.some((t) => ASK_TOOLS.has(t.name));
    return { status: asking ? 'waiting' : 'running', pendingTools: pending, inFlightRequest: false };
  }

  // ③ 末条内容行：流式未完 / 刚答完 / 等模型
  const last = lastContentLine(arr);
  const lastAt = tsOf(last);
  const fresh = lastAt > 0 && now - lastAt < LIVE_WINDOW_MS;
  const ended = arr.some((j) => j?.type === 'system' && j?.subtype === 'turn_duration'
    && tsOf(j) >= lastAt - 1000);

  if (fresh) {
    if (last?.type === 'assistant') {
      return { status: last?.message?.stop_reason === 'end_turn' ? 'done' : 'running', pendingTools: pending, inFlightRequest: false };
    }
    if (last?.type === 'user') return { status: 'waiting', pendingTools: pending, inFlightRequest: false };
  }
  if (ended) return { status: 'done', pendingTools: pending, inFlightRequest: false };
  const failed = tools.some((t) => t.status === 'failed');
  return { status: failed ? 'failed' : 'idle', pendingTools: pending, inFlightRequest: false };
}

function lastContentLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isContentLine(lines[i])) return lines[i];
  }
  return null;
}

/** 会话摘要行（大屏右下小卡 / 首页会话列表）。 */
export function buildSessionBrief({ sessionId, lines, now = Date.now() }) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const meta = extractMeta(lines);
  const state = deriveSessionState(lines, now);
  const at = lastContentAt(lines);
  let status = state.status;
  // 非当前会话：running 却很久没动，说明是崩溃/遗留，按 idle 报
  if (status === 'running' && at > 0 && now - at > BRIEF_RUNNING_STALE_MS) status = 'idle';

  const row = { status: STATUSES.has(status) ? status : 'idle', at };
  if (sessionId) row.id = String(sessionId);
  if (meta.title) row.title = clip(meta.title, BRIEF_TITLE_MAX);
  if (meta.project) row.project = clip(meta.project, BRIEF_PROJECT_MAX);

  const active = state.pendingTools[0] || extractTools(lines, { limit: 1, targetMax: BRIEF_STEP_MAX })[0];
  if (active) {
    const target = active.target ? active.target.replace(/^\s*cd\s+\S+\s*&&\s*/, '') : '';
    row.step = clip(target ? `${active.name} ${target}` : active.name, BRIEF_STEP_MAX);
  }
  return row;
}

export function buildSessionBriefs({ sessions = [], now = Date.now(), limit = SESSIONS_MAX } = {}) {
  const out = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const row = buildSessionBrief({ sessionId: s?.sessionId, lines: s?.lines, now });
    if (row) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 组装一帧。输出形状与旧 buildOpenCodeSnapshot **逐字段一致**——
 * 电视端屏保与 hub 投稿都依赖这个契约，换数据源不该让电视改代码。
 */
export function buildClaudeSnapshot({
  lines = [],
  sessionId = null,
  sessions = [],
  demo = false,
  now = Date.now(),
  rich = false,
} = {}) {
  if (!Array.isArray(lines) || !lines.length) {
    return { now, online: true, demo: !!demo, status: 'idle' };
  }

  const limits = rich
    ? { tools: RICH_LIMITS.tools, sessions: RICH_LIMITS.sessions, targetMax: RICH_LIMITS.targetMax, titleMax: RICH_TITLE_MAX }
    : {};
  const tools = extractTools(lines, { limit: limits.tools ?? MAX_TOOLS, targetMax: limits.targetMax ?? TARGET_MAX });
  const meta = extractMeta(lines, { titleMax: limits.titleMax ?? TITLE_MAX });
  const state = deriveSessionState(lines, now);

  const lastAt = lastContentAt(lines);
  let firstAt = 0;
  for (const j of lines) {
    if (!isContentLine(j)) continue;
    const ts = tsOf(j);
    if (ts > 0 && (firstAt === 0 || ts < firstAt)) firstAt = ts;
  }
  const live = state.status === 'running' || state.status === 'waiting';
  const end = live ? now : (lastAt || now);
  const elapsedMs = firstAt > 0 ? Math.max(0, Math.round(end - firstAt)) : 0;

  const out = {
    now,
    online: true,
    demo: !!demo,
    status: STATUSES.has(state.status) ? state.status : 'idle',
    elapsedMs,
    tokens: Math.max(0, Math.round(meta.tokens)),
    stepIndex: 0,
    stepTotal: 0,
  };

  if (meta.title) out.title = clip(meta.title, limits.titleMax ?? TITLE_MAX);

  const active = state.pendingTools[0] || tools[0];
  if (active) {
    const target = active.target ? active.target.replace(/^\s*cd\s+\S+\s*&&\s*/, '') : '';
    out.step = clip(target ? `${active.name} ${target}` : active.name, STEP_MAX);
  }

  // 进度：Claude Code 没有 plan/todo 概念，用「窗口内工具完成比例」近似。
  // 只取到一个工具时也给 1/1（否则完成的会话 stepTotal=0，电视上无从判断收没收尾）。
  if (tools.length >= 1) {
    const doneCount = tools.filter((t) => t.status !== 'running').length;
    out.stepTotal = tools.length;
    out.stepIndex = doneCount;
    out.progress = Math.max(0, Math.min(1, doneCount / tools.length));
  }

  const sess = {};
  if (sessionId) sess.id = String(sessionId);
  if (meta.project) sess.project = meta.project;
  if (meta.branch) sess.branch = meta.branch;
  if (meta.model) sess.model = meta.model;
  sess.agent = clip('claude-code', AGENT_MAX);
  if (Object.keys(sess).length) out.session = sess;

  if (Array.isArray(sessions) && sessions.length) {
    out.sessions = sessions.slice(0, limits.sessions ?? SESSIONS_MAX);
  }
  if (tools.length) {
    out.tools = tools.map((t) => {
      const row = {
        id: t.id,
        name: t.name,
        status: TOOL_STATES.has(t.status) ? t.status : 'ok',
        at: t.at,
      };
      if (t.target) row.target = t.target;
      return row;
    });
  }
  return out;
}

/** 演示帧：网关联调开关 PGW_CLAUDE_TV_DEMO=1 时用；形状与契约一致。 */
export function buildDemoClaudeSnapshot(now = Date.now()) {
  const cycle = 72_000;
  const t = ((now % cycle) + cycle) % cycle;
  const phase = t < 18_000 ? 0 : t < 36_000 ? 1 : t < 54_000 ? 2 : 3;
  const at = (sec) => new Date(now - sec * 1000).toISOString();
  const lines = [
    { type: 'ai-title', aiTitle: '演示：把电视墙数据源换成 Claude Code' },
    { type: 'user', message: { content: '把电视墙的数据源换成 Claude Code' }, promptSource: 'typed', cwd: '/demo/personal_workshop', gitBranch: 'main', timestamp: at(58) },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 1200, output_tokens: 3400 }, content: [
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'lib/tv-claude.mjs' } },
    ] }, gitBranch: 'main', timestamp: at(12) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, timestamp: at(10) },
    { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 300, output_tokens: 900 }, content: [
      { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'web/index.html' } },
    ] }, timestamp: at(6) },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }, timestamp: at(4) },
    { type: 'assistant', message: { id: 'm3', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 200, output_tokens: 600 }, content: [
      { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'node test/tv-unit.mjs' } },
    ] }, timestamp: at(2) },
    ...(phase > 2 ? [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] }, timestamp: at(1) }] : []),
  ];
  return fitClaudeToLimit(buildClaudeSnapshot({ lines, sessionId: 'demo-claude', demo: true, now }));
}

/**
 * 稳定 ETag：只哈希「数据本身」，剔除每次取样都会变的 now / elapsedMs。
 * 直接哈希 body 会让每个请求都产生新 ETag，If-None-Match 永远不命中（电视端
 * 5 秒一拉全部变成 200 全量传输）。
 */
export function etagOfClaude(body) {
  let normalized = body;
  try {
    const obj = JSON.parse(String(body));
    delete obj.now;
    delete obj.elapsedMs;
    normalized = JSON.stringify(obj);
  } catch { /* 非 JSON：按原串哈希 */ }
  return `"${createHash('sha1').update(normalized).digest('base64url').slice(0, 22)}"`;
}

export const CLAUDE_MAX_BYTES = 6 * 1024;
export const CLAUDE_RICH_MAX_BYTES = 32 * 1024;

/** 逐级裁剪到电视契约体积内：会话小卡 → 工具行 → 标题长度（与旧实现同序）。 */
export function fitClaudeToLimit(snapshot, maxBytes = CLAUDE_MAX_BYTES) {
  const bytesOf = (o) => Buffer.byteLength(JSON.stringify(o));
  let s = snapshot;
  if (bytesOf(s) <= maxBytes) return s;

  if (Array.isArray(s.sessions)) {
    while (s.sessions.length && bytesOf(s) > maxBytes) s = { ...s, sessions: s.sessions.slice(0, -1) };
    if (!s.sessions.length) { const { sessions, ...rest } = s; s = rest; }
  }
  if (Array.isArray(s.tools)) {
    while (s.tools.length && bytesOf(s) > maxBytes) s = { ...s, tools: s.tools.slice(0, -1) };
    if (!s.tools.length) { const { tools, ...rest } = s; s = rest; }
  }
  if (bytesOf(s) > maxBytes && typeof s.title === 'string') {
    s = { ...s, title: s.title.slice(0, 40) };
  }
  if (bytesOf(s) > maxBytes && typeof s.step === 'string') {
    s = { ...s, step: s.step.slice(0, 40) };
  }
  return s;
}

// ── 文件 IO ────────────────────────────────────────────────────────────────

/** 行里 tool_use 的条数（用于判断尾部窗口够不够撑起时间线）。 */
function countToolUses(lines) {
  let n = 0;
  for (const j of lines || []) {
    const c = j?.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_use') n++;
  }
  return n;
}

/** 列出所有会话文件（只顶层，排除 <sessionId>/subagents/ 下的子代理 transcript）。 */
function listSessionFiles(root) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out; // 目录不存在 = 没装 Claude Code，回合法 idle 帧
  }
  for (const d of dirs) {
    const dir = path.join(root, d.name);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        out.push({ path: p, sessionId: path.basename(f, '.jsonl'), mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* 正在被删/权限问题 */ }
    }
  }
  // 先按 mtime 粗排（省得读所有文件），精确活跃度由 lastContentAt 在上层重排
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * 只读文件尾部并按行解析。会话可能很大（本机实测单会话 5.77MB / 2718 行），
 * 而战况只需要最近这段。从后往前取 tailBytes，丢掉第一行（大概率被切断）后
 * 逐行 JSON.parse，坏行跳过——活跃会话正在追加，尾部可能有半截行。
 *
 * 窗口不能固定太小：单行 p99 17.8KB / max 103KB（一次大工具输出就是一行），
 * 256KB 曾只容下「当前这次工具调用」，已完成的历史工具全落在窗口外，
 * 时间线只有一条。改由调用方按「攒够多少条工具事件」决定翻倍。
 */
function readTailLines(file, { tailBytes = TAIL_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    const raw = text.split('\n');
    if (start > 0) raw.shift(); // 不是从头读的，首行必是半截
    const out = [];
    for (const line of raw) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t);
        if (j && typeof j === 'object') out.push(j);
      } catch { /* 半截行 / 坏行 */ }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// 电视每 5 秒一拉、管理台预览也会拉：2 秒内复用，避免反复读文件。
const SNAPSHOT_TTL_MS = 2_000;
let snapshotMemo = null; // { at, rich, frame }

/**
 * 组装当前帧。主卡 = 「最后内容时间」最新的会话（不是 mtime，见文件头 ②）。
 * 任何读失败都回 online=true + idle 的合法帧——电视要能画「等待会话」，
 * 不能把「网关离线」与「Claude Code 没在跑」混为一谈。
 */
export async function claudeSnapshotNow({ now = Date.now(), rich = false } = {}) {
  if (envOf('PGW_CLAUDE_TV_DEMO')) return fitClaudeToLimit(buildDemoClaudeSnapshot(now));

  const wall = Date.now();
  if (snapshotMemo && snapshotMemo.rich === rich && wall - snapshotMemo.at < SNAPSHOT_TTL_MS) {
    return { ...snapshotMemo.frame, now };
  }

  const root = projectsRoot();
  const files = listSessionFiles(root);
  if (!files.length) {
    const empty = { now, online: true, demo: false, status: 'idle' };
    snapshotMemo = { at: wall, rich, frame: empty };
    return empty;
  }

  // 候选：mtime 最新的一批，逐个读尾部后按「最后内容时间」重排
  const want = rich ? RICH_LIMITS.sessions : SESSIONS_MAX;
  const candidateCount = Math.min(files.length, Math.max(want * 2, 6));
  // 主卡要展示「最近若干条工具调用」；大工具输出会把单行撑到 100KB 级，
  // 固定窗口会让时间线只剩 1 条。按需翻倍，最多到 4MB 或文件头。
  const wantTools = rich ? 12 : 4;
  const loaded = [];
  for (let i = 0; i < candidateCount; i++) {
    const f = files[i];
    let tailBytes = TAIL_BYTES;
    let lines = readTailLines(f.path, { tailBytes });
    while (i === 0 && tailBytes < 4 * 1024 * 1024) {
      if (countToolUses(lines) >= wantTools || tailBytes >= f.size) break;
      tailBytes *= 2;
      lines = readTailLines(f.path, { tailBytes });
    }
    if (!lines.length) continue;
    loaded.push({ ...f, lines, lastAt: lastContentAt(lines) });
  }
  loaded.sort((a, b) => b.lastAt - a.lastAt);
  if (!loaded.length) {
    const empty = { now, online: true, demo: false, status: 'idle' };
    snapshotMemo = { at: wall, rich, frame: empty };
    return empty;
  }

  const picked = loaded.slice(0, Math.max(1, want));
  const briefs = buildSessionBriefs({
    sessions: picked.map((x) => ({ sessionId: x.sessionId, lines: x.lines })),
    now,
    limit: want,
  });

  const main = picked[0];
  const frame = fitClaudeToLimit(buildClaudeSnapshot({
    lines: main.lines,
    sessionId: main.sessionId,
    sessions: briefs,
    now,
    rich,
  }), rich ? CLAUDE_RICH_MAX_BYTES : CLAUDE_MAX_BYTES);

  snapshotMemo = { at: wall, rich, frame };
  return frame;
}
