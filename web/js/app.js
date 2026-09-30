/* app.js — 校核台页面逻辑（无框架、无外部依赖） */
(function () {
  'use strict';

  const { parseScript } = window.DSParser;
  const { solveAudit, deriveAt } = window.DSCable;

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

  function clearAudit(stale) {
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
    lastAudit = { stations: parsed.stations, results };
    staleNote.hidden = true;
    errorsEl.hidden = true;
    errorsEl.innerHTML = '';
    resultsEl.innerHTML = '';

    if (results.length === 0) {
      emptyHintEl.hidden = false;
      emptyHintEl.textContent = '脚本有效，但其中没有任何 checkpoint。';
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
})();
