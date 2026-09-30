/* app.js — 校核台页面逻辑（无框架、无外部依赖） */
(function () {
  'use strict';

  const { parseScript } = window.DSParser;
  const { solveAudit, deriveAt, minDisableAudit, liveEdgesAt } = window.DSCable;

  const EXAMPLE = [
    'stations: A,B,C',
    'r1: A→B=5',
    'r2: B→C=-2',
    'checkpoint',
    'r3: A→C=4',
    'checkpoint',
    'withdraw r3',
    'checkpoint',
  ].join('\n');

  const $ = (sel) => document.querySelector(sel);
  const scriptEl = $('#script');
  const meterEl = $('#meter');
  const errorsEl = $('#errors');
  const resultsEl = $('#results');
  const emptyHintEl = $('#empty-hint');
  const staleNote = $('#stale-note');

  // {stations, ops, results}，脚本一旦改动即视为过期
  let lastAudit = null;
  // 最小停用集审计为“单例”：同一时刻只承认一个检查点上的审计。
  // auditSeq 为全局令牌：编辑脚本 / 重新校核 / 切换检查点都会使其自增，
  // 迟到（异步）的计算结果凭令牌比对后直接丢弃，绝不覆盖当前选择。
  let auditSeq = 0;
  let auditViews = new Map(); // checkpointNo -> 视图控制器

  function escapeText(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  function bigStr(x) {
    return x < 0n ? `−${(-x).toString()}` : x.toString();
  }

  function updateMeter() {
    const parsed = parseScript(scriptEl.value);
    const used = scriptEl.value
      .split(/\r\n?|\n/)
      .map((s) => s.trim())
      .filter((s) => s !== '' && !s.startsWith('#')).length;
    const stationCount = parsed.declared
      ? parsed.stations.length
      : [...new Set(parsed.stations)].length;
    meterEl.textContent = `已用 ${used} / 180 行 · 站点 ${stationCount} / 64`;
    meterEl.className = 'meter';
    if (used > 180 || stationCount > 64) meterEl.classList.add('bad');
    else if (used > 160 || stationCount > 56) meterEl.classList.add('warn');
  }

  /**
   * 使全部在途 / 已展示的最小停用集审计立即失效。
   * 编辑脚本与重新校核时调用；卡片 DOM 本身也会被清空/重建。
   */
  function invalidateAllAudits() {
    auditSeq += 1;
    auditViews = new Map();
  }

  function clearAudit(stale) {
    invalidateAllAudits();
    lastAudit = null;
    staleNote.hidden = !stale;
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    resultsEl.innerHTML = '';
    emptyHintEl.hidden = stale;
  }

  function renderErrors(errors) {
    errorsEl.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = `脚本存在 ${errors.length} 处问题，旧审计结果已清除：`;
    errorsEl.appendChild(h);
    const ul = document.createElement('ul');
    for (const e of errors) {
      const li = document.createElement('li');
      const ln = document.createElement('span');
      ln.className = 'ln';
      ln.textContent = `第 ${e.line} 行`;
      li.appendChild(ln);
      li.appendChild(document.createTextNode(e.message));
      if (e.token !== undefined) {
        const t = document.createElement('span');
        t.className = 'tok';
        t.textContent = `（“${e.token}”）`;
        li.appendChild(t);
      }
      ul.appendChild(li);
    }
    errorsEl.appendChild(ul);
    errorsEl.hidden = false;
  }

  function renderRing(conflict) {
    const wrap = document.createElement('div');
    const summary = document.createElement('p');
    summary.className = 'ring-summary';
    summary.innerHTML =
      `矛盾环（稳定选取标识最小者 <code>${escapeText(conflict.id)}</code>）：` +
      `环中各式相加推导 <code>x_${escapeText(conflict.v)} − x_${escapeText(conflict.u)}</code> = ` +
      `<span class="derived">${bigStr(conflict.derived)}</span>` +
      `，登记关系给出冲突值 <span class="conflict">${bigStr(conflict.d)}</span>` +
      `（逐项相加 ∑ = ${bigStr(conflict.sum)}）。`;
    wrap.appendChild(summary);

    const table = document.createElement('table');
    table.className = 'ring';
    table.innerHTML =
      '<thead><tr><th>关系标识</th><th>原始登记式</th><th>环中使用方向</th><th>本项取值</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const row of conflict.ring) {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      c1.textContent = row.id;
      const c2 = document.createElement('td');
      c2.textContent = `${row.u} → ${row.v} = ${bigStr(row.d)}`;
      const c3 = document.createElement('td');
      c3.textContent = `x_${row.plus} − x_${row.minus}${row.reversed ? '（反向使用）' : ''}`;
      const c4 = document.createElement('td');
      c4.textContent = bigStr(row.contrib);
      tr.append(c1, c2, c3, c4);
      tbody.appendChild(tr);
    }
    // 末行：触发矛盾的闭合关系本身（不参与相加，仅作对照）
    const trClash = document.createElement('tr');
    trClash.style.color = 'var(--bad)';
    const k1 = document.createElement('td');
    k1.textContent = conflict.id;
    const k2 = document.createElement('td');
    k2.textContent = `${conflict.u} → ${conflict.v} = ${bigStr(conflict.d)}（待校核）`;
    const k3 = document.createElement('td');
    k3.textContent = `x_${conflict.v} − x_${conflict.u}`;
    const k4 = document.createElement('td');
    k4.textContent = `${bigStr(conflict.derived)} ≠ ${bigStr(conflict.d)}`;
    trClash.append(k1, k2, k3, k4);
    tbody.appendChild(trClash);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function tag(id, cls) {
    const t = document.createElement('span');
    t.className = `tag${cls ? ` ${cls}` : ''}`;
    t.textContent = id;
    return t;
  }

  function tagLine(label, ids, cls) {
    const row = document.createElement('div');
    row.className = 'audit-tags';
    const name = document.createElement('span');
    name.className = 'audit-tags-name';
    name.textContent = label;
    row.appendChild(name);
    if (ids.length === 0) {
      const none = document.createElement('span');
      none.className = 'mini';
      none.textContent = '（无）';
      row.appendChild(none);
    } else {
      for (const id of ids) row.appendChild(tag(id, cls));
    }
    return row;
  }

  /**
   * 在冲突检查点卡片内安装“最小停用集审计”发起区与结果面板。
   * 返回视图控制器 {setRunning, reset, showRejected, showDone, destroy}。
   */
  function installAuditView(checkpointNo, activeCount, body) {
    const box = document.createElement('div');
    box.className = 'audit-box';

    const head = document.createElement('div');
    head.className = 'audit-head';
    const title = document.createElement('span');
    title.className = 'audit-title';
    title.textContent = `最小停用集审计（活动关系 ${activeCount} 条，上限 18 条）`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-audit';
    head.append(title, btn);
    box.appendChild(head);

    const note = document.createElement('p');
    note.className = 'mini audit-note';
    box.appendChild(note);

    const panel = document.createElement('div');
    panel.className = 'audit-panel';
    panel.hidden = true;
    box.appendChild(panel);
    body.appendChild(box);

    const overLimit = activeCount > 18;

    function reset() {
      btn.disabled = false;
      btn.textContent = '发起最小停用集审计';
      note.textContent = overLimit
        ? `本检查点有 ${activeCount} 条活动关系，超过 18 条受理上限：点击后审计将被明确拒绝。`
        : '沿当前矛盾环逐层分支搜索，最少化停用条数，同层穷尽候选后按标识升序决胜。';
      note.classList.toggle('bad', overLimit);
      panel.hidden = true;
      panel.innerHTML = '';
    }

    function setRunning() {
      btn.disabled = true;
      btn.textContent = '审计进行中…';
      note.textContent = '正在以可回滚带势并查集逐层重建状态并剪枝，请稍候。';
      note.classList.remove('bad');
      panel.hidden = true;
      panel.innerHTML = '';
    }

    function showRejected(out) {
      btn.disabled = false;
      btn.textContent = '重新发起审计';
      note.classList.add('bad');
      note.textContent =
        `审计被拒绝：本检查点有 ${out.activeCount} 条活动关系，` +
        `超过受理上限 ${out.limit} 条；未执行任何搜索，原结论保持不变。`;
      panel.innerHTML = '';
      panel.hidden = false;
      const p = document.createElement('p');
      p.className = 'audit-rejected';
      p.textContent =
        `拒绝受理（too_many_active）：活动关系 ${out.activeCount} 条 > 上限 ${out.limit} 条。`;
      panel.appendChild(p);
    }

    function showDone(out) {
      btn.disabled = false;
      btn.textContent = '重新发起审计';
      note.classList.remove('bad');
      note.textContent =
        `结论：最少停用 ${out.disabled.length} 条（第 ${out.solutionLevel} 层首次可行），` +
        `停用集在同层候选中按关系标识升序决胜；原脚本与原检查点结论均未改写。`;
      panel.innerHTML = '';
      panel.hidden = false;
      panel.appendChild(renderAuditResult(out));
    }

    const view = { checkpointNo, setRunning, reset, showRejected, showDone, box };
    btn.addEventListener('click', () => startAudit(checkpointNo));
    reset();
    return view;
  }

  function renderPotentialsTable(out, stations) {
    const wrap = document.createElement('div');
    const cap = document.createElement('p');
    cap.className = 'audit-sub';
    cap.textContent = '最终保留关系的一组可行势值（w = 该站读数 − 所在分量根读数；整体平移任意常数仍为解）：';
    wrap.appendChild(cap);

    const table = document.createElement('table');
    table.className = 'ring potentials';
    table.innerHTML =
      '<thead><tr><th>站点</th><th>所在分量根</th><th>可行势值 w</th></tr></thead>';
    const tbody = document.createElement('tbody');
    // 按分量分组、分量内按站点名展示，根站点势值恒为 0
    const rows = out.potentials.slice().sort((a, b) =>
      (a.root - b.root) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const p of rows) {
      const tr = document.createElement('tr');
      const c1 = document.createElement('td');
      c1.textContent = p.name;
      const c2 = document.createElement('td');
      c2.textContent = stations[p.root];
      const c3 = document.createElement('td');
      c3.textContent = bigStr(p.w);
      tr.append(c1, c2, c3);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function sameIdSet(a, b) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }

  function renderAuditResult(out) {
    const frag = document.createElement('div');

    frag.appendChild(tagLine('停用关系：', out.disabled, 'bad'));
    frag.appendChild(tagLine('保留关系：', out.retained, 'ok'));
    frag.appendChild(renderPotentialsTable(out, lastAudit.stations));

    const layersTitle = document.createElement('p');
    layersTitle.className = 'audit-sub';
    layersTitle.textContent = '各层搜索命中的矛盾环：';
    frag.appendChild(layersTitle);

    for (const layer of out.layers) {
      const sec = document.createElement('div');
      sec.className = 'audit-layer';
      const h = document.createElement('p');
      h.className = 'audit-layer-head';
      h.textContent = `第 ${layer.depth} 层（路径上已停用 ${layer.depth} 条）`;
      sec.appendChild(h);

      if (layer.hits.length === 0 && layer.feasible.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'mini';
        empty.textContent = '（无状态）';
        sec.appendChild(empty);
      }

      layer.hits.forEach((hit, i) => {
        const via = document.createElement('p');
        via.className = 'mini audit-via';
        const prefix = document.createElement('span');
        prefix.textContent =
          `命中 ${i + 1}/${layer.hits.length}：经停用 [${hit.viaDisabled.join(', ') || '无'}] ` +
          '后仍成矛盾环';
        via.appendChild(prefix);
        sec.appendChild(via);
        sec.appendChild(renderRing({
          id: hit.closing.id,
          u: hit.closing.u,
          v: hit.closing.v,
          d: hit.closing.d,
          derived: hit.derived,
          sum: hit.sum,
          ring: hit.ring,
        }));
        const cand = document.createElement('p');
        cand.className = 'mini audit-cands';
        cand.textContent = '本环待停用分支候选（按标识升序穷尽）：';
        for (const id of hit.candidates) cand.appendChild(tag(id));
        sec.appendChild(cand);
      });

      if (layer.feasible.length > 0) {
        const f = document.createElement('p');
        f.className = 'mini audit-feasible';
        f.textContent = `本层可行停用集 ${layer.feasible.length} 个：`;
        sec.appendChild(f);
        for (const set of layer.feasible) {
          const chosen = sameIdSet(set, out.disabled);
          const row = document.createElement('p');
          row.className = 'mini audit-feasible-set';
          const mark = document.createElement('span');
          mark.className = chosen ? 'tag ok' : 'tag';
          mark.textContent = chosen ? '选定' : '候选';
          row.appendChild(mark);
          row.appendChild(document.createTextNode(` {${set.join(', ') || '空集'}}`));
          sec.appendChild(row);
        }
      }
      frag.appendChild(sec);
    }

    const s = out.stats;
    const foot = document.createElement('p');
    foot.className = 'mini audit-stats';
    foot.textContent =
      `搜索统计：共 ${s.totalMasks} 个候选停用集，实际重建评估 ${s.evaluated} 个` +
      `（沿矛盾环分支 ${s.branched} 次，按层下界剪枝 ${s.pruned} 次），未枚举全部子集。`;
    frag.appendChild(foot);
    return frag;
  }

  async function startAudit(checkpointNo) {
    if (!lastAudit) return;
    const view = auditViews.get(checkpointNo);
    if (!view) return;

    // 切换检查点：先使其它检查点上的旧审计立即失效并复位
    for (const [cp, other] of auditViews.entries()) {
      if (cp !== checkpointNo) other.reset();
    }
    const token = ++auditSeq;
    view.setRunning();

    // 让出一轮事件循环：编辑脚本 / 重新校核 / 再次切换可立即作废本次计算；
    // 计算返回后令牌不匹配即丢弃，迟到结果不会覆盖当前选择。
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (token !== auditSeq || !lastAudit) return;

    const edges = liveEdgesAt(lastAudit.ops, checkpointNo);
    const out = minDisableAudit(edges, lastAudit.stations);

    if (token !== auditSeq || !lastAudit) return; // 迟到结果，丢弃
    if (out.status === 'rejected') view.showRejected(out);
    else if (out.status === 'feasible') view.reset();
    else view.showDone(out);
  }

  function renderResult(result, stations) {
    const tpl = document.getElementById('tpl-result');
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.cp = String(result.checkpoint);
    node.querySelector('.cp-title').textContent = `检查点 ${result.checkpoint}`;
    const badge = node.querySelector('.badge');
    badge.textContent = result.feasible ? '可行' : '冲突';
    badge.classList.add(result.feasible ? 'ok' : 'bad');

    const body = node.querySelector('.card-body');

    // 推导查询：x_b - x_a
    const box = document.createElement('div');
    box.className = 'derive-box';
    box.innerHTML =
      '<span>推导</span><input class="da" placeholder="A" /> <span>→</span> ' +
      '<input class="db" placeholder="C" /> <button type="button">计算</button> ' +
      '<span class="derive-answer"></span>';
    const answer = box.querySelector('.derive-answer');
    box.querySelector('button').addEventListener('click', () => {
      const a = box.querySelector('.da').value.trim();
      const b = box.querySelector('.db').value.trim();
      answer.classList.remove('bad');
      if (!a || !b) {
        answer.textContent = '请填写两个端点';
        answer.classList.add('bad');
        return;
      }
      const r = deriveAt(result, stations, a, b);
      if (r.status === 'ok') answer.textContent = `x_${b} − x_${a} = ${bigStr(r.value)}`;
      else if (r.status === 'unknown_endpoint') {
        answer.textContent = `未知端点 ${r.which}`;
        answer.classList.add('bad');
      } else if (r.status === 'inactive_endpoint') {
        answer.textContent = `${r.which} 在本检查点没有活动关系，读数未定`;
        answer.classList.add('bad');
      } else {
        answer.textContent = `${a} 与 ${b} 分属不同连通分量，无法共同推导`;
        answer.classList.add('bad');
      }
    });
    body.appendChild(box);

    if (result.conflict) body.appendChild(renderRing(result.conflict));
    else {
      const p = document.createElement('p');
      p.className = 'mini';
      p.textContent = '当前全部活动读数可共同成立（方程组相容）。';
      body.appendChild(p);
    }

    const tags = document.createElement('div');
    tags.className = 'active-tags';
    tags.textContent = '活动关系：';
    for (const id of result.activeIds) tags.appendChild(tag(id));
    body.appendChild(tags);

    // 仅冲突检查点可发起最小停用集审计；原检查点结论不被改写
    if (!result.feasible) {
      const view = installAuditView(result.checkpoint, result.activeIds.length, body);
      auditViews.set(result.checkpoint, view);
    }

    return node;
  }

  function run() {
    const parsed = parseScript(scriptEl.value);
    if (!parsed.ok) {
      // 一次定位全部问题，并清除旧审计结果
      clearAudit(false);
      emptyHintEl.hidden = true;
      renderErrors(parsed.errors);
      updateMeter();
      return;
    }

    const results = solveAudit(parsed.ops, parsed.stations);
    invalidateAllAudits(); // 重新校核：旧审计立即失效
    lastAudit = { stations: parsed.stations, ops: parsed.ops, results };
    staleNote.hidden = true;
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    resultsEl.innerHTML = '';

    if (results.length === 0) {
      emptyHintEl.hidden = false;
      emptyHintEl.textContent = '脚本有效，但其中没有任何 checkpoint。';
      updateMeter();
      return;
    }
    emptyHintEl.hidden = true;
    for (const r of results) resultsEl.appendChild(renderResult(r, parsed.stations));
    updateMeter();
  }

  $('#btn-run').addEventListener('click', run);
  $('#btn-example').addEventListener('click', () => {
    scriptEl.value = EXAMPLE;
    clearAudit(false);
    updateMeter();
  });
  scriptEl.addEventListener('input', () => {
    if (lastAudit || !errorsEl.hidden) clearAudit(true);
    updateMeter();
  });

  scriptEl.value = EXAMPLE;
  clearAudit(false);
  updateMeter();

  // 测试 / 一次性验收钩子：以“页面操作”的同一入口驱动页面
  window.__CABLE_APP__ = {
    run,
    startAudit,
    example: () => { scriptEl.value = EXAMPLE; clearAudit(false); updateMeter(); },
    setScript(text) {
      scriptEl.value = text;
      clearAudit(true);
      updateMeter();
    },
    editScript(text) {
      scriptEl.value = text;
      scriptEl.dispatchEvent(new window.Event('input'));
    },
    state: () => ({
      seq: auditSeq,
      checkpointCount: auditViews.size,
      auditCheckpoints: Array.from(auditViews.keys()),
      hasLastAudit: lastAudit !== null,
    }),
  };
})();
