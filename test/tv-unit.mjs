// 电视快照 / 监听的纯函数单测（不起进程，快）：
//   截断、runningMs、排序、usage 汇总、快照形状、ETag 稳定性、CIDR、Host、token、限速。
// 运行: node test/tv-unit.mjs
import assert from 'node:assert/strict';
import {
  clip, runningMs, orderTodos, usageToday, buildSnapshot, etagOf, etagMatches,
  startOfLocalDay, fitToLimit, MAX_BYTES, providerCard,
} from '../lib/tv-snapshot.mjs';
import { inCidrs, hostAllowed, normalizeAddress, matchTvToken, createRateLimiter, bucketKey } from '../lib/tv-server.mjs';
import { normalizeTv, TV_DEFAULT_CIDRS } from '../lib/config.mjs';
import { safeEqual } from '../lib/gwauth.mjs';
import {
  buildClaudeSnapshot, buildDemoClaudeSnapshot, deriveSessionState, lastContentAt,
  extractTools, extractMeta, etagOfClaude, fitClaudeToLimit, CLAUDE_MAX_BYTES,
  SESSIONS_MAX, RICH_LIMITS, claudeSnapshotNow,
} from '../lib/tv-claude.mjs';
import {
  putSpokeClaudeFrame, clearSpokeClaudeFrames, resolveClaudeForTv,
  sanitizeSpokeClaudePayload, parseClaudeSource, normalizeClaudeSource,
} from '../lib/tv-claude-hub.mjs';

let passed = 0;
const failures = [];
const pendingChecks = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { pendingChecks.push({ name, r }); return; }
    passed++;
  } catch (e) { failures.push(name); console.log(`  ✗ ${name} — ${e.message}`); }
}
async function settle() {
  for (const { name, r } of pendingChecks) {
    try { await r; passed++; } catch (e) { failures.push(name); console.log(`  ✗ ${name} — ${e.message}`); }
  }
}
const group = (title) => console.log(`— ${title} —`);

group('clip');
check('按码位截断且不劈 emoji', () => {
  assert.equal(clip('😀'.repeat(5), 3), '😀😀😀…');
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('   ', 5), undefined);
  assert.equal(clip(null, 5), undefined);
});

group('runningMs');
check('闭合段相加', () => {
  assert.equal(runningMs({ spans: [{ start: 1000, end: 3000 }, { start: 5000, end: 5500 }] }, 9999), 2500);
});
check('未闭合段算到 now', () => {
  assert.equal(runningMs({ spans: [{ start: 1000, end: null }] }, 4000), 3000);
});
check('坏段跳过、无 spans 为 0', () => {
  assert.equal(runningMs({ spans: [{ start: 0, end: 10 }, { start: 5, end: 1 }, null] }, 100), 0);
  assert.equal(runningMs({}, 100), 0);
  assert.equal(runningMs(null, 100), 0);
});

group('orderTodos');
check('进行中 → 待办；同状态 紧急→普通→不急；再按更新', () => {
  const rows = [
    { status: 'done', urgency: 'urgent', updated_at: 9 },
    { status: 'pending', urgency: 'someday', updated_at: 9 },
    { status: 'pending', urgency: 'urgent', updated_at: 1 },
    { status: 'in_progress', urgency: 'someday', updated_at: 1 },
    { status: 'pending', urgency: 'urgent', updated_at: 5 },
  ];
  assert.deepEqual(orderTodos(rows).map((r) => `${r.status}/${r.urgency}/${r.updated_at}`), [
    'in_progress/someday/1', 'pending/urgent/5', 'pending/urgent/1', 'pending/someday/9', 'done/urgent/9',
  ]);
});

group('usageToday');
check('汇总请求/tokens/费用与 Top 模型份额', () => {
  const u = usageToday({
    today: { req: 10, tin: 100, tout: 50, cost: 1.23456 },
    hours: Array.from({ length: 24 }, (_, i) => ({ req: i })),
    models: [{ model: 'a', req: 6 }, { model: 'b', req: 3 }, { model: 'c', req: 1 }, { model: 'd', req: 0 }],
  });
  assert.equal(u.requests, 10);
  assert.equal(u.tokens, 150);
  assert.equal(u.costUsd, 1.2346);
  assert.equal(u.hours.length, 24);
  assert.deepEqual(u.topModels.map((m) => m.model), ['a', 'b', 'c']);
  assert.deepEqual(u.topModels.map((m) => m.share), [0.6, 0.3, 0.1]);
});
check('空统计不炸', () => {
  const u = usageToday(undefined);
  assert.equal(u.requests, 0);
  assert.equal(u.hours.length, 24);
  assert.deepEqual(u.topModels, []);
});

group('providerCard');
check('裁剪与钳制：名字 24、tier 名 16、remainingPct 收进 0–100', () => {
  const c = providerCard(
    { id: 'p1', name: 'N'.repeat(30) },
    { today: 1.234, days30: 9.876 },
    { state: 'ok', tiers: [
      { name: 'T'.repeat(20), remainingPct: 150 },
      { name: 'monthly', remainingPct: -5, over: true, used: 9, limit: 1, usedPct: 900 },
    ] },
  );
  assert.equal(c.name, 'N'.repeat(24) + '…');
  assert.deepEqual(c.spend, { today: 1.23, days30: 9.88 });
  assert.equal(c.quota.state, 'ok');
  assert.equal(c.quota.tiers[0].name, 'T'.repeat(16) + '…');
  assert.equal(c.quota.tiers[0].remainingPct, 100);
  assert.equal(c.quota.tiers[1].remainingPct, 0);
  assert.equal(c.quota.tiers[1].over, true);
  // tier 的 used/limit/usedPct 是首屏悬浮用的细节，LAN 上不多带
  assert.deepEqual(Object.keys(c.quota.tiers[1]).sort(), ['name', 'over', 'remainingPct']);
  assert.equal(c.quota.error, undefined);
});
check('at 只在 stale 时下发（其余状态带 at 会毁掉 304 的 ETag 语义）', () => {
  const ok = providerCard({ name: 'a' }, {}, { state: 'ok', at: 123, tiers: [] });
  const stale = providerCard({ name: 'a' }, {}, { state: 'stale', at: 123, tiers: [] });
  const err = providerCard({ name: 'a' }, {}, { state: 'error', at: 123, error: 'E'.repeat(100), tiers: [] });
  assert.equal(ok.quota.at, undefined);
  assert.equal(stale.quota.at, 123);
  assert.equal(err.quota.error, 'E'.repeat(80) + '…');
  assert.equal(err.quota.at, undefined);
});
check('未知 state / 坏 quota 按 error；name 缺失回落 id；spend 缺失补 0', () => {
  const c = providerCard({ id: 'xyz' }, undefined, { state: 'weird', tiers: 'nope' });
  assert.equal(c.name, 'xyz');
  assert.equal(c.quota.state, 'error');
  assert.deepEqual(c.quota.tiers, []);
  assert.deepEqual(c.spend, { today: 0, days30: 0 });
  assert.deepEqual(providerCard({ name: 'a' }, {}, null).quota.state, 'error');
});

group('buildSnapshot');
const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
const todos = [
  { id: 'a', title: '进行中的', status: 'in_progress', urgency: 'normal', updated_at: 3, spans: [{ start: now - 600_000, end: null }] },
  { id: 'b', title: '紧急', status: 'pending', urgency: 'urgent', updated_at: 2, note: 'n'.repeat(200) },
  { id: 'c', title: '刚完成', status: 'done', urgency: 'normal', updated_at: 4, completed_at: now - 60_000 },
  { id: 'd', title: '昨天完成', status: 'done', urgency: 'normal', updated_at: 1, completed_at: now - 86_400_000 },
];
check('形状与派生字段', () => {
  const s = buildSnapshot({ todos, stats: {}, now });
  assert.equal(s.version, 2);
  assert.equal(s.now, now);
  assert.equal(s.online, true);
  assert.equal(s.todos.inProgress, 1);
  assert.equal(s.todos.pending, 1);
  assert.equal(s.todos.doneToday, 1);
  assert.deepEqual(s.todos.items.map((t) => t.id), ['a', 'b']);
  assert.equal(s.todos.items[0].runningMs, 600_000);
  assert.ok(s.todos.items[1].note.length <= 81);
  assert.deepEqual(Object.keys(s.todos.items[1]).sort(), ['id', 'note', 'runningMs', 'status', 'title', 'updatedAt', 'urgency']);
});
check('最多 6 条', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, title: `t${i}`, status: 'pending', urgency: 'normal', updated_at: i }));
  assert.equal(buildSnapshot({ todos: many, stats: {}, now }).todos.items.length, 6);
});
check('providers 节：透传卡片、剔除非对象、缺省为空数组', () => {
  const card = providerCard({ name: 'a' }, {}, { state: 'ok', tiers: [] });
  const s = buildSnapshot({ todos, stats: {}, providers: [card, 'junk', null], now });
  assert.equal(s.providers.length, 1);
  assert.equal(s.providers[0].name, 'a');
  assert.deepEqual(buildSnapshot({ todos, stats: {}, now }).providers, []);
});
check('startOfLocalDay 按本地零点', () => {
  assert.equal(new Date(startOfLocalDay(now)).getHours(), 0);
  assert.ok(startOfLocalDay(now) <= now);
});

check('最坏情况体积仍 ≤ 6 KB（超长标题/备注/项目/模型名 + 24 根柱）', () => {
  const worst = Array.from({ length: 6 }, (_, i) => ({
    id: 'x'.repeat(16), title: '待'.repeat(499), note: '注'.repeat(300), project: '项'.repeat(59),
    status: i % 2 ? 'pending' : 'in_progress', urgency: ['urgent', 'normal', 'someday'][i % 3],
    updated_at: now - i, spans: [{ start: now - 3_600_000, end: null }],
  }));
  const stats = {
    today: { req: 123456, tin: 999_999_999, tout: 999_999_999, cost: 123.4567 },
    hours: Array.from({ length: 24 }, () => 123456),
    models: Array.from({ length: 3 }, (_, i) => ({ model: '模'.repeat(40), req: 100_000 - i })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(buildSnapshot({ todos: worst, stats, now })));
  assert.ok(bytes <= 6144, `${bytes} bytes`);
});

check('fitToLimit：订阅脉搏逐级瘦身（error/at → tiers → 整卡），待办活着', () => {
  const longTodos = Array.from({ length: 6 }, (_, i) => ({
    id: `x${i}`, title: '待'.repeat(499), note: '注'.repeat(300), project: '项'.repeat(59),
    status: 'pending', urgency: 'normal', updated_at: i,
  }));
  // 注入的是未经 providerCard 裁剪的原始卡（模拟上游给的极端形状），各级都要被压到：
  const fatCards = Array.from({ length: 4 }, () => ({
    name: 'N'.repeat(24) + '…',
    spend: { today: 0, days30: 0 },
    quota: {
      state: 'error',
      error: 'E'.repeat(300),
      tiers: Array.from({ length: 40 }, () => ({ name: 'T'.repeat(16) + '…', remainingPct: 50 })),
    },
  }));
  const out = fitToLimit(buildSnapshot({ todos: longTodos, stats: {}, providers: fatCards, now }));
  const size = Buffer.byteLength(JSON.stringify(out));
  assert.ok(size <= MAX_BYTES, `${size} bytes`);
  assert.ok(out.todos.items.length >= 1, '待办至少留一条');
  for (const c of out.providers) {
    assert.equal(c.quota.error, undefined, '超限时 error 文案先被剥掉');
    assert.equal(c.quota.at, undefined);
  }
  const tiersLeft = out.providers.reduce((n, c) => n + (c.quota.tiers?.length ?? 0), 0);
  assert.ok(tiersLeft < 4 * 40, `tiers 应该被砍掉一部分（剩 ${tiersLeft}）`);
});
check('fitToLimit：连名字都巨大的卡整卡从尾部丢弃，绝不超字节', () => {
  const longTodos = Array.from({ length: 6 }, (_, i) => ({
    id: `x${i}`, title: '待'.repeat(499), status: 'pending', urgency: 'normal', updated_at: i,
  }));
  const fatCards = Array.from({ length: 4 }, () => ({
    name: 'N'.repeat(2000),
    spend: { today: 0, days30: 0 },
    quota: { state: 'none', tiers: [] },
  }));
  const out = fitToLimit(buildSnapshot({ todos: longTodos, stats: {}, providers: fatCards, now }));
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= MAX_BYTES);
  assert.ok(out.providers.length < 4, `名字放不下就该丢卡（剩 ${out.providers.length}）`);
  assert.ok(out.todos.items.length >= 1, '丢的是卡，不是待办');
});

check('doneToday 按本地零点切（跨午夜前后各一条）', () => {
  const midnight = new Date(2026, 9, 30, 0, 5, 0).getTime();
  const rows = [
    { id: 'a', title: 'a', status: 'done', urgency: 'normal', completed_at: midnight - 60_000, updated_at: 1 },
    { id: 'b', title: 'b', status: 'done', urgency: 'normal', completed_at: midnight - 3_600_000, updated_at: 1 },
    { id: 'c', title: 'c', status: 'done', urgency: 'normal', completed_at: startOfLocalDay(midnight) - 1, updated_at: 1 },
  ];
  assert.equal(buildSnapshot({ todos: rows, stats: {}, now: midnight }).todos.doneToday, 1);
});

group('ETag');
check('同一数据不同 now → 同 ETag（304 才命中）', () => {
  const a = JSON.stringify(buildSnapshot({ todos, stats: {}, now }));
  const b = JSON.stringify(buildSnapshot({ todos, stats: {}, now: now + 60_000 }));
  assert.equal(etagOf(a), etagOf(b));
});
check('数据变 → ETag 变', () => {
  const a = JSON.stringify(buildSnapshot({ todos, stats: {}, now }));
  const b = JSON.stringify(buildSnapshot({ todos: [...todos, { id: 'z', title: '新', status: 'pending', urgency: 'normal', updated_at: 9 }], stats: {}, now }));
  assert.notEqual(etagOf(a), etagOf(b));
});
check('订阅脉搏进哈希：额度/花费变了要重画，now 仍不进', () => {
  const card = providerCard({ name: 'a' }, { today: 1, days30: 2 }, { state: 'ok', tiers: [{ name: 'daily', remainingPct: 80 }] });
  const a = JSON.stringify(buildSnapshot({ todos, stats: {}, providers: [card], now }));
  const same = JSON.stringify(buildSnapshot({ todos, stats: {}, providers: [card], now: now + 60_000 }));
  assert.equal(etagOf(a), etagOf(same));
  const changed = JSON.stringify(buildSnapshot({
    todos, stats: {}, now,
    providers: [providerCard({ name: 'a' }, { today: 1, days30: 2 }, { state: 'ok', tiers: [{ name: 'daily', remainingPct: 70 }] })],
  }));
  assert.notEqual(etagOf(a), etagOf(changed));
});
check('runningMs 每 10 分钟进位才换 ETag（304 仍常态化）', () => {
  const at = (ms) => etagOf(JSON.stringify(buildSnapshot({
    todos: [{ id: 'a', title: 'x', status: 'in_progress', urgency: 'normal', updated_at: 1, spans: [{ start: now - ms, end: null }] }],
    stats: {}, now,
  })));
  // Same bucket → same tag; a bucket later → a new tag, so the shown duration moves on.
  assert.equal(at(60_000), at(5 * 60_000));
  assert.notEqual(at(60_000), at(11 * 60_000));
});
check('etagMatches 支持列表 / 弱校验 / *', () => {
  assert.equal(etagMatches('"x"', '"x"'), true);
  assert.equal(etagMatches('W/"x"', '"x"'), true);
  assert.equal(etagMatches('"a", "x"', '"x"'), true);
  assert.equal(etagMatches('*', '"x"'), true);
  assert.equal(etagMatches('"y"', '"x"'), false);
  assert.equal(etagMatches(undefined, '"x"'), false);
});

group('CIDR');
check('默认私网段命中', () => {
  assert.equal(inCidrs('192.168.1.20', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('10.1.2.3', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('172.16.5.5', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('127.0.0.1', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('::1', TV_DEFAULT_CIDRS), true);
  assert.equal(inCidrs('::ffff:192.168.1.20', TV_DEFAULT_CIDRS), true);
});
check('段外地址拒绝', () => {
  assert.equal(inCidrs('8.8.8.8', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('172.32.0.1', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('100.64.0.1', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('fe80::1', TV_DEFAULT_CIDRS), false);
});
check('CIDR 边界：/0、/32、IPv6 前缀、坏 bits、zone id', () => {
  assert.equal(inCidrs('192.168.1.5', ['0.0.0.0/0']), true);
  assert.equal(inCidrs('192.168.1.5', ['192.168.1.5/32']), true);
  assert.equal(inCidrs('192.168.1.6', ['192.168.1.5/32']), false);
  assert.equal(inCidrs('fd00::1', ['fc00::/7']), true);
  assert.equal(inCidrs('fd00::1', ['fc00::/8']), false);
  assert.equal(inCidrs('10.0.0.1', ['10.0.0.0/33']), false);
  assert.equal(inCidrs('10.0.0.1', ['10.0.0.0/-1']), false);
  assert.equal(inCidrs('fe80::1%eth0', ['fe80::/10']), true);
});

check('坏地址 / 坏网段默认拒绝', () => {
  assert.equal(inCidrs('', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('not-an-ip', TV_DEFAULT_CIDRS), false);
  assert.equal(inCidrs('192.168.1.1', ['192.168.1.0/99', 'nope']), false);
  assert.equal(inCidrs('192.168.1.1', []), false);
});
check('normalizeAddress 去 IPv4 映射前缀', () => {
  assert.equal(normalizeAddress('::ffff:10.0.0.2'), '10.0.0.2');
  assert.equal(normalizeAddress('10.0.0.2'), '10.0.0.2');
});

group('字节上限与配置陷阱');
check('控制字符撑大的快照被压回 6 KB', () => {
  const worst = Array.from({ length: 6 }, (_, i) => ({
    id: 'x'.repeat(16), title: '\u0001'.repeat(499), note: '\u0001'.repeat(300),
    project: '\u0001'.repeat(59), status: 'in_progress', urgency: 'urgent',
    updated_at: now - i, spans: [{ start: now - 3_600_000, end: null }],
  }));
  const stats = { today: { req: 1, tin: 1, tout: 1, cost: 1 }, hours: Array(24).fill(1), models: [{ model: '\u0001'.repeat(40), req: 1 }] };
  const raw = buildSnapshot({ todos: worst, stats, now });
  const fitted = fitToLimit(raw);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MAX_BYTES, `${Buffer.byteLength(JSON.stringify(fitted))} bytes`);
  assert.ok(fitted.todos.items.length >= 1, 'still shows at least one todo');
});
check('正常数据不被 fitToLimit 改动', () => {
  const s = buildSnapshot({ todos, stats: {}, now });
  assert.deepEqual(fitToLimit(s), s);
});
check('CIDR 笔误被丢弃而不是落成白名单', () => {
  assert.equal(normalizeTv({ allowedCidrs: ['999.999.999.999/8'] }).allowedCidrs.length, 5);
  assert.equal(normalizeTv({ allowedCidrs: ['abcd/8'] }).allowedCidrs.length, 5);
  assert.deepEqual(normalizeTv({ allowedCidrs: ['10.0.0.0/8', 'bad'] }).allowedCidrs, ['10.0.0.0/8']);
});
check('TV token 不得与 clientToken 相同', () => {
  const tv = normalizeTv({ tokens: [{ name: 'living', token: 'ct' }, { name: 'bed', token: 'tv' }] }, 'ct');
  assert.deepEqual(tv.tokens.map((t) => t.name), ['bed']);
});

group('Host 反 rebinding');
check('IP 字面量 / .local / localhost / Tailscale MagicDNS 放行', () => {
  assert.equal(hostAllowed('192.168.1.9:8490'), true);
  assert.equal(hostAllowed('[::1]:8490'), true);
  assert.equal(hostAllowed('mac-mini.local:8490'), true);
  assert.equal(hostAllowed('localhost:8490'), true);
  assert.equal(hostAllowed('tomhoytmac-mini.tail76ab40.ts.net:8491'), true);
  assert.equal(hostAllowed('Foo.TS.NET'), true);
});
check('假冒 ts.net 后缀域名拒绝', () => {
  assert.equal(hostAllowed('evil.ts.net.example.com'), false);
  assert.equal(hostAllowed('ts.net.evil.com'), false);
});
check('nip.io 风格的解析回环域名也拒绝（只看 Host 字面量）', () => {
  assert.equal(hostAllowed('1.2.3.4.nip.io'), false);
  assert.equal(hostAllowed('192.168.1.9.evil.com'), false);
});

check('外部域名拒绝', () => {
  assert.equal(hostAllowed('evil.example.com'), false);
  assert.equal(hostAllowed('192.168.1.9.evil.com'), false);
  assert.equal(hostAllowed(''), false);
  assert.equal(hostAllowed(undefined), false);
});

group('token 与限速');
check('matchTvToken 返回名字而非 token', () => {
  const req = { headers: { 'x-aerial-token': 'secret-2' } };
  assert.equal(matchTvToken(req, [{ name: 'a', token: 'secret-1' }, { name: 'b', token: 'secret-2' }]), 'b');
  assert.equal(matchTvToken({ headers: {} }, [{ name: 'a', token: 'secret-1' }]), null);
  assert.equal(matchTvToken({ headers: { 'x-aerial-token': 'secret-' } }, [{ name: 'a', token: 'secret-1' }]), null);
});
check('safeEqual：同值 true、异值 false、长度不同也 false', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});
check('限速桶按 token 名哈希分（重名不会共用额度）', () => {
  assert.notEqual(bucketKey('tv-1'), bucketKey('tv-2'));
  assert.equal(bucketKey('tv-1'), bucketKey('tv-1'));
  assert.ok(!bucketKey('tv-1').includes('tv-1'));
});

check('限速窗口按 key 独立、滚动 60 s，上限每次调用现给', () => {
  const rl = createRateLimiter();
  assert.equal(rl.take('x', 2, 0), true);
  assert.equal(rl.take('x', 2, 1), true);
  assert.equal(rl.take('x', 2, 2), false);
  assert.equal(rl.take('y', 2, 2), true);
  // The limit is read per call: raising it takes effect without a restart.
  assert.equal(rl.take('x', 5, 2), true);
  assert.equal(rl.take('x', 2, 60_001), true);
});

group('normalizeTv');
check('默认关闭 + 默认端口 / 网段', () => {
  const tv = normalizeTv(undefined);
  assert.equal(tv.enabled, false);
  assert.equal(tv.port, 8490);
  assert.deepEqual(tv.tokens, []);
  assert.deepEqual(tv.allowedCidrs, TV_DEFAULT_CIDRS);
  assert.equal(tv.maxPerMinute, 30);
});
check('enabled 只认严格 true', () => {
  assert.equal(normalizeTv({ enabled: 'true' }).enabled, false);
  assert.equal(normalizeTv({ enabled: true }).enabled, true);
});
check('token 归一化：空/重复跳过、补名字', () => {
  const tv = normalizeTv({ tokens: [{ token: 'a' }, { name: 'x', token: '' }, { name: 'b', token: 'a' }, 'c'] });
  assert.deepEqual(tv.tokens.map((t) => t.token), ['a', 'c']);
  assert.equal(tv.tokens[0].name, 'tv1');
  assert.equal(tv.tokens[1].name, 'tv2');
});
check('坏 CIDR / 坏端口回落默认', () => {
  const tv = normalizeTv({ port: 70000, allowedCidrs: ['nope', '10.0.0.0/8'] });
  assert.equal(tv.port, 8490);
  assert.deepEqual(tv.allowedCidrs, ['10.0.0.0/8']);
});
check('cacheSeconds / maxPerMinute 边界', () => {
  assert.equal(normalizeTv({ cacheSeconds: -1 }).cacheSeconds, 5);
  assert.equal(normalizeTv({ cacheSeconds: 0 }).cacheSeconds, 0);
  assert.equal(normalizeTv({ maxPerMinute: 0 }).maxPerMinute, 30);
  assert.equal(normalizeTv({ maxPerMinute: 5 }).maxPerMinute, 5);
});

group('Claude Code 状态机');
check('extractTools：未配对 tool_use = running，配对上 = ok，带 error = failed', () => {
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/p/a.mjs' } },
      { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool_use', id: 'c', name: 'Grep', input: { pattern: 'foo' } },
    ] } },
    { type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'boom' },
    ] } },
  ];
  const tools = extractTools(lines);
  assert.equal(tools.length, 3);
  const byId = Object.fromEntries(tools.map((t) => [t.id, t]));
  assert.equal(byId.a.status, 'ok');
  assert.equal(byId.b.status, 'failed');
  assert.equal(byId.c.status, 'running');
  assert.equal(byId.a.target, '/p/a.mjs');
  assert.equal(byId.b.target, 'npm test');
});
check('deriveSessionState：在飞 api-request → running（等模型）', () => {
  const lines = [
    { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'hi' }, promptSource: 'typed' },
    { type: 'api-request', id: 'req1', timestamp: '2026-01-01T00:00:01Z' },
  ];
  assert.equal(deriveSessionState(lines, Date.parse('2026-01-01T00:00:02Z')).status, 'running');
});
check('deriveSessionState：api-request 已配对 + end_turn → done', () => {
  const lines = [
    { type: 'api-request', id: 'req1', timestamp: '2026-01-01T00:00:01Z' },
    { type: 'assistant', requestRef: 'req1', timestamp: '2026-01-01T00:00:03Z',
      message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
  ];
  assert.equal(deriveSessionState(lines, Date.parse('2026-01-01T00:00:04Z')).status, 'done');
});
check('deriveSessionState：未配对 AskUserQuestion → waiting（等人，不是卡死）', () => {
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [
      { type: 'tool_use', id: 'q', name: 'AskUserQuestion', input: { questions: [] } },
    ] } },
  ];
  assert.equal(deriveSessionState(lines, Date.parse('2026-01-01T00:00:30Z')).status, 'waiting');
});
check('deriveSessionState：turn_duration 收尾 → done', () => {
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
      message: { content: [{ type: 'text', text: '答完了' }], stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'turn_duration', timestamp: '2026-01-01T00:00:00.020Z' },
  ];
  assert.equal(deriveSessionState(lines, Date.parse('2026-01-01T00:10:00Z')).status, 'done');
});
check('deriveSessionState：久无写入且无收尾 → idle', () => {
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'x' }] } },
  ];
  assert.equal(deriveSessionState(lines, Date.parse('2026-01-01T05:00:00Z')).status, 'idle');
});
check('lastContentAt 忽略无 timestamp 的元数据行（启动会刷新 mtime 但不算活跃）', () => {
  const lines = [
    { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [] } },
    { type: 'last-prompt', lastPrompt: '恢复会话' },
    { type: 'mode', mode: 'default' },
    { type: 'permission-mode', mode: 'default' },
  ];
  assert.equal(lastContentAt(lines), Date.parse('2026-01-01T00:00:00Z'));
});

group('Claude Code 快照');
const mkLines = ({ withResult = false, title = '会话标题' } = {}) => {
  const t = (s) => new Date(1_000_000 + s * 1000).toISOString();
  const lines = [
    { type: 'ai-title', aiTitle: title },
    { type: 'user', promptSource: 'typed', cwd: '/p/project-a', gitBranch: 'feat/x', timestamp: t(0), message: { content: '做事' } },
    { type: 'assistant', timestamp: t(1), message: {
      id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [{ type: 'tool_use', id: 'c1', name: 'Edit', input: { file_path: 'a.kt' } }],
    } },
  ];
  if (withResult) {
    lines.push({ type: 'user', timestamp: t(2), message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] } });
  }
  return lines;
};
check('无行 → online idle 极简帧（不含 elapsedMs/tokens）', () => {
  const s = buildClaudeSnapshot({ now: 1000 });
  assert.equal(s.online, true);
  assert.equal(s.status, 'idle');
  assert.equal(s.demo, false);
  assert.equal(s.now, 1000);
  assert.equal(s.session, undefined);
  assert.equal(s.elapsedMs, undefined);
});
check('运行中：未配对工具 + step + 会话元数据', () => {
  const s = buildClaudeSnapshot({ lines: mkLines(), sessionId: 'ses1', now: 1_000_000 + 3000 });
  assert.equal(s.status, 'running');
  assert.equal(s.session.id, 'ses1');
  assert.equal(s.session.project, 'project-a');
  assert.equal(s.session.branch, 'feat/x');
  assert.equal(s.session.model, 'claude-opus-5-5');
  assert.equal(s.session.agent, 'claude-code');
  assert.equal(s.step, 'Edit a.kt');
  assert.equal(s.tokens, 120);
  assert.equal(s.title, '会话标题');
});
check('token 按 message.id 去重（流式多行重复同一份 usage，不能累加）', () => {
  const t = (s) => new Date(1_000_000 + s * 1000).toISOString();
  const lines = [0, 1].map((i) => ({
    type: 'assistant', timestamp: t(i),
    message: { id: 'msg-dup', model: 'm', usage: { input_tokens: 100, output_tokens: 50 }, content: [] },
  }));
  assert.equal(extractMeta(lines).tokens, 150); // 不是 300
});
check('已完成：工具全部配对 + turn_duration → done', () => {
  const lines = mkLines({ withResult: true });
  lines.push({ type: 'system', subtype: 'turn_duration', timestamp: new Date(1_000_000 + 2500).toISOString() });
  const s = buildClaudeSnapshot({ lines, now: 1_000_000 + 3000 });
  assert.equal(s.status, 'done');
  assert.equal(s.stepIndex, 1);
  assert.equal(s.stepTotal, 1);
  assert.equal(s.progress, 1);
});

group('Claude Code 裁剪与 ETag');
check('etag 稳定：同数据同 ETag，数据变则变', () => {
  const a = JSON.stringify({ status: 'idle', title: 'x' });
  assert.equal(etagOfClaude(a), etagOfClaude(JSON.stringify({ status: 'idle', title: 'x' })));
  assert.notEqual(etagOfClaude(a), etagOfClaude(JSON.stringify({ status: 'running', title: 'x' })));
});
check('fit 到 6KB：大量工具被逐级裁剪', () => {
  const many = [];
  for (let i = 0; i < 200; i++) {
    many.push({ type: 'assistant', timestamp: new Date(1_000_000 + i).toISOString(), message: {
      content: [{ type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: '巨'.repeat(300) } }],
    } });
  }
  const s = buildClaudeSnapshot({ lines: mkLines().concat(many), now: 1_000_000 + 500 });
  assert.ok(Buffer.byteLength(JSON.stringify(fitClaudeToLimit(s))) <= CLAUDE_MAX_BYTES);
});
check('demo 帧符合契约（status 合法、体积 ≤6KB）', () => {
  const d = buildDemoClaudeSnapshot(1_000_000);
  assert.ok(['idle', 'running', 'waiting', 'done', 'failed'].includes(d.status));
  assert.ok(Buffer.byteLength(JSON.stringify(d)) <= CLAUDE_MAX_BYTES);
});
check('rich 档放宽 title 上限', () => {
  const lines = mkLines({ title: '题'.repeat(200) });
  const thin = buildClaudeSnapshot({ lines, now: 1_000_000 });
  const rich = buildClaudeSnapshot({ lines, now: 1_000_000, rich: true });
  // clip() 按码位截断并追加省略号：thin 80+1，rich 160+1
  assert.equal(Array.from(thin.title).length, 81);
  assert.equal(Array.from(rich.title).length, 161);
});

group('枢纽（spoke 缓存与选源）');
check('sanitize：白名单外键剥离（含 deviceId 自身）', () => {
  const { frame } = sanitizeSpokeClaudePayload({ online: true, status: 'idle', deviceId: 'mb', now: 1, junk: 'x' });
  assert.equal(frame.status, 'idle');
  assert.ok(!('junk' in frame));
  assert.ok(!('deviceId' in frame));
});
check('sanitize：瘦档拟合 6KB，rich 档保留 24 条工具', () => {
  const tools = Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, name: 'Edit', status: 'ok', at: 1, target: 'x'.repeat(20) }));
  const thin = sanitizeSpokeClaudePayload({ online: true, status: 'running', now: 1, tools });
  assert.ok(Buffer.byteLength(JSON.stringify(thin.frame)) <= CLAUDE_MAX_BYTES);
  const rich = sanitizeSpokeClaudePayload({ online: true, status: 'running', now: 1, tools }, { rich: true });
  assert.equal(rich.frame.tools.length, 24);
});
check('parseClaudeSource：local/auto/spoke 与非法回落', () => {
  assert.deepEqual(parseClaudeSource('local'), { mode: 'local' });
  assert.deepEqual(parseClaudeSource('auto'), { mode: 'auto' });
  assert.deepEqual(parseClaudeSource('spoke:macbook'), { mode: 'spoke', deviceId: 'macbook' });
  assert.deepEqual(parseClaudeSource('garbage!!'), { mode: 'local' });
  assert.equal(normalizeClaudeSource('spoke:mb'), 'spoke:mb');
});
check('resolveClaudeForTv：local 用本机帧并盖 source', () => {
  const out = resolveClaudeForTv({ claudeSource: 'local', localFrame: { now: 1, online: true, status: 'idle' }, now: 1000 });
  assert.equal(out.source.kind, 'local');
  assert.equal(out.status, 'idle');
});
check('resolveClaudeForTv：spoke 新鲜则用投稿帧，过期则回落本机', () => {
  clearSpokeClaudeFrames();
  const local = { now: 1, online: true, status: 'idle' };
  putSpokeClaudeFrame('mb', { online: true, status: 'running', title: '笔记本' }, { receivedAt: 5000, tokenName: 'macbook' });
  const fresh = resolveClaudeForTv({ claudeSource: 'spoke:mb', localFrame: local, now: 6000, staleMs: 45_000 });
  assert.equal(fresh.source.kind, 'spoke');
  assert.equal(fresh.title, '笔记本');
  const stale = resolveClaudeForTv({ claudeSource: 'spoke:mb', localFrame: local, now: 60_000, staleMs: 45_000 });
  assert.equal(stale.source.kind, 'local');
});
check('resolveClaudeForTv：auto 只在 spoke 新鲜且 running 时跟它', () => {
  clearSpokeClaudeFrames();
  const local = { now: 1, online: true, status: 'idle' };
  putSpokeClaudeFrame('mb', { online: true, status: 'idle' }, { receivedAt: 5000 });
  assert.equal(resolveClaudeForTv({ claudeSource: 'auto', localFrame: local, now: 6000 }).source.kind, 'local');
  putSpokeClaudeFrame('mb', { online: true, status: 'running' }, { receivedAt: 7000 });
  assert.equal(resolveClaudeForTv({ claudeSource: 'auto', localFrame: local, now: 8000 }).source.kind, 'spoke');
});
check('deviceId 首认领：别的 token 冒名投稿 → conflict', () => {
  clearSpokeClaudeFrames();
  assert.equal(putSpokeClaudeFrame('mb', { status: 'idle' }, { tokenName: 'tok-a' }), true);
  assert.equal(putSpokeClaudeFrame('mb', { status: 'idle' }, { tokenName: 'tok-b' }), 'conflict');
  assert.equal(putSpokeClaudeFrame('mb', { status: 'idle' }, { tokenName: 'tok-a' }), true);
});
check('非法 deviceId 拒收', () => {
  assert.equal(putSpokeClaudeFrame('bad id!', { status: 'idle' }), false);
});

group('claudeSnapshotNow（真实文件 IO）');
check('读临时 Claude 会话目录 → 字段完整（覆盖文件读取链路）', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fsx = await import('node:fs');
  const tmp = fsx.mkdtempSync(path.join(os.tmpdir(), 'cc-tv-'));
  const dir = path.join(tmp, 'proj');
  fsx.mkdirSync(dir);
  const t0 = Date.now() - 5000;
  const iso = (ms) => new Date(ms).toISOString();
  const lines = [
    { type: 'ai-title', aiTitle: '真实链路' },
    { type: 'user', promptSource: 'typed', cwd: '/p/real-proj', gitBranch: 'main', timestamp: iso(t0), message: { content: '做事' } },
    { type: 'assistant', timestamp: iso(t0 + 1000), message: { id: 'm1', model: 'claude-opus-5-5', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'x.mjs' } }] } },
  ];
  fsx.writeFileSync(path.join(dir, 'sess1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const prev = process.env.PGW_CC_DIR;
  process.env.PGW_CC_DIR = tmp;
  try {
    const snap = await claudeSnapshotNow({ now: Date.now() });
    assert.equal(snap.online, true);
    assert.equal(snap.session.project, 'real-proj');
    assert.equal(snap.session.branch, 'main');
    assert.equal(snap.session.id, 'sess1');
    assert.ok(['running', 'waiting'].includes(snap.status), 'status=' + snap.status);
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= CLAUDE_MAX_BYTES);
  } finally {
    if (prev === undefined) delete process.env.PGW_CC_DIR; else process.env.PGW_CC_DIR = prev;
    fsx.rmSync(tmp, { recursive: true, force: true });
  }
});

group('CIDR 空前缀笔误 / Host 裸 IPv6（fail-open 修复）');
check('空前缀「1.2.3.4/」不再被当 /0 放行全网段', () => {
  // Number('') === 0 曾把多敲一个斜杠的笔误解析成 /0（匹配所有 IPv4/IPv6），
  // 来源白名单形同虚设——必须按非法配置拒绝（不入白名单）
  assert.equal(inCidrs('8.8.8.8', ['1.2.3.4/']), false);
  assert.equal(inCidrs('fd00::99', ['fd00::1/']), false);
  assert.equal(inCidrs('192.168.1.5', ['192.168.0.0/']), false);
  // 合法写法不受影响
  assert.equal(inCidrs('192.168.1.5', ['192.168.0.0/16']), true);
});
check('hostAllowed 认裸 IPv6（无方括号 ::1）与 mapped v4', () => {
  // /:\d+$/ 曾把 ::1 的「:1」当端口剥掉剩 ':'，第一道门就 403（fail-closed 但难排查）
  assert.equal(hostAllowed('::1'), true);
  assert.equal(hostAllowed('[::1]'), true);
  assert.equal(hostAllowed('[::1]:8490'), true);
  assert.equal(hostAllowed('::ffff:127.0.0.1'), true);
  assert.equal(hostAllowed('evil.example.com'), false);
});

await settle();
console.log(`\n结果: ${passed} 通过, ${failures.length} 失败${failures.length ? ` — ${failures.join(' ; ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
