/**
 * page-flow.mjs — 以“页面操作”驱动的最小停用集审计验收
 *
 * 通过零依赖迷你 DOM 加载真实 web/index.html 与页面三件套脚本，
 * 按工程师在 Compose 页面上的实际操作点击：
 *   1. 示例脚本：在冲突检查点发起最小停用集审计，核对停用集 / 可行势值 / 各层矛盾环；
 *   2. 活动关系超过 18 条上限：审计被明确拒绝，原冲突结论保持；
 *   3. 切换检查点 / 编辑脚本 / 重新校核：旧审计立即失效，迟到计算不覆盖当前选择；
 * 普通登记、撤回与检查点显示保持原样。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadPage } from './dom-shim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function runPageFlow(check) {
  const { window, document } = await loadPage(resolve(ROOT, 'web'));
  const $ = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- 1. 示例冲突审计（页面完整操作链路） ---- */
  window.__CABLE_APP__.example();
  $('#btn-run').click();
  let cards = document.querySelectorAll('.cp-card');
  check('页面：校核出 3 张检查点卡片（登记/撤回显示保持原样）', cards.length === 3,
    `实际 ${cards.length}`);
  check('页面：检查点 1、3 可行，检查点 2 冲突',
    cards.map((c) => c.querySelector('.badge').textContent).join(',') === '可行,冲突,可行');

  const cp2 = cards.find((c) => c.dataset.cp === '2');
  cp2.querySelector('.btn-audit').click();
  await sleep(10);

  const panel = cp2.querySelector('.audit-panel');
  check('页面：点击发起后展示最小停用集审计面板', panel.hidden === false);
  const note = cp2.querySelector('.audit-note').textContent;
  check('页面：结论为最少停用 1 条（第 1 层首次可行）',
    note.includes('最少停用 1 条') && note.includes('第 1 层'), note);

  const tagRows = panel.querySelectorAll('.audit-tags');
  check('页面：停用关系 {r1}（同层按标识升序决胜）',
    tagRows[0].textContent.trim() === '停用关系：r1',
    tagRows[0].textContent);
  check('页面：保留关系为 {r2, r3}',
    tagRows[1].textContent.includes('r2') &&
    tagRows[1].textContent.includes('r3') &&
    !tagRows[1].textContent.includes('r1'));

  const pot = {};
  for (const tr of panel.querySelectorAll('table.potentials tbody tr')) {
    const td = tr.querySelectorAll('td');
    pot[td[0].textContent] = BigInt(td[2].textContent.replace('−', '-'));
  }
  check('页面：可行势值满足保留关系 r2（x_C−x_B=−2）', pot.C - pot.B === -2n);
  check('页面：可行势值满足保留关系 r3（x_C−x_A=4）', pot.C - pot.A === 4n);

  const layers = panel.querySelectorAll('.audit-layer');
  check('页面：展示第 0、1 两层搜索命中的矛盾环', layers.length === 2,
    `实际 ${layers.length}`);
  check('页面：第 0 层矛盾环由 r3 闭合（推导 3 ≠ 冲突 4）',
    layers[0].textContent.includes('r3') && layers[0].textContent.includes('3') &&
    layers[0].textContent.includes('4'));
  check('页面：审计不改写原检查点结论（仍为冲突、原矛盾环仍在）',
    cp2.querySelector('.badge').textContent === '冲突' &&
    cp2.querySelector('.ring-summary').textContent.includes('r3'));
  check('页面：活动关系标签与撤回后检查点 3 显示保持原样',
    cards.find((c) => c.dataset.cp === '3').querySelector('.active-tags')
      .textContent.includes('r1') &&
    cards.find((c) => c.dataset.cp === '3').querySelector('.active-tags')
      .textContent.includes('r2') &&
    !cards.find((c) => c.dataset.cp === '3').querySelectorAll('.audit-box').length);

  /* ---- 2. 超出 18 条活动关系上限被明确拒绝 ---- */
  const over = ['stations: A,B'];
  for (let i = 0; i < 19; i += 1) over.push(`e${String(i).padStart(2, '0')}: A→B=${i}`);
  over.push('checkpoint');
  window.__CABLE_APP__.setScript(over.join('\n'));
  $('#btn-run').click();
  cards = document.querySelectorAll('.cp-card');
  const overCard = cards[0];
  check('页面：超限检查点仍正常校核为冲突', overCard.querySelector('.badge').textContent === '冲突');
  overCard.querySelector('.btn-audit').click();
  await sleep(10);
  const rej = overCard.querySelector('.audit-rejected');
  check('页面：19 条活动关系的审计被明确拒绝（19 > 18）',
    !!rej && rej.textContent.includes('19') && rej.textContent.includes('18'),
    rej && rej.textContent);
  check('页面：拒绝受理后原冲突结论与矛盾环保持不变',
    overCard.querySelector('.badge').textContent === '冲突' &&
    !!overCard.querySelector('.ring-summary'));

  /* ---- 3. 切换检查点：旧审计立即复位 ---- */
  const twoCp = [
    'stations: A,B,C',
    'r1: A→B=5', 'r2: B→C=-2', 'r3: A→C=4',
    'checkpoint',
    'r4: B→C=9',
    'checkpoint',
  ].join('\n');
  window.__CABLE_APP__.setScript(twoCp);
  $('#btn-run').click();
  cards = document.querySelectorAll('.cp-card');
  const c1 = cards.find((c) => c.dataset.cp === '1');
  const c2 = cards.find((c) => c.dataset.cp === '2');
  c1.querySelector('.btn-audit').click();
  await sleep(5);
  check('页面：检查点 1 审计结果已展示', c1.querySelector('.audit-panel').hidden === false);
  c2.querySelector('.btn-audit').click();
  await sleep(5);
  check('页面：切换到检查点 2 后检查点 1 的旧审计立即复位',
    c1.querySelector('.audit-panel').hidden === true);
  check('页面：检查点 2 的审计结果正常展示', c2.querySelector('.audit-panel').hidden === false);

  /* ---- 4. 编辑脚本：旧审计立即失效，迟到计算不覆盖 ---- */
  window.__CABLE_APP__.example();
  $('#btn-run').click();
  cards = document.querySelectorAll('.cp-card');
  const tgt = cards.find((c) => c.dataset.cp === '2');
  tgt.querySelector('.btn-audit').click(); // 计算在途（事件循环让出期间）
  const seqBefore = window.__CABLE_APP__.state().seq;
  window.__CABLE_APP__.editScript(`${$('#script').value}\n# 工程师追加一行注释`);
  check('页面：编辑脚本后审计令牌立即自增（旧审计失效）',
    window.__CABLE_APP__.state().seq === seqBefore + 1);
  check('页面：编辑后旧结论卡片立即清空并显示过期提示',
    document.querySelectorAll('.cp-card').length === 0 &&
    $('#stale-note').hidden === false);
  await sleep(20); // 等待在途审计迟到
  check('页面：迟到计算未覆盖当前选择（卡片仍为空）',
    document.querySelectorAll('.cp-card').length === 0);

  /* ---- 5. 重新校核：旧审计立即失效 ---- */
  window.__CABLE_APP__.example();
  $('#btn-run').click();
  cards = document.querySelectorAll('.cp-card');
  cards.find((c) => c.dataset.cp === '2').querySelector('.btn-audit').click();
  await sleep(5);
  const seqRerun = window.__CABLE_APP__.state().seq;
  $('#btn-run').click();
  check('页面：重新校核使旧审计立即失效（令牌自增、审计面板清空）',
    window.__CABLE_APP__.state().seq === seqRerun + 1 &&
    document.querySelectorAll('.audit-panel').filter((p) => p.hidden === false).length === 0);
  check('页面：重新校核后普通检查点结论照常显示',
    document.querySelectorAll('.cp-card').length === 3);
}
