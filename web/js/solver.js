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
   * 最小停用集审计受理的活动关系条数上限。
   */
  const MAX_MIN_AUDIT_ACTIVE = 18;

  /**
   * 重放操作序列，取第 checkpointNo 个检查点当时仍活动的关系列表。
   * 最小停用集审计以“当时活动的关系”为输入，撤回的关系不参与。
   */
  function liveEdgesAt(ops, checkpointNo) {
    const live = new Map();
    let cp = 0;
    for (const op of ops) {
      if (op.kind === 'reg') {
        live.set(op.id, { id: op.id, u: op.u, v: op.v, d: op.d, line: op.line });
      } else if (op.kind === 'withdraw') {
        live.delete(op.id);
      } else if (op.kind === 'checkpoint') {
        cp += 1;
        if (cp === checkpointNo) return Array.from(live.values());
      }
    }
    return [];
  }

  /**
   * 审计专用可回滚带势并查集。
   *
   * 势的维护与 RollbackDSU 相同（按大小合并、不做路径压缩、可快照回滚，
   * pot[x] = value(x) − value(parent[x])），另维护一棵只含“真正合并过两个
   * 分量的原始关系”的可回滚生成森林：闭合关系产生矛盾时，矛盾环取森林中
   * 两端点间的唯一简单路径，因此枚举到的是无重复边的真实边环，不会漏掉
   * 也不会重复任何登记关系。
   */
  class AuditDSU {
    constructor(n) {
      this.n = n;
      this.parent = Array.from({ length: n }, (_, i) => i);
      this.size = new Array(n).fill(1);
      this.pot = new Array(n).fill(0n);
      // 生成森林邻接表：adj[x] = [{to, edge, forward}]
      // forward=true 表示登记方向 x→to（x_to - x_x = d），false 反之。
      this.adj = Array.from({ length: n }, () => []);
      this.stack = []; // 回滚项：并查集挂根 或 仅森林加边（冗余相容时无加边）
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
     * 并入 x_v - x_u = d。
     * 成功 {ok:true, redundant?:true}；
     * 失败 {ok:false, derived, conflict, ring}，ring 为生成森林上 u→v 的
     * 简单路径（不含闭合关系本身），各行 contrib 沿路径 telescopes 成 derived。
     */
    union(iu, iv, u, v, d, edge) {
      const a = this.find(iu);
      const b = this.find(iv);

      if (a.r === b.r) {
        const derived = b.w - a.w;
        if (derived === d) return { ok: true, redundant: true };
        return { ok: false, derived, conflict: d, ring: this.treeRing(iu, iv) };
      }

      // 默认把 a 根挂到 b 根：pot[a.r] = value(a.r)-value(b.r) = b.w-a.w-d
      let child = a.r;
      let big = b.r;
      let delta = b.w - a.w - d;
      if (this.size[child] > this.size[big]) {
        child = b.r;
        big = a.r;
        delta = -delta;
      }

      this.stack.push({
        kind: 'merge',
        child,
        big,
        sizeBigWas: this.size[big],
        potWas: this.pot[child],
        // 本次仅向森林加入这一条新边，回滚时删两端邻接表末项
        edgeEnds: [iu, iv],
      });
      this.parent[child] = big;
      this.pot[child] = delta;
      this.size[big] += this.size[child];
      this.adj[iu].push({ to: iv, edge, forward: true });
      this.adj[iv].push({ to: iu, edge, forward: false });
      return { ok: true };
    }

    // 生成森林上 iu → iv 的唯一简单路径（两端在同一棵树内）
    treeRing(iu, iv) {
      const prev = new Array(this.n).fill(null);
      const seen = new Uint8Array(this.n);
      const queue = [iu];
      seen[iu] = 1;
      while (queue.length > 0) {
        const x = queue.shift();
        if (x === iv) break;
        for (const nx of this.adj[x]) {
          if (!seen[nx.to]) {
            seen[nx.to] = 1;
            prev[nx.to] = { from: x, link: nx };
            queue.push(nx.to);
          }
        }
      }

      // 自 iv 沿 prev 回溯到 iu；link 存于 adj[from]，forward 表示 from=e.u
      const back = [];
      for (let x = iv; x !== iu; x = prev[x].from) {
        const { link } = prev[x];
        const e = link.edge;
        if (link.forward) {
          back.push({ edge: e, plus: e.v, minus: e.u, contrib: e.d });
        } else {
          back.push({ edge: e, plus: e.u, minus: e.v, contrib: -e.d });
        }
      }
      return back.reverse();
    }

    rollback(snap) {
      while (this.stack.length > snap) {
        const h = this.stack.pop();
        this.parent[h.child] = h.child;
        this.pot[h.child] = h.potWas;
        this.size[h.big] = h.sizeBigWas;
        const [x, y] = h.edgeEnds;
        this.adj[x].pop();
        this.adj[y].pop();
      }
    }
  }

  /**
   * 把审计边环行（AuditDSU 产出）装饰成页面/测试统一的环行结构。
   */
  function decorateAuditRows(rows) {
    return rows.map((r) => ({
      id: r.edge.id,
      u: r.edge.u,
      v: r.edge.v,
      d: r.edge.d,
      line: r.edge.line,
      plus: r.plus,
      minus: r.minus,
      reversed: r.plus === r.edge.u, // 环方向 x_plus−x_minus 与登记 x_v−x_u 相反
      contrib: r.contrib,
    }));
  }

  /**
   * 最小停用集审计：在一个冲突检查点上，找出停用哪些“当时活动的关系”后，
   * 其余读数首次能够共同成立。
   *
   * 规则（不得按当前单个矛盾环直接删边、不得贪心、不得枚举全部子集）：
   *   - 状态 = 一个停用集合；其可行性由可回滚带势并查集按登记行号升序
   *     重建并入后判定，离开状态即 rollback 回空快照；
   *   - 状态矛盾时，待停用关系只能从“当前矛盾环（稳定取闭合关系标识最小者）”
   *     的环内关系中分支选择；
   *   - 逐层搜索（停用条数 k=1,2,…）：第 k 层只接受恰停用 k 条的可行状态，
   *     节点处命中矛盾环给出下界 depth+1，超过本层容量即剪枝；
   *   - 先保证停用条数最少；同层数的可行停用集按关系标识升序逐项比较，
   *     取整个集合字典序最小者；
   *   - 同一停用集只评估一次（位掩码记忆化），跨层复用。
   *
   * @param {Array} activeEdges 该检查点活动关系 {id,u,v,d(BigInt),line}
   * @param {string[]} stations 站点列表（编号即下标）
   * @returns {Object}
   *   {status:'ok', disabled, retained, potentials, solutionLevel, layers, stats}
   *   或 {status:'rejected', code:'too_many_active', activeCount, limit}
   *   或 {status:'feasible', ...}（检查点本就可行，无需审计）
   */
  function minDisableAudit(activeEdges, stations) {
    const n = activeEdges.length;
    if (n > MAX_MIN_AUDIT_ACTIVE) {
      return {
        status: 'rejected',
        code: 'too_many_active',
        activeCount: n,
        limit: MAX_MIN_AUDIT_ACTIVE,
      };
    }

    const edgesById = activeEdges.slice().sort(byIdAsc);
    const bitOf = new Map(edgesById.map((e, i) => [e.id, 1 << i]));
    const stationIndex = new Map(stations.map((name, i) => [name, i]));
    const lineOrder = edgesById.slice().sort(byLineAsc);
    const totalMasks = 1 << n;

    const idsOfMask = (mask) => {
      const ids = [];
      for (let i = 0; i < n; i += 1) if (mask & (1 << i)) ids.push(edgesById[i].id);
      return ids;
    };
    const popcount = (mask) => {
      let c = 0;
      while (mask) { c += 1; mask &= mask - 1; }
      return c;
    };
    // 等势停用集的字典序比较：第一个差异位上含较小标识者为小
    const maskLess = (a, b) => {
      const diff = a ^ b;
      if (diff === 0) return false;
      let low = 1;
      while ((diff & low) === 0) low <<= 1;
      return (a & low) !== 0;
    };

    // 所有状态共用一个可回滚带势并查集：快照 → 重建并入 → 读取 → 回滚。
    // 审计并查集在合并时展开真实边环，确保分支候选取自真实矛盾环（不能用
    // 既有检查点结论里被大小合并折叠过的单链接环直接删边）。
    const dsu = new AuditDSU(stations.length);
    const memo = new Array(totalMasks).fill(null);

    const layerHits = new Map(); // depth -> Map(sig -> hit)（同层同环只记一次）
    const layerFeasible = new Map(); // depth -> [mask]
    const stats = { evaluated: 0, branched: 0, pruned: 0, totalMasks };

    function recordHit(depth, hit, mask) {
      let bucket = layerHits.get(depth);
      if (!bucket) { bucket = new Map(); layerHits.set(depth, bucket); }
      if (!bucket.has(hit.sig)) {
        bucket.set(hit.sig, Object.assign({ viaDisabled: idsOfMask(mask) }, hit));
      }
    }

    function recordFeasible(depth, mask) {
      const arr = layerFeasible.get(depth) || [];
      arr.push(mask);
      layerFeasible.set(depth, arr);
    }

    function evaluate(mask) {
      if (memo[mask] !== null) return memo[mask];
      stats.evaluated += 1;
      const depth = popcount(mask);
      const snap = dsu.snapshot();
      const useCount = new Array(stations.length).fill(0);
      const clashes = [];

      for (const e of lineOrder) {
        if (mask & bitOf.get(e.id)) continue; // 该关系已停用
        useCount[stationIndex.get(e.u)] += 1;
        useCount[stationIndex.get(e.v)] += 1;
        const rr = dsu.union(
          stationIndex.get(e.u), stationIndex.get(e.v), e.u, e.v, e.d, e,
        );
        if (!rr.ok) {
          clashes.push({ edge: e, derived: rr.derived, ring: decorateAuditRows(rr.ring) });
        }
      }

      let desc;
      if (clashes.length === 0) {
        const potentials = [];
        for (let i = 0; i < stations.length; i += 1) {
          if (useCount[i] > 0) {
            const f = dsu.find(i);
            potentials.push({ name: stations[i], root: f.r, w: f.w });
          }
        }
        desc = { feasible: true, potentials };
        recordFeasible(depth, mask);
      } else {
        // 与既有检查点同一稳定规则：候选矛盾环中取闭合关系标识最小者
        const pick = clashes.slice().sort((a, b) => byIdAsc(a.edge, b.edge))[0];
        let sum = 0n;
        for (const row of pick.ring) sum += row.contrib;
        const idSet = new Set(pick.ring.map((r) => r.id));
        idSet.add(pick.edge.id); // 闭合关系本身也可被停用
        const candidates = Array.from(idSet).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        const sig = `${pick.edge.id}|${pick.ring.map((r) => r.id).sort().join(',')}`;

        // 更强的层下界：所有命中环都基于同一棵“只含相容关系”的生成森林，
        // 贪心挑出边互不相交的若干环——每个环至少要停用其环上一条边，
        // 不相交环所需停用边互不通用，故至少还要停用 packing 数条。
        const packed = [];
        const usedEdges = new Set();
        const ordered = clashes.slice().sort((a, b) => a.ring.length - b.ring.length);
        for (const cl of ordered) {
          const ids = cl.ring.map((r) => r.id).concat(cl.edge.id);
          if (ids.every((id) => !usedEdges.has(id))) {
            ids.forEach((id) => usedEdges.add(id));
            packed.push(ids);
          }
        }

        desc = {
          feasible: false,
          lowerAdd: Math.max(1, packed.length),
          hit: {
            sig,
            closing: {
              id: pick.edge.id, u: pick.edge.u, v: pick.edge.v,
              d: pick.edge.d, line: pick.edge.line,
            },
            derived: pick.derived,
            conflict: pick.edge.d,
            sum,
            ring: pick.ring,
            candidates,
          },
        };
        recordHit(depth, desc.hit, mask);
      }

      dsu.rollback(snap); // 后续状态用同一并查集重建，不留结构
      memo[mask] = desc;
      return desc;
    }

    const root = evaluate(0);
    if (root.feasible) {
      return {
        status: 'feasible',
        activeCount: n,
        limit: MAX_MIN_AUDIT_ACTIVE,
        disabled: [],
        retained: edgesById.map((e) => e.id),
        potentials: root.potentials,
      };
    }

    // 逐层穷尽：第 1 层、第 2 层……首次出现可行状态的层即最小停用条数
    let solutionLevel = 0;
    let bestMask = 0;
    for (let cap = 1; cap <= n; cap += 1) {
      const seen = new Set([0]);
      const dfs = (mask, depth) => {
        const desc = evaluate(mask);
        if (desc.feasible) return; // 浅层可行早应在更低位层找到并停止
        // 层下界：当前命中 packing 数个边互不相交矛盾环，至少还要再停用 lowerAdd 条
        if (depth + desc.lowerAdd > cap) {
          stats.pruned += 1;
          return;
        }
        // 只沿“当前矛盾环”的环内关系分支，按关系标识升序穷尽同层候选
        for (const id of desc.hit.candidates) {
          const child = mask | bitOf.get(id);
          if (seen.has(child)) continue; // 同一停用集（与分支顺序无关）只走一次
          seen.add(child);
          stats.branched += 1;
          dfs(child, depth + 1);
        }
      };
      dfs(0, 0);

      const solved = layerFeasible.get(cap);
      if (solved && solved.length > 0) {
        solutionLevel = cap;
        bestMask = solved.reduce((a, b) => (maskLess(a, b) ? a : b));
        break;
      }
    }

    const layers = [];
    for (let d = 0; d <= solutionLevel; d += 1) {
      layers.push({
        depth: d,
        hits: Array.from((layerHits.get(d) || new Map()).values())
          .map((h) => ({
            viaDisabled: h.viaDisabled,
            closing: h.closing,
            derived: h.derived,
            conflict: h.conflict,
            sum: h.sum,
            ring: h.ring,
            candidates: h.candidates,
          })),
        feasible: (layerFeasible.get(d) || []).map(idsOfMask),
      });
    }

    const retainedMask = ((1 << n) - 1) ^ bestMask;
    return {
      status: 'ok',
      activeCount: n,
      limit: MAX_MIN_AUDIT_ACTIVE,
      disabled: idsOfMask(bestMask),
      retained: idsOfMask(retainedMask),
      potentials: memo[bestMask].potentials,
      solutionLevel,
      layers,
      stats,
    };
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
    AuditDSU,
    solveAudit,
    deriveAt,
    minDisableAudit,
    liveEdgesAt,
    MAX_MIN_AUDIT_ACTIVE,
  };
});
