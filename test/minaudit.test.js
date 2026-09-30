/**
 * minaudit.test.js — 最小停用集审计
 * 运行：node --test test/
 *
 * 覆盖：
 *   - 示例冲突检查点的最小停用集（最少条数 + 标识升序决胜 + 可行势值）；
 *   - 活动关系超过 18 条上限被明确拒绝，18 条受理；
 *   - 逐层矛盾环分支、可回滚带势并查集重建、层下界剪枝（不贪心、不枚举全部子集）；
 *   - 矛盾环为生成森林上的真实简单环（不遗漏被大小合并折叠的关系、无重复边）；
 *   - liveEdgesAt 只取“当时活动”的关系；
 *   - AuditDSU 回滚后结构完全复原。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AuditDSU,
  minDisableAudit,
  liveEdgesAt,
  MAX_MIN_AUDIT_ACTIVE,
} = require('../web/js/solver.js');
const { parseScript } = require('../web/js/parser.js');

const E = (id, u, v, d, line) => ({ id, u, v, d: BigInt(d), line });

function runExample() {
  const text = [
    'stations: A,B,C',
    'r1: A→B=5',
    'r2: B→C=-2',
    'checkpoint',
    'r3: A→C=4',
    'checkpoint',
    'withdraw r3',
    'checkpoint',
  ].join('\n');
  const p = parseScript(text);
  assert.ok(p.ok);
  return p;
}

test('示例冲突检查点：停用 1 条即可，按标识升序取 {r1}，保留关系势值可行', () => {
  const p = runExample();
  const edges = liveEdgesAt(p.ops, 2);
  assert.deepEqual(edges.map((e) => e.id), ['r1', 'r2', 'r3']);

  const out = minDisableAudit(edges, p.stations);
  assert.equal(out.status, 'ok');
  assert.equal(out.solutionLevel, 1, '第 1 层即首次可行');
  assert.deepEqual(out.disabled, ['r1']);
  assert.deepEqual(out.retained, ['r2', 'r3']);

  // 可行势值：保留 r2(B→C=-2，即 x_C-x_B=-2)、r3(A→C=4)
  const w = Object.fromEntries(out.potentials.map((q) => [q.name, q.w]));
  assert.equal(w.C - w.B, -2n);
  assert.equal(w.B - w.C, 2n);
  assert.equal(w.C - w.A, 4n);

  // 第 0 层命中推导值 3 vs 冲突值 4 的真实矛盾环，候选为环上全部关系
  const rootHit = out.layers[0].hits[0];
  assert.equal(rootHit.closing.id, 'r3');
  assert.equal(rootHit.derived, 3n);
  assert.equal(rootHit.conflict, 4n);
  let sum = 0n;
  for (const row of rootHit.ring) sum += row.contrib;
  assert.equal(sum, 3n);
  assert.deepEqual(rootHit.candidates, ['r1', 'r2', 'r3']);
  assert.deepEqual(rootHit.ring.map((r) => r.id), ['r1', 'r2']);

  // 第 1 层三个单点停用集都可行，标识升序决胜取 {r1}
  const feasible = out.layers[1].feasible.map((s) => s.join(''));
  assert.deepEqual(feasible.sort(), ['r1', 'r2', 'r3']);
});

test('liveEdgesAt：撤回的关系不属于当时活动集，未到检查点的登记也不计入', () => {
  const p = runExample();
  assert.deepEqual(liveEdgesAt(p.ops, 1).map((e) => e.id), ['r1', 'r2']);
  assert.deepEqual(liveEdgesAt(p.ops, 2).map((e) => e.id), ['r1', 'r2', 'r3']);
  assert.deepEqual(liveEdgesAt(p.ops, 3).map((e) => e.id), ['r1', 'r2']);
});

test('超过 18 条活动关系被明确拒绝；恰 18 条受理', () => {
  const stations = ['A', 'B'];
  const mk = (n) => Array.from({ length: n }, (_, i) =>
    E(`z${String(i).padStart(2, '0')}`, 'A', 'B', i, i + 1));

  const rejected = minDisableAudit(mk(19), stations);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.code, 'too_many_active');
  assert.equal(rejected.activeCount, 19);
  assert.equal(rejected.limit, MAX_MIN_AUDIT_ACTIVE);
  assert.equal(MAX_MIN_AUDIT_ACTIVE, 18);

  const accepted = minDisableAudit(mk(18), stations);
  assert.equal(accepted.status, 'ok');
  // 18 条两两取值不同的并行边，任取两条才相容 ⇒ 最少停用 17 条
  assert.equal(accepted.disabled.length, 17);
  assert.equal(accepted.retained.length, 1);
});

test('真实矛盾环不遗漏被大小合并折叠的关系（不能按单链接环直接删边）', () => {
  // 先并入两条互不相连的边（按大小合并后它们被折叠进同一条“链接”），
  // 再用两条跨分量关系闭合：真实环为 r1→r3→r2 闭合于 r4。
  const stations = ['A', 'B', 'C', 'D'];
  const edges = [
    E('r1', 'A', 'B', 1, 1),
    E('r2', 'C', 'D', 1, 2),
    E('r3', 'A', 'C', 10, 3),
    E('r4', 'B', 'D', 7, 4),
  ];
  const out = minDisableAudit(edges, stations);
  assert.equal(out.status, 'ok');
  const rootHit = out.layers[0].hits[0];
  assert.equal(rootHit.closing.id, 'r4');
  // 环必须包含被折叠的 r1、r2 以及桥边 r3，否则停用集不是最小
  assert.deepEqual(rootHit.ring.map((r) => r.id).sort(), ['r1', 'r2', 'r3']);
  assert.deepEqual(rootHit.candidates, ['r1', 'r2', 'r3', 'r4']);
  // 停用任意一条环上关系即可：最小集大小为 1，标识升序决胜 r1
  assert.equal(out.solutionLevel, 1);
  assert.deepEqual(out.disabled, ['r1']);
});

test('最小层数优先于标识升序：单条删除无解时继续向下一层', () => {
  // 两个独立三角形各自冲突，任删一条都无法同时消掉两个矛盾 ⇒ 必须停用 2 条
  const stations = ['A', 'B', 'C', 'D', 'E'];
  const edges = [
    E('a1', 'A', 'B', 1, 1),
    E('a2', 'B', 'C', 1, 2),
    E('a3', 'A', 'C', 9, 3), // 冲突环一：a1,a2,a3
    E('b1', 'C', 'D', 1, 4),
    E('b2', 'D', 'E', 1, 5),
    E('b3', 'C', 'E', 9, 6), // 冲突环二：b1,b2,b3
  ];
  const out = minDisableAudit(edges, stations);
  assert.equal(out.status, 'ok');
  assert.equal(out.solutionLevel, 2);
  assert.equal(out.disabled.length, 2);
  // 两个环各自必须停用至少一条；整体标识升序最小为 {a1,b1}
  assert.deepEqual(out.disabled, ['a1', 'b1']);
  // 第 1 层无任何可行停用集（下界剪枝的直接体现）
  assert.deepEqual(out.layers[1].feasible, []);
  assert.ok(out.layers[1].hits.length > 0);

  // 未枚举全部子集：6 条边共 64 个候选集，实际评估远少于此
  assert.ok(out.stats.evaluated < 64, `evaluated=${out.stats.evaluated}`);
  assert.ok(out.stats.pruned > 0, '层下界剪枝应当发生');
});

test('逐层搜索：同层候选按标识升序穷尽，唯一可行单点解为闭合坏边', () => {
  // 一致三边 e1+e2 ⇒ A→C=3（e3 冗余相容），坏边 ebad=9 与之冲突：
  // 删 e1/e2/e3 任一条后 ebad 仍与其余路径冲突，唯一单点可行解为 {ebad}
  const stations = ['A', 'B', 'C'];
  const edges = [
    E('e1', 'A', 'B', 1, 1),
    E('e2', 'B', 'C', 2, 2),
    E('e3', 'A', 'C', 3, 3),
    E('ebad', 'A', 'C', 9, 4),
  ];
  const out = minDisableAudit(edges, stations);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.disabled, ['ebad']);
  assert.equal(out.solutionLevel, 1);
  // 同一停用集只评估一次：评估数 ≤ 分支数 + 根
  assert.ok(out.stats.evaluated <= out.stats.branched + 1);
});

test('本就可行的检查点返回 feasible，不产生停用集', () => {
  const stations = ['A', 'B'];
  const out = minDisableAudit([E('a', 'A', 'B', 3, 1)], stations);
  assert.equal(out.status, 'feasible');
  assert.deepEqual(out.disabled, []);
  assert.deepEqual(out.retained, ['a']);
});

test('AuditDSU：闭合矛盾给出简单环，回滚后结构与森林完全复原', () => {
  const dsu = new AuditDSU(4);
  const r1 = dsu.union(0, 1, 'A', 'B', 1n, E('r1', 'A', 'B', 1, 1));
  assert.equal(r1.ok, true);
  const r2 = dsu.union(2, 3, 'C', 'D', 1n, E('r2', 'C', 'D', 1, 2));
  assert.equal(r2.ok, true);
  const r3 = dsu.union(0, 2, 'A', 'C', 10n, E('r3', 'A', 'C', 10, 3));
  assert.equal(r3.ok, true);

  const snap = dsu.snapshot();
  const r4 = dsu.union(1, 3, 'B', 'D', 7n, E('r4', 'B', 'D', 7, 4));
  assert.equal(r4.ok, false);
  assert.equal(r4.derived, 10n); // x_D - x_B = (x_C+1) - (x_A+1) = 10
  assert.equal(r4.conflict, 7n);
  assert.deepEqual(r4.ring.map((r) => r.edge.id), ['r1', 'r3', 'r2']);
  let s = 0n;
  for (const row of r4.ring) {
    s += row.contrib;
    assert.ok(row.contrib === row.edge.d || row.contrib === -row.edge.d);
  }
  assert.equal(s, 10n);

  // 相容冗余关系不改变结构
  const before = dsu.snapshot();
  const red = dsu.union(0, 1, 'A', 'B', 1n, E('rr', 'A', 'B', 1, 5));
  assert.equal(red.ok, true);
  assert.equal(red.redundant, true);
  assert.equal(dsu.snapshot(), before);

  // 回滚到闭合前：森林邻接恢复，势恢复
  dsu.rollback(snap);
  assert.equal(dsu.find(3).r, dsu.find(2).r);
  assert.equal(dsu.find(1).r, dsu.find(0).r);
  // r3 的合并仍在（snap 之后只发生过失败/冗余并入）
  assert.equal(dsu.find(0).r, dsu.find(3).r);
  dsu.rollback(0);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(dsu.find(i).r, i);
    assert.equal(dsu.find(i).w, 0n);
    assert.equal(dsu.adj[i].length, 0);
  }
});

// 朴素预言机：枚举全部子集，按“最少条数 + 标识升序”求最优停用集（仅测试用）
function bruteForce(activeEdges, stations) {
  const e = activeEdges.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const N = e.length;
  const idx = new Map(stations.map((s, i) => [s, i]));
  function feasible(kept) {
    const parent = stations.map((_, i) => i);
    const pot = new Array(stations.length).fill(0n);
    function find(x) {
      let r = x;
      let w = 0n;
      while (parent[r] !== r) { w += pot[r]; r = parent[r]; }
      return { r, w };
    }
    for (const k of kept) {
      const a = find(idx.get(k.u));
      const b = find(idx.get(k.v));
      if (a.r === b.r) {
        if (b.w - a.w !== k.d) return false;
      } else {
        parent[a.r] = b.r;
        pot[a.r] = b.w - a.w - k.d;
      }
    }
    return true;
  }
  let best = null;
  for (let m = 0; m < (1 << N); m += 1) {
    const kept = e.filter((_, i) => !(m & (1 << i)));
    if (!feasible(kept)) continue;
    const ids = [];
    for (let i = 0; i < N; i += 1) if (m & (1 << i)) ids.push(e[i].id);
    if (best === null ||
      ids.length < best.length ||
      (ids.length === best.length && JSON.stringify(ids) < JSON.stringify(best))) {
      best = ids;
    }
  }
  return best;
}

test('随机性质：审计结果与枚举全部子集的朴素预言机一致，且矛盾环为真实简单环', () => {
  let seed = 0xBADC0DE;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 800; trial += 1) {
    const n = 2 + Math.floor(rnd() * 4);
    const stations = Array.from({ length: n }, (_, i) => `S${i}`);
    const N = 2 + Math.floor(rnd() * 11);
    const edges = [];
    for (let i = 0; i < N; i += 1) {
      let u = Math.floor(rnd() * n);
      let v = Math.floor(rnd() * n);
      while (v === u) v = Math.floor(rnd() * n);
      edges.push(E(
        `e${String(i).padStart(2, '0')}`,
        stations[u], stations[v], Math.floor(rnd() * 11) - 5, i + 1,
      ));
    }

    const out = minDisableAudit(edges, stations);
    const want = bruteForce(edges, stations);
    if (want && want.length === 0) {
      assert.equal(out.status, 'feasible', `trial ${trial} 应为 feasible`);
      continue;
    }
    assert.equal(out.status, 'ok', `trial ${trial}`);
    assert.deepEqual(out.disabled, want, `trial ${trial} 停用集与预言机不符`);

    // 势值满足全部保留关系
    const w = new Map(out.potentials.map((p) => [p.name, p.w]));
    const off = new Set(out.disabled);
    for (const ed of edges) {
      if (off.has(ed.id)) continue;
      assert.equal(w.get(ed.v) - w.get(ed.u), ed.d, `trial ${trial} 势值不满足 ${ed.id}`);
    }

    // 每个命中的矛盾环：真实简单环、各项为 ±d、相加 = 推导值 ≠ 冲突值、
    // 环上关系全部列入分支候选
    for (const layer of out.layers) {
      for (const hit of layer.hits) {
        const ids = hit.ring.map((r) => r.id);
        assert.equal(new Set(ids).size, ids.length, `trial ${trial} 环有重复边`);
        let sum = 0n;
        for (const row of hit.ring) {
          assert.deepEqual(
            [row.plus, row.minus].sort(), [row.u, row.v].sort(),
            `trial ${trial} 环行端点错误`,
          );
          assert.ok(
            row.contrib === row.d || row.contrib === -row.d,
            `trial ${trial} 环项取值不是 ±d`,
          );
          assert.ok(hit.candidates.includes(row.id), `trial ${trial} 环边未列入候选`);
          sum += row.contrib;
        }
        assert.equal(sum, hit.derived, `trial ${trial} 环相加不等于推导值`);
        assert.notEqual(hit.derived, hit.conflict, `trial ${trial} 假矛盾环`);
        assert.ok(hit.candidates.includes(hit.closing.id));
      }
    }

    // 不枚举全部子集：实际评估数严格小于 2^N
    assert.ok(out.stats.evaluated < 2 ** N,
      `trial ${trial} evaluated=${out.stats.evaluated} 退化為全枚举`);
  }
});
