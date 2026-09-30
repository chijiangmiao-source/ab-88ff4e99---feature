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

  /** 最小停用集审计受理的活动关系条数上限。 */
  const MAX_AUDIT_ACTIVE = 18;

  function byIdAsc(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  function byLineAsc(a, b) {
    return a.line - b.line || byIdAsc(a, b);
  }

  /**
   * 环由 v→根（正向取）与 u→根（反向取）两条树路径拼成；
   * rowDir = 环中该项 x_(+) − x_(−) 的正负端点名，contrib 为其相加取值。
   */
  function decorateRing(vPath, uPath) {
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
    return decorate(vPath, 1).concat(decorate(uPath, -1));
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
    const activeEdges = new Map(); // id -> 当时活动的边对象（撤回后重用 id 也不会串）
    let candidates = []; // 根→当前叶路径上发现的全部矛盾，稳定取关系标识最小者

    const dfs = (node, l, r) => {
      const snap = dsu.snapshot();
      const applied = [];
      const foundHere = [];

      // 稳定规则：节点内按登记行号升序贪心并入（与脚本时间顺序一致），
      // 无法并入森林的闭合关系成为矛盾候选；叶节点在候选中取关系标识最小者。
      const edges = tree[node].slice().sort(byLineAsc);
      for (const e of edges) {
        activeIds.add(e.id);
        activeEdges.set(e.id, e);
        useCount[index.get(e.u)] += 1;
        useCount[index.get(e.v)] += 1;
        applied.push(e);
        if (stats) stats.unionCalls += 1;
        const rr = dsu.union(index.get(e.u), index.get(e.v), e.u, e.v, e.d, e);
        if (!rr.ok) {
          foundHere.push({
            edge: e,
            derived: rr.derived,
            ring: decorateRing(rr.vPath, rr.uPath),
          });
        }
      }
      const candLenBefore = candidates.length;
      candidates.push(...foundHere);

      if (l === r) {
        results[l - 1] = makeLeaf(l, dsu, stations, index, useCount, activeIds, activeEdges, candidates);
      } else {
        const mid = (l + r) >> 1;
        dfs(node << 1, l, mid);
        dfs(node << 1 | 1, mid + 1, r);
      }

      candidates.length = candLenBefore;
      for (const e of applied) {
        activeIds.delete(e.id);
        activeEdges.delete(e.id);
        useCount[index.get(e.u)] -= 1;
        useCount[index.get(e.v)] -= 1;
      }
      if (stats) stats.rollbackCalls += 1;
      dsu.rollback(snap);
    };

    function makeLeaf(no, dsu, stations, index, useCount, activeIds, activeEdges, candidates) {
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
        activeEdges: Array.from(activeEdges.values())
          .map((e) => ({ id: e.id, u: e.u, v: e.v, d: e.d, line: e.line })),
        potentials,
        conflict,
      };
    }

    dfs(1, 1, m);
    return results;
  }

  /**
   * 最小停用集审计：在一个已有（冲突的）检查点结论上，找出停用哪些“当时活动”
   * 的关系后，其余读数首次能够共同成立。
   *
   * 受理条件：检查点必须冲突，且活动关系不超过 MAX_AUDIT_ACTIVE(=18) 条。
   *
   * 求解方式（不是“按现有单个矛盾环直接删边”，不是贪心，也不枚举全部子集）：
   *   - 按停用条数分层（0,1,2,…）穷尽搜索；同层候选全部来自上一层状态命中
   *     的“当前矛盾环”分支：必须从该环（生成森林唯一路径 + 闭合边）中选
   *     一条停用，因为不破坏该环，矛盾就不可能消除；
   *   - 每个状态用可回滚带势并查集从干净快照按登记行号升序重建，命中首个
   *     矛盾环即停止；并同步维护一棵可回滚生成森林——DSU 按大小合并时一个
   *     link 的 pot 会累积多段偏移，真正首尾相接的环必须取生成森林中
   *     两端点的唯一路径，处理完按快照回滚供下一状态复用；
   *   - 按层下界剪枝：状态在第 d 条停用后仍命中矛盾环，则任何补全都至少
   *     还要再停用 1 条（d+1 起步），故首个出现可行集的层即最少停用条数，
   *     该层以下无需再展开；同层掩码去重；
   *   - 同层可行集按关系标识升序逐位比较，取字典序最小的整个停用集。
   *
   * @param {Object} result solveAudit 产出的某个检查点结论
   * @param {string[]} stations 站点列表（编号即下标）
   * @param {Array}  activeEdges 该检查点当时活动的关系（solveAudit 的边对象：
   *                     {id,u,v,d(BigInt),line}），顺序任意
   * @returns {Object}
   *   feasible 检查点：{status:'feasible'}
   *   超出受理上限：{status:'too_many_active', activeCount, limit}
   *   成功：{status:'ok', removed:[id...](按标识升序), kept:[edge...](按行号升序),
   *          potentials:[{name,root,w}], activeCount,
   *          layers:[{depth, nodes, feasible, pruned, carried,
   *                   hits:[{mask, removedIds, conflict:{id,derived,d,sum,ring}}]}]}
   */
  function auditCheckpoint(result, stations, activeEdges) {
    if (result.feasible) return { status: 'feasible' };
    const edges = activeEdges.slice().sort(byLineAsc);
    if (edges.length > MAX_AUDIT_ACTIVE) {
      return { status: 'too_many_active', activeCount: edges.length, limit: MAX_AUDIT_ACTIVE };
    }

    const index = new Map();
    stations.forEach((name, i) => index.set(name, i));
    const posById = new Map();
    edges.forEach((e, i) => posById.set(e.id, i));
    const n = edges.length;
    const dsu = new RollbackDSU(stations.length);

    // 可回滚生成森林：跨分量并入时在原始登记端点 u—v 间架一条树边。
    // adj[x] 条目 {to, dir, edge}：dir=+1 时 to 为 edge.v、x 为 edge.u
    // （沿登记方向，差为 edge.d）；dir=-1 为反向条目（差为 -edge.d）。
    const adj = Array.from({ length: stations.length }, () => []);
    const forestStack = [];

    const maskIds = (mask) => {
      const ids = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) ids.push(edges[i].id);
      return ids.sort();
    };
    // 整个停用集按关系标识升序逐位比较
    const cmpMask = (a, b) => {
      const xa = maskIds(a);
      const xb = maskIds(b);
      const k = Math.min(xa.length, xb.length);
      for (let i = 0; i < k; i += 1) {
        if (xa[i] < xb[i]) return -1;
        if (xa[i] > xb[i]) return 1;
      }
      return xa.length - xb.length;
    };
    const withSum = (conflict) => {
      let sum = 0n;
      for (const row of conflict.ring) sum += row.contrib;
      return Object.assign({}, conflict, { sum });
    };

    /**
     * 取生成森林中端点 iu→iv 的唯一路径，并转成矛盾环的相加行：
     * 每行给出环方向 x_plus − x_minus 与取值 contrib，逐行相加 = x_iv − x_iu。
     */
    const forestRing = (iu, iv) => {
      // 森林内 BFS 找父链（每棵分量是一棵树，路径唯一）
      const par = new Array(stations.length).fill(-1);
      const parEntry = new Array(stations.length).fill(null);
      par[iu] = iu;
      const queue = [iu];
      for (let qi = 0; qi < queue.length && par[iv] === -1; qi += 1) {
        const cur = queue[qi];
        for (const ent of adj[cur]) {
          if (par[ent.to] !== -1) continue;
          par[ent.to] = cur;
          parEntry[ent.to] = ent;
          queue.push(ent.to);
          if (ent.to === iv) break;
        }
      }
      const rows = [];
      let c = iv;
      while (c !== iu) {
        const ent = parEntry[c]; // cur(=par[c]) -> c
        if (ent.dir === 1) {
          rows.push({
            id: ent.edge.id, u: ent.edge.u, v: ent.edge.v, d: ent.edge.d,
            line: ent.edge.line, plus: ent.edge.v, minus: ent.edge.u,
            reversed: false, contrib: ent.edge.d,
          });
        } else {
          rows.push({
            id: ent.edge.id, u: ent.edge.u, v: ent.edge.v, d: ent.edge.d,
            line: ent.edge.line, plus: ent.edge.u, minus: ent.edge.v,
            reversed: true, contrib: -ent.edge.d,
          });
        }
        c = par[c];
      }
      rows.reverse(); // 从 iu 一路加到 iv
      return rows;
    };

    /**
     * 从干净快照按行序并入“未被掩码停用”的全部关系，命中首个矛盾环即停止。
     * DSU 与生成森林同步变化，由调用方按快照一起回滚。
     */
    const build = (mask) => {
      for (let pos = 0; pos < n; pos += 1) {
        if (mask & (1 << pos)) continue;
        const e = edges[pos];
        const iu = index.get(e.u);
        const iv = index.get(e.v);
        const rr = dsu.union(iu, iv, e.u, e.v, e.d, e);
        if (!rr.ok) {
          return {
            ok: false,
            conflict: withSum({
              id: e.id,
              u: e.u,
              v: e.v,
              d: e.d,
              line: e.line,
              derived: rr.derived,
              ring: forestRing(iu, iv),
            }),
          };
        }
        if (!rr.redundant) {
          // 真正连通了两个分量：登记边成为生成森林的一条树边
          adj[iu].push({ to: iv, dir: 1, edge: e });
          adj[iv].push({ to: iu, dir: -1, edge: e });
          forestStack.push({ iu, iv });
        }
      }
      return { ok: true };
    };

    const takeSnapshot = () => ({ dsu: dsu.snapshot(), forest: forestStack.length });
    const rollbackTo = (snap) => {
      dsu.rollback(snap.dsu);
      while (forestStack.length > snap.forest) {
        const h = forestStack.pop();
        adj[h.iu].pop();
        adj[h.iv].pop();
      }
    };

    const layers = [];
    let frontier = [0]; // 第 depth 层：恰好停用 depth 条的去重掩码
    let best = null;
    let depth = 0;

    while (frontier.length > 0 && best === null) {
      const layer = { depth, nodes: 0, feasible: 0, pruned: 0, carried: 0, hits: [] };
      const seen = new Set(); // 同层掩码去重
      const next = [];

      for (const mask of frontier) {
        const snap = takeSnapshot();
        const cur = build(mask);
        layer.nodes += 1;

        if (cur.ok) {
          layer.feasible += 1;
          if (best === null || cmpMask(mask, best) < 0) best = mask;
          rollbackTo(snap);
          continue;
        }

        // 从“当前矛盾环”分支：生成森林路径各边 + 闭合边本身，不破坏该环则矛盾不消。
        layer.hits.push({ mask, removedIds: maskIds(mask), conflict: cur.conflict });
        rollbackTo(snap); // 无论是否继续下探，本状态并入的边必须全部回滚
        if (best !== null) continue; // 本层已出现可行集：只需比完同层，不再下探
        const choiceSet = new Set(cur.conflict.ring.map((r) => r.id));
        choiceSet.add(cur.conflict.id);
        for (const id of choiceSet) {
          const child = mask | (1 << posById.get(id));
          // 同层去重；层下界：仍在环上的停用边只会产生 depth+1 层候选，
          // 不会在本层提前可行。
          if (seen.has(child)) { layer.pruned += 1; continue; }
          seen.add(child);
          next.push(child);
        }
      }

      layer.carried = next.length;
      layers.push(layer);
      // 首个出现可行集的层即最少停用条数：同层比较完后立即停止，下层不再展开。
      if (best !== null) break;
      frontier = next;
      depth += 1;
    }

    if (best === null) {
      // 理论上不可达：停用全部活动关系后空系统必然可行
      return { status: 'infeasible', activeCount: n };
    }

    // 最终保留关系的可行势值：按最优停用集用全新带势并查集重建
    const kept = [];
    for (let i = 0; i < n; i += 1) if (!(best & (1 << i))) kept.push(edges[i]);
    const finalDSU = new RollbackDSU(stations.length);
    const useCount = new Array(stations.length).fill(0);
    for (const e of kept) {
      finalDSU.union(index.get(e.u), index.get(e.v), e.u, e.v, e.d, e);
      useCount[index.get(e.u)] += 1;
      useCount[index.get(e.v)] += 1;
    }
    const potentials = [];
    for (let i = 0; i < stations.length; i += 1) {
      if (useCount[i] > 0) {
        const f = finalDSU.find(i);
        potentials.push({ name: stations[i], root: f.r, w: f.w });
      }
    }

    return {
      status: 'ok',
      removed: maskIds(best),
      kept: kept.map((e) => ({ id: e.id, u: e.u, v: e.v, d: e.d, line: e.line })),
      potentials,
      layers,
      activeCount: n,
    };
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
    auditCheckpoint,
    MAX_AUDIT_ACTIVE,
  };
});
