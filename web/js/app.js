/* app.js — 校核台页面逻辑（无框架、无外部依赖） */
(function () {
  'use strict';

  const { parseScript } = window.DSParser;
  const { solveAudit, deriveAt, auditCheckpoint, MAX_AUDIT_ACTIVE } = window.DSCable;
  const { createAuditRunner } = window.DSAuditRunner;

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

  let lastAudit = null; // {stations, results}，脚本一旦改动即视为过期

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

  /* ============ 最小停用集审计的页面渲染 ============ */

  // 检查点编号 -> {card, panelHost, result, stations}，用于切换检查点时立即使旧审计失效
  const auditSlots = new Map();

  const auditRunner = createAuditRunner(
    // compute：让出一帧再计算，使“在途切换 / 编辑”真实可发生，迟到结果由令牌门控丢弃
    (payload) => new Promise((resolve) => {
      setTimeout(() => {
        resolve(auditCheckpoint(payload.result, payload.stations, payload.result.activeEdges));
      }, 0);
    }),
    {
      onBegin: (key) => {
        const slot = auditSlots.get(key);
        if (slot) showAuditPending(slot);
      },
      onResolve: (key, audit) => {
        const slot = auditSlots.get(key);
        if (slot) renderAuditResult(slot, audit);
      },
      onStale: () => { /* 旧审计已失效：面板在切换 / 失效时即被移除，迟到结果丢弃 */ },
    }
  );

  /** 使全部在途 / 已展示的审计立即失效（编辑脚本、重新校核、载入示例）。 */
  function invalidateAudits() {
    auditRunner.invalidate();
    for (const slot of auditSlots.values()) {
      slot.panelHost.innerHTML = '';
      const btn = slot.card.querySelector('.audit-btn');
      if (btn) btn.disabled = false;
    }
    auditSlots.clear();
  }

  function makeAuditBox(modifier) {
    const box = document.createElement('div');
    box.className = `audit-box${modifier ? ` ${modifier}` : ''}`;
    return box;
  }

  function showAuditPending(slot) {
    // 切换检查点：先移除其他检查点上的旧审计面板——旧审计立即失效
    for (const [otherKey, other] of auditSlots) {
      if (otherKey !== slot.result.checkpoint) {
        other.panelHost.innerHTML = '';
        const ob = other.card.querySelector('.audit-btn');
        if (ob) ob.disabled = false;
      }
    }
    const btn = slot.card.querySelector('.audit-btn');
    if (btn) btn.disabled = true;

    slot.panelHost.innerHTML = '';
    const box = makeAuditBox('pending');
    const head = document.createElement('div');
    head.className = 'audit-head';
    const title = document.createElement('span');
    title.className = 'audit-title spinner';
    title.textContent = `正在对检查点 ${slot.result.checkpoint} 执行最小停用集审计`;
    head.appendChild(title);
    box.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'audit-sub';
    sub.textContent = '分层穷尽当前矛盾环分支，并用可回滚带势并查集重建各状态……';
    box.appendChild(sub);
    slot.panelHost.appendChild(box);
  }

  function showAuditRefused(slot, audit) {
    const btn = slot.card.querySelector('.audit-btn');
    if (btn) btn.disabled = false;
    slot.panelHost.innerHTML = '';
    const box = makeAuditBox('refused');
    const head = document.createElement('div');
    head.className = 'audit-head';
    const title = document.createElement('span');
    title.className = 'audit-title';
    title.textContent = '审计被明确拒绝';
    head.appendChild(title);
    box.appendChild(head);
    const sub = document.createElement('div');
    sub.className = 'audit-sub';
    sub.textContent =
      `该检查点当时有 ${audit.activeCount} 条活动关系，超过最小停用集审计受理上限 ` +
      `${audit.limit} 条（仅受理活动关系不超过 ${audit.limit} 条的冲突检查点）。`;
    box.appendChild(sub);
    slot.panelHost.appendChild(box);
  }

  function tag(id, cls) {
    const t = document.createElement('span');
    t.className = `tag${cls ? ` ${cls}` : ''}`;
    t.textContent = id;
    return t;
  }

  function renderPotentials(audit, stations) {
    const sec = document.createElement('div');
    sec.className = 'audit-section';
    const h = document.createElement('h4');
    h.textContent = '最终保留关系的可行势值（同一连通分量内可任意平移，根读数取 0）：';
    sec.appendChild(h);

    const groups = new Map();
    for (const p of audit.potentials) {
      if (!groups.has(p.root)) groups.set(p.root, []);
      groups.get(p.root).push(p);
    }
    const rootOrder = stations.map((_, i) => i).filter((i) => groups.has(i));
    for (const root of rootOrder) {
      const rows = groups.get(root)
        .sort((a, b) => stations.indexOf(a.name) - stations.indexOf(b.name));
      const cap = document.createElement('div');
      cap.className = 'comp-root';
      cap.textContent = `连通分量（基准根 ${stations[root]}，x_${stations[root]} = 0）：`;
      sec.appendChild(cap);
      const table = document.createElement('table');
      table.className = 'pot-table';
      table.innerHTML =
        '<thead><tr><th>站点 v</th><th>可行势值 x_v − x_根</th></tr></thead>';
      const tbody = document.createElement('tbody');
      for (const p of rows) {
        const tr = document.createElement('tr');
        const c1 = document.createElement('td');
        c1.textContent = p.name;
        const c2 = document.createElement('td');
        c2.textContent = bigStr(p.w);
        tr.append(c1, c2);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      sec.appendChild(table);
    }
    return sec;
  }

  function renderLayers(audit) {
    const sec = document.createElement('div');
    sec.className = 'audit-section';
    for (const layer of audit.layers) {
      const det = document.createElement('details');
      det.className = 'audit-layer';
      const sum = document.createElement('summary');
      const hitCount = layer.hits.length;
      sum.textContent =
        `第 ${layer.depth} 层（停用 ${layer.depth} 条）：穷尽 ${layer.nodes} 个候选，` +
        `其中 ${hitCount} 个命中矛盾环、${layer.feasible} 个可行；` +
        `同层去重剪枝 ${layer.pruned} 次，向下携带 ${layer.carried} 个候选` +
        (layer.feasible > 0 ? ' —— 首个可行层，搜索在此停止' : '');
      det.appendChild(sum);

      const body = document.createElement('div');
      body.className = 'layer-body';
      if (layer.hits.length === 0) {
        const p = document.createElement('div');
        p.className = 'audit-hit-cap';
        p.textContent = '本层候选全部可行（未命中矛盾环）。';
        body.appendChild(p);
      }
      for (const hit of layer.hits) {
        const div = document.createElement('div');
        div.className = 'audit-hit';
        const cap = document.createElement('div');
        cap.className = 'audit-hit-cap';
        const removedText = hit.removedIds.length > 0 ? hit.removedIds.join(', ') : '（无）';
        cap.innerHTML =
          `已停用：${escapeText(removedText)}；当前矛盾环闭合关系 ` +
          `<code>${escapeText(hit.conflict.id)}</code>，环推导 ` +
          `<span class="derived">${bigStr(hit.conflict.derived)}</span>` +
          ` ≠ 登记 <span class="conflict">${bigStr(hit.conflict.d)}</span>，` +
          `下一层只能从该环 [${hit.conflict.ring.map((r) => escapeText(r.id))
            .concat(escapeText(hit.conflict.id)).join(', ')}] 中选一条停用：`;
        div.appendChild(cap);
        div.appendChild(renderRing(hit.conflict));
        body.appendChild(div);
      }
      det.appendChild(body);
      sec.appendChild(det);
    }
    return sec;
  }

  function renderAuditResult(slot, audit) {
    if (audit.status === 'too_many_active') {
      showAuditRefused(slot, audit);
      return;
    }
    if (audit.status !== 'ok') {
      showAuditRefused(slot, { activeCount: '?', limit: MAX_AUDIT_ACTIVE });
      return;
    }

    const btn = slot.card.querySelector('.audit-btn');
    if (btn) btn.disabled = false;
    slot.panelHost.innerHTML = '';
    const box = makeAuditBox();

    const head = document.createElement('div');
    head.className = 'audit-head';
    const title = document.createElement('span');
    title.className = 'audit-title';
    title.textContent =
      `最小停用集审计结论（检查点 ${slot.result.checkpoint}）：停用 ${audit.removed.length} ` +
      `条后，其余 ${audit.kept.length} 条读数首次共同成立`;
    head.appendChild(title);
    box.appendChild(head);

    const sub = document.createElement('div');
    sub.className = 'audit-sub';
    sub.textContent =
      '先最少化停用条数，再按关系标识升序比较整个停用集；每个状态均由' +
      '可回滚带势并查集按登记行序重建，候选只从当前矛盾环分出。';
    box.appendChild(sub);

    const rm = document.createElement('div');
    rm.className = 'audit-section';
    rm.append('停用关系（' + audit.removed.length + ' 条，按标识升序）：');
    for (const id of audit.removed) rm.appendChild(tag(id, 'removed'));
    box.appendChild(rm);

    const kept = document.createElement('div');
    kept.className = 'audit-section';
    kept.append('保留关系（' + audit.kept.length + ' 条）：');
    for (const e of audit.kept) kept.appendChild(tag(e.id, 'kept'));
    box.appendChild(kept);

    box.appendChild(renderPotentials(audit, slot.stations));

    const lh = document.createElement('div');
    lh.className = 'audit-section';
    const lhh = document.createElement('h4');
    lhh.textContent = '各层搜索命中的矛盾环（展开可逐项复算）：';
    lh.appendChild(lhh);
    lh.appendChild(renderLayers(audit));
    box.appendChild(lh);

    slot.panelHost.appendChild(box);
  }

  function startAudit(slot) {
    auditRunner.start(slot.result.checkpoint, {
      result: slot.result,
      stations: slot.stations,
    });
  }

  function renderResult(result, stations) {
    const tpl = document.getElementById('tpl-result');
    const node = tpl.content.firstElementChild.cloneNode(true);
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
    for (const id of result.activeIds) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = id;
      tags.appendChild(t);
    }
    body.appendChild(tags);

    // 仅冲突检查点可发起最小停用集审计
    if (!result.feasible) {
      const auditHost = document.createElement('div');
      auditHost.className = 'audit-host';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'audit-btn';
      const overLimit = result.activeEdges.length > MAX_AUDIT_ACTIVE;
      btn.textContent = overLimit
        ? `发起最小停用集审计（${result.activeEdges.length} 条活动关系，超过 ${MAX_AUDIT_ACTIVE} 条上限）`
        : '发起最小停用集审计';
      const slot = { card: node, panelHost: auditHost, result, stations };
      btn.addEventListener('click', () => startAudit(slot));
      body.appendChild(btn);
      body.appendChild(auditHost);
      auditSlots.set(result.checkpoint, slot);
    }

    return node;
  }

  function run() {
    const parsed = parseScript(scriptEl.value);
    if (!parsed.ok) {
      // 一次定位全部问题，并清除旧审计结果
      invalidateAudits();
      clearAuditView(false);
      emptyHintEl.hidden = true;
      renderErrors(parsed.errors);
      updateMeter();
      return;
    }

    const results = solveAudit(parsed.ops, parsed.stations);
    lastAudit = { stations: parsed.stations, results };
    staleNote.hidden = true;
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    resultsEl.innerHTML = '';
    // 重新校核：旧审计（含在途计算）立即失效，迟到结果不得重建面板
    invalidateAudits();

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

  // 与 run 中解析失败分支共用：只清视图，不清 lastAudit 之外的状态
  function clearAuditView(stale) {
    lastAudit = null;
    staleNote.hidden = !stale;
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    resultsEl.innerHTML = '';
    emptyHintEl.hidden = stale;
  }

  $('#btn-run').addEventListener('click', run);
  $('#btn-example').addEventListener('click', () => {
    scriptEl.value = EXAMPLE;
    invalidateAudits();
    clearAuditView(false);
    updateMeter();
  });
  scriptEl.addEventListener('input', () => {
    // 编辑脚本：旧审计立即失效（审计面板移除），迟到计算由代际令牌丢弃
    if (lastAudit || !errorsEl.hidden || auditSlots.size > 0) {
      invalidateAudits();
      clearAuditView(true);
    }
    updateMeter();
  });

  scriptEl.value = EXAMPLE;
  clearAuditView(false);
  updateMeter();
})();
