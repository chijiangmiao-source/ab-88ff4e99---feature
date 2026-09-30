/*
 * solver.js — 深海观测缆偏移关系校核内核
 *
 * 关系形如 x_v - x_u = d（登记为 u→v=d）。
 *
 * 处理方式（不得为每个检查点重扫全部活动关系）：
 *   1. 每条关系的“登记—撤回”生命周期换算成它在检查点时间轴上的活动区间 [l,r]；
 *   2. 区间挂到检查点线段树的 O(log K) 个节点上（时间区间分治）；
 *   3. DFS 线段树，进入节点时把关系并入“可回滚带势并查集”，离开时按快照回滚。
 *      并查集只按大小合并不做路径压缩，pot[x] = x 的读数 - 父节点读数，
 *      回滚即恢复 parent/size/pot/link，总复杂度 O((E+K) log K · α)。
 *   4. 合并已连通的两端时若 pot 推出的偏移与登记值不符，即得到一个矛盾环。
 *
 * 同一份文件既可作为浏览器普通脚本（window.DSCable），也可在 Node 中被测试引用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSCable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 可回滚带势并查集。
   * 不变量：对任意非根节点 x，pot[x] = value(x) - value(parent[x])。
   * find 不做路径压缩，返回 {r, w}，w = value(x) - value(r)。
   */
  class RollbackDSU {
    constructor(n) {
      this.n = n;
      this.parent = Array.from({ length: n }, (_, i) => i);
      this.size = new Array(n).fill(1);
      this.pot = new Array(n).fill(0n);
      // link[x] 仅在 x 被挂到别的根之下时有效：
      // { edge, childAnchor, parentAnchor } 分别是关系对象和关系两端中
      // 落在“子树根侧 / 父树根侧”的端点名。
      this.link = new Array(n).fill(null);
      this.stack = [];
    }

    find(x) {
      let r = x;
      let w = 0n;
      while (this.parent[r] !== r) {
        w += this.pot[r];
        r = this.parent[r];
      }
      return { r, w };
    }

    snapshot() {
      return this.stack.length;
    }

    /**
     * 并入关系 x_v - x_u = d（端点编号 iu/iv，端点名 u/v）。
     * 成功：{ok:true, redundant?:true}（redundant 表示关系早已被蕴含，未改动结构）。
     * 失败：{ok:false, derived, conflict, vPath, uPath}
     *   derived = 并查集沿当前树推出的 x_v-x_u；conflict = d；
     *   vPath/uPath 为推出 derived 的两条树路径（v→根、u→根）。
     */
    union(iu, iv, u, v, d, edge) {
      const a = this.find(iu); // value(u) = value(a.r) + a.w
      const b = this.find(iv); // value(v) = value(b.r) + b.w

      if (a.r === b.r) {
        const derived = b.w - a.w; // x_v - x_u
        if (derived === d) return { ok: true, redundant: true };
        return {
          ok: false,
          derived,
          conflict: d,
          vPath: this._path(iv),
          uPath: this._path(iu),
        };
      }

      // 默认把 a 根挂到 b 根之下：
      // value(u)=value(a)+a.w, value(v)=value(b)+b.w，且 value(v)-value(u)=d
      // ⇒ pot[a] = value(a)-value(b) = b.w - a.w - d
      let child = a.r;
      let big = b.r;
      let delta = b.w - a.w - d;
      let childAnchor = u;
      let parentAnchor = v;
      if (this.size[child] > this.size[big]) {
        // 改为把 b 挂到 a 下，势与锚点全部反号
        child = b.r;
        big = a.r;
        delta = -delta;
        childAnchor = v;
        parentAnchor = u;
      }

      this.stack.push({
        child,
        big,
        sizeBigWas: this.size[big],
        potWas: this.pot[child],
        linkWas: this.link[child],
      });
      this.parent[child] = big;
      this.pot[child] = delta;
      this.size[big] += this.size[child];
      this.link[child] = { edge, childAnchor, parentAnchor };
      return { ok: true };
    }

    _path(x) {
      const rows = [];
      let c = x;
      while (this.parent[c] !== c) {
        const lk = this.link[c];
        rows.push({
          edge: lk.edge,
          value: this.pot[c], // value(child) - value(parent)
          childAnchor: lk.childAnchor,
          parentAnchor: lk.parentAnchor,
        });
        c = this.parent[c];
      }
      return rows;
    }

    rollback(snap) {
      while (this.stack.length > snap) {
        const h = this.stack.pop();
        this.parent[h.child] = h.child;
        this.pot[h.child] = h.potWas;
        this.link[h.child] = h.linkWas;
        this.size[h.big] = h.sizeBigWas;
      }
    }
  }

  function byIdAsc(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function byLineAsc(a, b) {
    return a.line - b.line || byIdAsc(a, b);
  }

  /**
   * 离线求解全部检查点。
   *
   * @param {Array} ops 已通过语法/语义校验的操作序列：
   *   {kind:'reg', id, u, v, d(BigInt), line}
   *   {kind:'withdraw', id, line}
   *   {kind:'checkpoint', line}
   * @param {string[]} stations 全部合法站点名（声明或隐式出现），编号即下标
   * @param {Object|null} stats 可选统计：{unionCalls, rollbackCalls, intervals} 由函数填充，
   *   用于证明并入次数随区间分治为 O(E log K) 而非 O(E·K)
   * @returns {Array<Object>} 每个检查点一个结论，顺序对应检查点出现次序
   */
  function solveAudit(ops, stations, stats) {
    if (stats) {
      stats.unionCalls = 0;
      stats.rollbackCalls = 0;
      stats.intervals = 0;
    }
    const index = new Map();
    stations.forEach((name, i) => index.set(name, i));

    // 1. 统计检查点数量，并把每条登记关系换算为活动检查点区间
    let m = 0;
    for (const op of ops) if (op.kind === 'checkpoint') m += 1;

    const intervals = [];
    const live = new Map(); // id -> edge（当前仍活动的那次登记）
    let cp = 0; // 已经过的检查点数（时间轴游标）
    for (const op of ops) {
      if (op.kind === 'reg') {
        const edge = {
          id: op.id,
          u: op.u,
          v: op.v,
          d: op.d,
          line: op.line,
          start: cp + 1, // 只对“未来”的检查点生效（1-based）
        };
        live.set(op.id, edge);
      } else if (op.kind === 'withdraw') {
        const edge = live.get(op.id);
        edge.end = cp; // 撤回操作之前出现过的检查点仍包含该关系
        intervals.push(edge);
        live.delete(op.id);
      } else if (op.kind === 'checkpoint') {
        cp += 1;
      }
    }
    for (const edge of live.values()) {
      edge.end = m;
      intervals.push(edge);
    }
    if (stats) stats.intervals = intervals.length;

    const results = new Array(m);
    if (m === 0) return results;

    // 2. 区间挂线段树
    const tree = Array.from({ length: 4 * m + 4 }, () => []);
    const add = (node, l, r, ql, qr, edge) => {
      if (ql <= l && r <= qr) {
        tree[node].push(edge);
        return;
      }
      const mid = (l + r) >> 1;
      if (ql <= mid) add(node << 1, l, mid, ql, qr, edge);
      if (qr > mid) add(node << 1 | 1, mid + 1, r, ql, qr, edge);
    };
    for (const e of intervals) {
      if (e.start <= e.end) add(1, 1, m, e.start, e.end, e);
    }

    // 3. 时间分治 DFS + 可回滚带势并查集
    const dsu = new RollbackDSU(stations.length);
    const useCount = new Array(stations.length).fill(0);
    const activeIds = new Set();
    let candidates = []; // 根→当前叶路径上发现的全部矛盾，稳定取关系标识最小者

    // 环由 v→根（正向取）与 u→根（反向取）两条树路径拼成；
    // rowDir = 环中该项 x_(+) − x_(−) 的正负端点名，contrib 为其相加取值。
    const decorate = (path, sign) =>
      path.map((p) => ({
        id: p.edge.id,
        u: p.edge.u,
        v: p.edge.v,
        d: p.edge.d,
        line: p.edge.line,
        plus: sign === 1 ? p.childAnchor : p.parentAnchor,
        minus: sign === 1 ? p.parentAnchor : p.childAnchor,
        // 环方向 x_plus−x_minus 是否与登记方向 x_v−x_u 相反
        reversed: sign === 1
          ? p.childAnchor === p.edge.u
          : p.childAnchor === p.edge.v,
        contrib: sign === 1 ? p.value : -p.value,
      }));

    const dfs = (node, l, r) => {
      const snap = dsu.snapshot();
      const applied = [];
      const foundHere = [];

      // 稳定规则：节点内按登记行号升序贪心并入（与脚本时间顺序一致），
      // 无法并入森林的闭合关系成为矛盾候选；叶节点在候选中取关系标识最小者。
      const edges = tree[node].slice().sort(byLineAsc);
      for (const e of edges) {
        activeIds.add(e.id);
        useCount[index.get(e.u)] += 1;
        useCount[index.get(e.v)] += 1;
        applied.push(e);
        if (stats) stats.unionCalls += 1;
        const rr = dsu.union(index.get(e.u), index.get(e.v), e.u, e.v, e.d, e);
        if (!rr.ok) {
          foundHere.push({
            edge: e,
            derived: rr.derived,
            ring: decorate(rr.vPath, 1).concat(decorate(rr.uPath, -1)),
          });
        }
      }
      const candLenBefore = candidates.length;
      candidates.push(...foundHere);

      if (l === r) {
        results[l - 1] = makeLeaf(l, dsu, stations, index, useCount, activeIds, candidates);
      } else {
        const mid = (l + r) >> 1;
        dfs(node << 1, l, mid);
        dfs(node << 1 | 1, mid + 1, r);
      }

      candidates.length = candLenBefore;
      for (const e of applied) {
        activeIds.delete(e.id);
        useCount[index.get(e.u)] -= 1;
        useCount[index.get(e.v)] -= 1;
      }
      if (stats) stats.rollbackCalls += 1;
      dsu.rollback(snap);
    };

    function makeLeaf(no, dsu, stations, index, useCount, activeIds, candidates) {
      const potentials = [];
      for (let i = 0; i < stations.length; i += 1) {
        if (useCount[i] > 0) {
          const f = dsu.find(i);
          potentials.push({ name: stations[i], root: f.r, w: f.w });
        }
      }
      let conflict = null;
      if (candidates.length > 0) {
        // 稳定选择：关系标识字典序最小的矛盾环
        const pick = candidates.slice().sort((a, b) => byIdAsc(a.edge, b.edge))[0];
        let sum = 0n;
        for (const row of pick.ring) sum += row.contrib;
        conflict = {
          id: pick.edge.id,
          u: pick.edge.u,
          v: pick.edge.v,
          d: pick.edge.d,
          line: pick.edge.line,
          derived: pick.derived,
          sum,
          ring: pick.ring,
        };
      }
      return {
        checkpoint: no,
        feasible: conflict === null,
        activeIds: Array.from(activeIds).sort(),
        potentials,
        conflict,
      };
    }

    dfs(1, 1, m);
    return results;
  }

  /**
   * 在某个检查点结论上推导 x_b - x_a。
   * 返回 {status:'ok', value(BigInt)} |
   *      {status:'unknown_endpoint', which} |
   *      {status:'inactive_endpoint', which} |
   *      {status:'disconnected'}
   */
  function deriveAt(result, stations, a, b) {
    const at = new Map(stations.map((n, i) => [n, i]));
    if (!at.has(a)) return { status: 'unknown_endpoint', which: a };
    if (!at.has(b)) return { status: 'unknown_endpoint', which: b };
    const pa = result.potentials.find((p) => p.name === a);
    const pb = result.potentials.find((p) => p.name === b);
    if (!pa) return { status: 'inactive_endpoint', which: a };
    if (!pb) return { status: 'inactive_endpoint', which: b };
    if (pa.root !== pb.root) return { status: 'disconnected' };
    return { status: 'ok', value: pb.w - pa.w };
  }

  return {
    RollbackDSU,
    solveAudit,
    deriveAt,
  };
});
