/**
 * audit.test.js — 最小停用集审计
 *   - 分层矛盾环分支 + 可回滚带势并查集重建
 *   - 最少停用条数 / 标识升序决胜
 *   - 受理上限 18 条
 *   - 迟到计算不得覆盖当前选择（代际门控）
 * 运行：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RollbackDSU,
  solveAudit,
  auditCheckpoint,
  MAX_AUDIT_ACTIVE,
} = require('../web/js/solver.js');
const { parseScript } = require('../web/js/parser.js');
const { createAuditRunner } = require('../web/js/audit-runner.js');

function runScript(text) {
  const p = parseScript(text);
  if (!p.ok) throw new Error(`脚本解析失败: ${JSON.stringify(p.errors)}`);
  return { p, results: solveAudit(p.ops, p.stations) };
}

function auditScript(text, cpIndex = 0) {
  const { p, results } = runScript(text);
  const r = results[cpIndex];
  return { p, r, audit: auditCheckpoint(r, p.stations, r.activeEdges) };
}

// 朴素可行性：给定保留边集合，按行序并入全新带势并查集
function feasibleEdges(stations, edges) {
  const idx = new Map(stations.map((n, i) => [n, i]));
  const dsu = new RollbackDSU(stations.length);
  for (const e of edges.slice().sort((a, b) => a.line - b.line)) {
    const rr = dsu.union(idx.get(e.u), idx.get(e.v), e.u, e.v, e.d, e);
    if (!rr.ok) return false;
  }
  return true;
}

// 穷举预言机：先按停用条数、再按标识升序取最小可行停用集
function bruteForceMinRemoval(stations, edges) {
  const sorted = edges.slice().sort((a, b) => a.line - b.line || (a.id < b.id ? -1 : 1));
  const n = sorted.length;
  const idsOf = (mask) => sorted.filter((_, i) => mask & (1 << i)).map((e) => e.id).sort();
  const cmp = (a, b) => {
    const k = Math.min(a.length, b.length);
    for (let i = 0; i < k; i += 1) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return a.length - b.length;
  };
  let best = null;
  for (let mask = 0; mask < (1 << n); mask += 1) {
    const kept = sorted.filter((_, i) => !(mask & (1 << i)));
    if (!feasibleEdges(stations, kept)) continue;
    const ids = idsOf(mask);
    if (best === null || ids.length < best.length ||
        (ids.length === best.length && cmp(ids, best) < 0)) {
      best = ids;
    }
  }
  return best;
}

test('示例冲突：最小停用集为 {r1}，保留 r2/r3 后势值可共同成立', () => {
  const { p, r, audit } = auditScript([
    'stations: A,B,C',
    'r1: A→B=5',
    'r2: B→C=-2',
    'checkpoint',
    'r3: A→C=4',
    'checkpoint',
  ].join('\n'), 1);
  assert.equal(r.feasible, false);
  assert.equal(audit.status, 'ok');
  assert.deepEqual(audit.removed, ['r1']); // {r1,r2,r3} 中单条停用三者皆可行，取标识最小者
  assert.deepEqual(audit.kept.map((e) => e.id), ['r2', 'r3']);
  assert.equal(audit.activeCount, 3);

  // 保留系统独立复验相容
  assert.ok(feasibleEdges(p.stations, audit.kept));
  // 势值表满足每条保留关系 x_v - x_u = d
  const wOf = new Map(audit.potentials.map((q) => [q.name, q.w]));
  for (const e of audit.kept) assert.equal(wOf.get(e.v) - wOf.get(e.u), e.d);

  // 分层证据：第 0 层命中原矛盾环 r3（环 r1+r2），第 1 层三个候选全部可行后停止
  assert.equal(audit.layers.length, 2);
  assert.equal(audit.layers[0].depth, 0);
  assert.equal(audit.layers[0].nodes, 1);
  assert.equal(audit.layers[0].feasible, 0);
  assert.equal(audit.layers[0].hits.length, 1);
  const h0 = audit.layers[0].hits[0];
  assert.deepEqual(h0.removedIds, []);
  assert.equal(h0.conflict.id, 'r3');
  assert.equal(h0.conflict.derived, 3n);
  assert.equal(h0.conflict.d, 4n);
  assert.equal(h0.conflict.sum, 3n);
  assert.deepEqual(h0.conflict.ring.map((x) => x.id).sort(), ['r1', 'r2']);
  assert.equal(audit.layers[1].depth, 1);
  assert.equal(audit.layers[1].feasible, 3);
  assert.deepEqual(audit.layers[1].hits, []);
});

test('两个独立矛盾环：最少停用 2 条，按标识升序取 {a,d}', () => {
  const { audit } = auditScript([
    'stations: A,B,C,D,E,F',
    'a: A→B=1', 'b: B→C=1', 'c: A→C=3',
    'd: D→E=1', 'e: E→F=1', 'f: D→F=5',
    'checkpoint',
  ].join('\n'));
  assert.equal(audit.status, 'ok');
  assert.deepEqual(audit.removed, ['a', 'd']);
  // 第 1 层 3 个候选（停 a/b/c 中任一）都仍剩另一处冲突
  assert.equal(audit.layers[1].feasible, 0);
  assert.ok(audit.layers[1].hits.length >= 1);
  // 第 2 层首次可行
  assert.equal(audit.layers[2].feasible > 0, true);
});

test('每条层级证据：命中环为真实证据，候选停用数恰好等于层数', () => {
  const { audit } = auditScript([
    'stations: A,B,C,D',
    'a: A→B=1', 'b: B→C=1', 'c: C→D=1', 'd: A→D=9',
    'e: A→C=2', // 冗余相容，不构成候选
    'checkpoint',
  ].join('\n'));
  assert.equal(audit.status, 'ok');
  for (const layer of audit.layers) {
    for (const hit of layer.hits) {
      assert.equal(hit.removedIds.length, layer.depth);
      // 环中各项相加 = 推导值 ≠ 冲突值
      let sum = 0n;
      for (const row of hit.conflict.ring) {
        const ends = [row.plus, row.minus].sort();
        assert.deepEqual(ends, [row.u, row.v].sort());
        sum += row.contrib;
      }
      assert.equal(sum, hit.conflict.derived);
      assert.notEqual(hit.conflict.derived, hit.conflict.d);
    }
  }
});

test('受理上限：18 条活动冲突可审计，19 条被明确拒绝，可行检查点不受理', () => {
  const mk = (count) => {
    const lines = ['stations: A,B'];
    for (let i = 0; i < count - 1; i += 1) lines.push(`e${i}: A→B=1`);
    lines.push('z: A→B=2');
    lines.push('checkpoint');
    return lines.join('\n');
  };
  const a18 = auditScript(mk(18)).audit;
  assert.equal(a18.status, 'ok');
  assert.equal(a18.activeCount, 18);
  // 17 条一致边互相冗余：停其中任一条，其余 16 条仍强制 A→B=1 与 z=2 冲突，
  // 故唯一的单条可行停用是 {z}
  assert.deepEqual(a18.removed, ['z']);

  const refused = auditScript(mk(19)).audit;
  assert.equal(refused.status, 'too_many_active');
  assert.equal(refused.activeCount, 19);
  assert.equal(refused.limit, MAX_AUDIT_ACTIVE);
  assert.equal(MAX_AUDIT_ACTIVE, 18);

  const { results } = runScript('stations: A,B\nk: A→B=1\ncheckpoint');
  assert.equal(auditCheckpoint(results[0], ['A', 'B'], results[0].activeEdges).status, 'feasible');
});

test('随机对照穷举预言机：最小条数与标识升序决胜完全一致', () => {
  let seed = 0xBEEF49;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 50; trial += 1) {
    const n = 2 + Math.floor(rnd() * 4); // 2..5 个站
    const m = 3 + Math.floor(rnd() * 8); // 3..10 条边（≤18）
    const stations = Array.from({ length: n }, (_, i) => `S${i}`);
    const ids = new Set();
    const lines = [`stations: ${stations.join(',')}`];
    const edges = [];
    for (let i = 0; i < m; i += 1) {
      let id;
      do { id = `id${Math.floor(rnd() * 100000)}`; } while (ids.has(id));
      ids.add(id);
      let u = Math.floor(rnd() * n);
      let v = Math.floor(rnd() * n);
      while (v === u) v = Math.floor(rnd() * n);
      const d = BigInt(Math.floor(rnd() * 7) - 3);
      lines.push(`${id}: ${stations[u]}→${stations[v]}=${d}`);
      edges.push({ id, u: stations[u], v: stations[v], d, line: i + 2 });
    }
    lines.push('checkpoint');

    if (feasibleEdges(stations, edges)) continue; // 预言机只在冲突时有意义
    const { r, audit } = auditScript(lines.join('\n'));
    assert.equal(r.feasible, false, `trial ${trial} 应冲突`);
    assert.equal(audit.status, 'ok', `trial ${trial} 应受理`);
    const want = bruteForceMinRemoval(stations, edges);
    assert.deepEqual(audit.removed, want, `trial ${trial} 最小停用集不一致`);
    // 最小性：条数；并复验保留系统相容、势值满足全部保留式
    assert.ok(feasibleEdges(stations, audit.kept));
    const wOf = new Map(audit.potentials.map((q) => [q.name, q.w]));
    for (const e of audit.kept) assert.equal(wOf.get(e.v) - wOf.get(e.u), e.d);
    // 少于该条数不可能可行
    for (const e of audit.removed) {
      const fewer = audit.removed.filter((x) => x !== e);
      const kept = edges.filter((x) => !fewer.includes(x.id));
      assert.equal(feasibleEdges(stations, kept), false, `trial ${trial} 非最小`);
    }
  }
});

test('代际门控：切换检查点后在途旧结果不得覆盖，失效后迟到结果丢弃', async () => {
  const events = [];
  let resolveA;
  const compute = (payload) => new Promise((resolve) => {
    if (payload === 'A') resolveA = () => resolve('res-A');
    else setTimeout(() => resolve(`res-${payload}`), 10);
  });
  const runner = createAuditRunner(compute, {
    onBegin: (key) => events.push(['begin', key]),
    onResolve: (key, val) => events.push(['resolve', key, val]),
    onStale: (key) => events.push(['stale', key]),
  });

  runner.start('cp1', 'A');
  runner.start('cp2', 'B'); // 在 A 返回前切换检查点
  resolveA();
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(events.some(([t, k]) => t === 'resolve' && k === 'cp2'));
  assert.ok(!events.some(([t, k]) => t === 'resolve' && k === 'cp1'),
    '迟到的 cp1 结果不得覆盖当前选择');
  assert.ok(events.some(([t, k]) => t === 'stale' && k === 'cp1'));

  // 编辑脚本：invalidate 后迟到结果只能走 stale
  events.length = 0;
  let resolveC;
  const compute2 = () => new Promise((resolve) => { resolveC = () => resolve('res-C'); });
  const runner2 = createAuditRunner(compute2, {
    onResolve: (key) => events.push(['resolve', key]),
    onStale: (key) => events.push(['stale', key]),
  });
  runner2.start('cp9', 'C');
  runner2.invalidate();
  resolveC();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!events.some(([t]) => t === 'resolve'), '失效后不得再有 resolve');
  assert.ok(events.some(([t, k]) => t === 'stale' && k === 'cp9'));
  assert.equal(runner2.currentKey(), null);
});
