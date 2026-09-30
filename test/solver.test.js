/**
 * solver.test.js — 内核测试：时间区间分治 + 可回滚带势并查集
 * 运行：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { RollbackDSU, solveAudit, deriveAt } = require('../web/js/solver.js');
const { parseScript } = require('../web/js/parser.js');

function runScript(text) {
  const p = parseScript(text);
  if (!p.ok) throw new Error(`脚本解析失败: ${JSON.stringify(p.errors, null, 2)}`);
  const stats = {};
  const results = solveAudit(p.ops, p.stations, stats);
  return { p, results, stats };
}

test('登记 A→B=5、B→C=-2 后可行并可推导 A→C=3', () => {
  const { results, p } = runScript([
    'stations: A,B,C',
    'r1: A→B=5',
    'r2: B→C=-2',
    'checkpoint',
  ].join('\n'));
  assert.equal(results.length, 1);
  assert.equal(results[0].feasible, true);
  const d = deriveAt(results[0], p.stations, 'A', 'C');
  assert.equal(d.status, 'ok');
  assert.equal(d.value, 3n);
  // 对称性与传递性
  assert.equal(deriveAt(results[0], p.stations, 'C', 'A').value, -3n);
  assert.equal(deriveAt(results[0], p.stations, 'B', 'A').value, -5n);
  assert.equal(deriveAt(results[0], p.stations, 'B', 'C').value, -2n);
});

test('再登记 A→C=4 产生推导值 3 与冲突值 4 的矛盾环；撤回后恢复可行', () => {
  const script = [
    'stations: A,B,C',
    'r1: A→B=5',
    'r2: B→C=-2',
    'checkpoint', // 1 可行
    'r3: A→C=4',
    'checkpoint', // 2 冲突
    'withdraw r3',
    'checkpoint', // 3 恢复
  ].join('\n');
  const { results: rs, p: pp } = runScript(script);
  assert.equal(rs[0].feasible, true);
  assert.equal(rs[1].feasible, false);
  assert.equal(rs[2].feasible, true);

  const c = rs[1].conflict;
  assert.equal(c.id, 'r3');
  assert.equal(c.derived, 3n, '推导值应为 3');
  assert.equal(c.d, 4n, '冲突值应为 4');
  assert.equal(c.sum, 3n, '环上各项相加应等于推导值');
  // 环中逐项复算：r1 正向贡献 +5，r2 正向贡献 -2
  const byId = Object.fromEntries(c.ring.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['r1', 'r2']);
  assert.equal(byId.r1.contrib, 5n);
  assert.equal(byId.r2.contrib, -2n);
  // 每一项与其声明方向一致或显式标记反向，且正负端确实是该关系的两个端点
  for (const row of c.ring) {
    const ends = [row.plus, row.minus].sort();
    assert.deepEqual(ends, [row.u, row.v].sort());
  }
  // 撤回后 r3 不在活动集合
  assert.deepEqual(rs[2].activeIds, ['r1', 'r2']);
  assert.equal(deriveAt(rs[2], pp.stations, 'A', 'C').value, 3n);
});

test('撤回后可用同一标识重新登记，后续检查点采用新值', () => {
  const { results, p } = runScript([
    'stations: A,B',
    'e: A→B=1',
    'checkpoint',
    'withdraw e',
    'e: A→B=7',
    'checkpoint',
  ].join('\n'));
  assert.deepEqual(results.map((r) => r.feasible), [true, true]);
  assert.deepEqual(results[0].activeIds, ['e']);
  assert.equal(deriveAt(results[0], p.stations, 'A', 'B').value, 1n);
  assert.equal(deriveAt(results[1], p.stations, 'A', 'B').value, 7n);
});

test('矛盾环选择稳定：多个冲突时始终选关系标识最小者，环可逐项复算', () => {
  // 三角形先固定 A→B=1, B→C=1（推出 A→C=2）
  // 再登记 zbad A→C=5 与 abad A→C=9：两处冲突，应稳定选 abad
  const { results } = runScript([
    'stations: A,B,C',
    'ab: A→B=1',
    'bc: B→C=1',
    'zbad: A→C=5',
    'abad: A→C=9',
    'checkpoint',
  ].join('\n'));
  assert.equal(results[0].feasible, false);
  assert.equal(results[0].conflict.id, 'abad');
  assert.equal(results[0].conflict.derived, 2n);
  assert.equal(results[0].conflict.d, 9n);
});

test('同一脚本重复求解结论一致（树形态确定，无路径压缩副作用）', () => {
  const script = [
    'stations: A,B,C,D',
    'a: A→B=1', 'b: B→C=2', 'c: C→D=3', 'd: A→D=6',
    'checkpoint',
  ].join('\n');
  const p = parseScript(script);
  const r1 = solveAudit(p.ops, p.stations);
  const r2 = solveAudit(p.ops, p.stations);
  assert.deepEqual(JSON.stringify(r1, bigReplacer), JSON.stringify(r2, bigReplacer));
  assert.equal(r1[0].feasible, true); // 1+2+3=6，相容（冗余关系）
  assert.equal(r1[0].conflict, null);
  assert.equal(deriveAt(r1[0], p.stations, 'A', 'D').value, 6n);
});

test('不相容时跨检查点区间分治：中间区间冲突、首尾可行', () => {
  const { results } = runScript([
    'stations: A,B,C',
    'a: A→B=1',
    'b: B→C=1',
    'checkpoint',            // 1 可行
    'x: A→C=9',
    'checkpoint',            // 2 冲突
    'checkpoint',            // 3 仍冲突（关系持续活动）
    'withdraw x',
    'checkpoint',            // 4 恢复
  ].join('\n'));
  assert.deepEqual(results.map((r) => r.feasible), [true, false, false, true]);
  assert.equal(results[2].conflict.id, 'x');
});

test('并入次数随区间分治 O(E log K)，明显小于“每检查点重扫活动关系”', () => {
  // 100 个检查点；一条长期活动关系只应在约 log2(100) 个树节点并入
  const ops = ['stations: A,B', 'long: A→B=1'];
  for (let i = 0; i < 100; i += 1) ops.push('checkpoint');
  const { stats } = runScript(ops.join('\n'));
  assert.equal(stats.intervals, 1);
  // 朴素重扫需要 100 次并入；分治只需 <= 2*ceil(log2(100))+1 量级
  assert.ok(stats.unionCalls <= 16, `unionCalls=${stats.unionCalls}`);
  assert.ok(stats.unionCalls < 100);

  // 32 条关系各活动 1 个检查点（互不相同）：每条仅挂 1 个叶子
  const ops2 = ['stations: A,B'];
  for (let i = 0; i < 32; i += 1) {
    ops2.push(`e${i}: A→B=${i}`);
    ops2.push('checkpoint');
    ops2.push(`withdraw e${i}`);
  }
  const s2 = runScript(ops2.join('\n')).stats;
  assert.equal(s2.unionCalls, 32);
});

test('RollbackDSU 直接验证势与回滚：回滚后结构完全复原', () => {
  const dsu = new RollbackDSU(4);
  const E = (id) => ({ id, u: 'n0', v: 'n0' });
  let r = dsu.union(0, 1, 'A', 'B', 5n, { id: 'e1', u: 'A', v: 'B', d: 5n });
  assert.equal(r.ok, true);
  r = dsu.union(1, 2, 'B', 'C', -2n, { id: 'e2', u: 'B', v: 'C', d: -2n });
  assert.equal(r.ok, true);
  assert.equal(dsu.find(2).w - dsu.find(0).w, 3n);

  const snap = dsu.snapshot();
  r = dsu.union(0, 2, 'A', 'C', 4n, { id: 'e3', u: 'A', v: 'C', d: 4n });
  assert.equal(r.ok, false);
  assert.equal(r.derived, 3n);
  assert.equal(r.conflict, 4n);
  // 冗余但相容的关系不应改变结构
  const before = dsu.snapshot();
  const r2 = dsu.union(0, 2, 'A', 'C', 3n, { id: 'e4', u: 'A', v: 'C', d: 3n });
  assert.equal(r2.ok, true);
  assert.equal(r2.redundant, true);
  assert.equal(dsu.snapshot(), before);
  // 回滚到 e3 之前（e3 未改动，回滚为空操作也安全）
  dsu.rollback(snap);
  assert.equal(dsu.find(2).w - dsu.find(0).w, 3n);

  // 制造一次真正改变结构的合并再回滚
  const snap2 = dsu.snapshot();
  dsu.union(2, 3, 'C', 'D', 10n, { id: 'e5', u: 'C', v: 'D', d: 10n });
  assert.equal(dsu.find(3).w - dsu.find(0).w, 13n);
  dsu.rollback(snap2);
  assert.equal(dsu.find(3).r, 3);
  assert.equal(dsu.find(3).w, 0n);
});

test('推导查询：未活动端点与不同连通分量', () => {
  const { results, p } = runScript([
    'stations: A,B,C,D',
    'a: A→B=1',
    'c: C→D=2',
    'checkpoint',
  ].join('\n'));
  assert.equal(deriveAt(results[0], p.stations, 'A', 'C').status, 'disconnected');
  assert.equal(deriveAt(results[0], p.stations, 'X', 'A').status, 'unknown_endpoint');

  // 声明了但未被任何活动关系引用的站点读数未定
  const { results: r2, p: p2 } = runScript([
    'stations: A,B,C',
    'a: A→B=1',
    'checkpoint',
  ].join('\n'));
  assert.equal(deriveAt(r2[0], p2.stations, 'A', 'C').status, 'inactive_endpoint');
});

function bigReplacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}

// 朴素预言机：每个检查点用全新带势并查集重扫全部活动关系（仅测试中用于对照）
function naiveSolve(ops, stations) {
  const idx = new Map(stations.map((n, i) => [n, i]));
  const results = [];
  let cp = 0;
  const active = new Map(); // id -> edge
  for (const op of ops) {
    if (op.kind === 'reg') active.set(op.id, op);
    else if (op.kind === 'withdraw') active.delete(op.id);
    else {
      cp += 1;
      const dsu = new RollbackDSU(stations.length);
      let anyConflict = false;
      const activeMask = stations.map(() => false);
      for (const e of Array.from(active.values()).sort((a, b) => byLine(a, b))) {
        activeMask[idx.get(e.u)] = true;
        activeMask[idx.get(e.v)] = true;
        const r = dsu.union(idx.get(e.u), idx.get(e.v), e.u, e.v, e.d, e);
        if (!r.ok) anyConflict = true;
      }
      results.push({
        checkpoint: cp,
        feasible: !anyConflict,
        activeMask,
        pairs: stations.map((_, i) => stations.map((_, j) => {
          if (!activeMask[i] || !activeMask[j]) return undefined;
          const a = dsu.find(i);
          const b = dsu.find(j);
          return a.r === b.r ? b.w - a.w : null;
        })),
      });
    }
  }
  return results;
}
function byLine(a, b) { return a.line - b.line || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

// 独立验证矛盾环：环中各项相加 = 推导值 ≠ 冲突值，且每条边都在活动集合中
function verifyWitness(conflict, activeIdSet) {
  assert.ok(activeIdSet.has(conflict.id), '闭合关系必须处于活动状态');
  let sum = 0n;
  for (const row of conflict.ring) {
    assert.ok(activeIdSet.has(row.id), `环上关系 ${row.id} 必须活动`);
    const ends = [row.plus, row.minus].sort();
    assert.deepEqual(ends, [row.u, row.v].sort());
    sum += row.contrib;
  }
  assert.equal(sum, conflict.derived, '环各项相加应等于推导值');
  assert.notEqual(conflict.derived, conflict.d, '推导值必须与冲突值不同');
}

test('随机性质：分治求解与逐检查点重扫的朴素预言机结论一致，矛盾环为真实证据', () => {
  let seed = 0xC0FFEE;
  const rnd = () => {
    // 确定性 LCG，保证测试可复现
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let trial = 0; trial < 60; trial += 1) {
    const n = 2 + Math.floor(rnd() * 5);
    const stations = Array.from({ length: n }, (_, i) => `S${i}`);
    const ops = [];
    const activeIds = [];
    const reusable = [];
    let nextId = 0;
    let line = 0;
    const targetCheckpoints = 1 + Math.floor(rnd() * 12);
    let cps = 0;
    while (cps < targetCheckpoints) {
      line += 1;
      const roll = rnd();
      if (roll < 0.55) {
        let id;
        if (activeIds.length > 0 && rnd() < 0.25) {
          const k = Math.floor(rnd() * activeIds.length);
          id = activeIds.splice(k, 1)[0];
          reusable.push(id);
          ops.push({ kind: 'withdraw', id, line });
        } else {
          if (reusable.length > 0 && rnd() < 0.4) id = reusable.pop();
          else { nextId += 1; id = `e${nextId}`; }
          let u = Math.floor(rnd() * n);
          let v = Math.floor(rnd() * n);
          while (v === u) v = Math.floor(rnd() * n);
          const d = BigInt(Math.floor(rnd() * 21) - 10);
          activeIds.push(id);
          ops.push({ kind: 'reg', id, u: stations[u], v: stations[v], d, line });
        }
      } else {
        ops.push({ kind: 'checkpoint', line });
        cps += 1;
      }
    }

    const got = solveAudit(ops, stations);
    const got2 = solveAudit(ops, stations);
    const want = naiveSolve(ops, stations);
    assert.equal(got.length, want.length, `trial ${trial} 检查点数`);

    // 重放操作以取得每个检查点的活动标识集合
    const live = new Set();
    let cp = 0;
    for (const op of ops) {
      if (op.kind === 'reg') live.add(op.id);
      else if (op.kind === 'withdraw') live.delete(op.id);
      else {
        const k = cp;
        // 可行性与并入顺序无关，必须与朴素重扫一致
        assert.equal(got[k].feasible, want[k].feasible,
          `trial ${trial} cp${k + 1} feasible`);
        // 同输入重复求解必须完全确定（稳定选环）
        assert.deepEqual(
          JSON.stringify(got[k], bigReplacer),
          JSON.stringify(got2[k], bigReplacer),
          `trial ${trial} cp${k + 1} 结论不确定`
        );
        if (!want[k].feasible) {
          assert.ok(got[k].conflict, `trial ${trial} cp${k + 1} 应给出矛盾环`);
          verifyWitness(got[k].conflict, new Set(live));
        } else {
          for (let i = 0; i < n; i += 1) {
            for (let j = 0; j < n; j += 1) {
              const r = deriveAt(got[k], stations, stations[i], stations[j]);
              const w = want[k].pairs[i][j];
              if (w === undefined) assert.equal(r.status, 'inactive_endpoint');
              else if (w === null) assert.equal(r.status, 'disconnected');
              else {
                assert.equal(r.status, 'ok');
                assert.equal(r.value, w,
                  `trial ${trial} cp${k + 1} ${stations[i]}→${stations[j]}`);
              }
            }
          }
        }
        cp += 1;
      }
    }
  }
});
