#!/usr/bin/env node
/**
 * verify.mjs — 一次性验收服务（Compose 服务名：verify）
 *
 * 依次完成：
 *   1. 复现登记 A→B=5、B→C=-2 ⇒ 可行且 A→C=3；
 *      再登记 A→C=4 ⇒ 推导值 3 与冲突值 4 的矛盾环（逐项相加复算）；
 *      撤回后下一检查点恢复可行。
 *   1b. 在示例冲突检查点上发起最小停用集审计（与 Compose 页面同款模块）：
 *       最少停用条数、标识升序决胜、保留关系可行势值、各层命中矛盾环；
 *       活动关系超过 18 条上限被明确拒绝（恰好 18 条受理）；
 *       编辑/重校核/切换检查点时旧审计立即失效、迟到结果不覆盖当前选择。
 *   2. 运行全部代码测试（node --test test/）。
 *   3. 构建产物并做清单/校验和检查（tools/build.mjs --check）。
 *   4. 对页面与健康状态做 HTTP 冒烟：
 *      - 容器网络地址 WEB_BASE_URL（默认 http://web:8080）
 *      - 宿主机映射端口地址 WEB_PUBLISHED_URL（默认
 *        http://host.docker.internal:${WEB_PORT:-8080}，验证可配置宿主机端口）
 *      确认页面、审计脚本资源与 /healthz 健康状态可达后退出。
 *
 * 全部通过退出码 0；任一阶段失败退出码 1。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INTERNAL_URL = process.env.WEB_BASE_URL || 'http://web:8080';
const PUBLISHED_URL = process.env.WEB_PUBLISHED_URL
  || `http://host.docker.internal:${process.env.WEB_PORT || '8080'}`;
const SKIP_PUBLISHED = process.env.SMOKE_SKIP_PUBLISHED === '1';
const READY_TIMEOUT_MS = 60_000;

const DSParser = (await import('../web/js/parser.js')).default;
const DSCable = (await import('../web/js/solver.js')).default;
const DSAuditRunner = (await import('../web/js/audit-runner.js')).default;
const { parseScript } = DSParser;
const { solveAudit, deriveAt, auditCheckpoint, MAX_AUDIT_ACTIVE } = DSCable;
const { createAuditRunner } = DSAuditRunner;

let failures = 0;
function check(name, cond, detail) {
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail && !cond ? ` —— ${detail}` : ''}`);
  if (!cond) failures += 1;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    p.on('close', (code) => res(code));
  });
}

/* ---------- 阶段 1：业务场景复现 ---------- */
section('阶段 1：复现登记 / 冲突 / 撤回恢复场景');

const scenario = [
  'stations: A,B,C',
  'r1: A→B=5',
  'r2: B→C=-2',
  'checkpoint', // 1：可行，A→C 可推导为 3
  'r3: A→C=4',
  'checkpoint', // 2：推导值 3 与冲突值 4 构成矛盾环
  'withdraw r3',
  'checkpoint', // 3：撤回后恢复可行
].join('\n');

const parsed = parseScript(scenario);
check('脚本能无错误解析', parsed.ok, JSON.stringify(parsed.errors));

if (parsed.ok) {
  const results = solveAudit(parsed.ops, parsed.stations);
  check('共得到 3 个检查点结论', results.length === 3, `实际 ${results.length}`);

  const cp1 = results[0];
  check('检查点 1 可行', cp1 && cp1.feasible === true);
  const d1 = cp1 && deriveAt(cp1, parsed.stations, 'A', 'C');
  check('检查点 1 可推导 A→C = 3', d1 && d1.status === 'ok' && d1.value === 3n,
    `实际 ${d1 && d1.status} ${d1 && d1.value}`);

  const cp2 = results[1];
  check('检查点 2 判定冲突', cp2 && cp2.feasible === false);
  const c = cp2 && cp2.conflict;
  check('矛盾环由新登记关系 r3 闭合触发', c && c.id === 'r3', c && c.id);
  check('环推导值为 3', c && c.derived === 3n, c && String(c.derived));
  check('冲突值为 4', c && c.d === 4n, c && String(c.d));
  if (c) {
    let sum = 0n;
    for (const row of c.ring) sum += row.contrib;
    check('环中各式逐项相加 ∑ = 3 (= 5 + (-2))', sum === 3n, `实际 ${sum}`);
    const byId = Object.fromEntries(c.ring.map((r) => [r.id, r]));
    check('矛盾环包含 r1（贡献 +5）', byId.r1 && byId.r1.contrib === 5n);
    check('矛盾环包含 r2（贡献 -2）', byId.r2 && byId.r2.contrib === -2n);
    console.log('  环复算明细：');
    for (const row of c.ring) {
      console.log(
        `    - ${row.id}: ${row.u}→${row.v}=${row.d}` +
        `  环方向 x_${row.plus}−x_${row.minus}${row.reversed ? '（反向）' : ''}` +
        `  取值 ${row.contrib}`
      );
    }
  }

  const cp3 = results[2];
  check('撤回 r3 后检查点 3 恢复可行', cp3 && cp3.feasible === true);
  check('检查点 3 活动关系仅剩 r1、r2',
    cp3 && JSON.stringify(cp3.activeIds) === JSON.stringify(['r1', 'r2']));
  const d3 = cp3 && deriveAt(cp3, parsed.stations, 'A', 'C');
  check('检查点 3 重新推导 A→C = 3', d3 && d3.status === 'ok' && d3.value === 3n);
}

/* ---------- 阶段 1b：最小停用集审计（页面操作同款模块） ---------- */
section('阶段 1b：示例冲突检查点的最小停用集审计');

if (parsed.ok) {
  const results = solveAudit(parsed.ops, parsed.stations);

  // 与页面「发起最小停用集审计」按钮完全一致的调用
  const cp2 = results[1];
  check('审计目标检查点 2 为冲突', cp2 && cp2.feasible === false);
  check('检查点 2 结论附带当时活动关系（3 条）',
    cp2 && Array.isArray(cp2.activeEdges) && cp2.activeEdges.length === 3);

  const audit = auditCheckpoint(cp2, parsed.stations, cp2.activeEdges);
  check('审计受理成功', audit.status === 'ok', audit.status);
  check('最少停用 1 条', audit.removed.length === 1, `实际 ${audit.removed.length}`);
  check('整个停用集按标识升序取最小者 {r1}（{r1}/{r2}/{r3} 单停皆可行）',
    JSON.stringify(audit.removed) === JSON.stringify(['r1']), JSON.stringify(audit.removed));
  check('保留关系为 r2、r3',
    JSON.stringify(audit.kept.map((e) => e.id)) === JSON.stringify(['r2', 'r3']));

  // 保留关系的可行势值：每条保留式 x_v - x_u = d 都必须成立
  let potOk = audit.status === 'ok';
  if (potOk) {
    const w = new Map(audit.potentials.map((p) => [p.name, p.w]));
    for (const e of audit.kept) {
      if (w.get(e.v) - w.get(e.u) !== e.d) { potOk = false; }
    }
  }
  check('展示的可行势值满足全部保留关系', potOk);
  check('可行势值可推出保留式 A→C = 4（r3）',
    (() => {
      const w = new Map(audit.potentials.map((p) => [p.name, p.w]));
      return w.get('C') - w.get('A') === 4n;
    })());

  // 各层搜索命中的矛盾环：第 0 层命中原环 r3（环 r1+r2，∑=3≠4），第 1 层首次可行
  check('分层记录两层', audit.layers.length === 2, `实际 ${audit.layers.length}`);
  const l0 = audit.layers[0];
  const l1 = audit.layers[1];
  check('第 0 层穷尽 1 个候选且命中矛盾环', l0 && l0.nodes === 1 && l0.hits.length === 1);
  const hit0 = l0 && l0.hits[0];
  check('命中环闭合关系为 r3、推导 3 ≠ 冲突 4、逐项相加 ∑=3',
    hit0 && hit0.conflict.id === 'r3' && hit0.conflict.derived === 3n &&
    hit0.conflict.d === 4n && hit0.conflict.sum === 3n);
  check('命中环由 r1、r2 拼成（首尾相接的真实环）',
    hit0 && JSON.stringify(hit0.conflict.ring.map((r) => r.id).sort()) ===
    JSON.stringify(['r1', 'r2']));
  check('第 1 层为首个可行层（3 个候选可行后停止）',
    l1 && l1.depth === 1 && l1.feasible === 3 && l1.hits.length === 0);
}

section('阶段 1b（续）：超过活动关系上限被明确拒绝');
{
  const lines = ['stations: A,B'];
  for (let i = 0; i < MAX_AUDIT_ACTIVE; i += 1) lines.push(`e${i}: A→B=1`);
  lines.push('z: A→B=2'); // 第 19 条活动关系，制造冲突
  lines.push('checkpoint');
  const p = parseScript(lines.join('\n'));
  check('19 条活动关系脚本本身可校核', p.ok, JSON.stringify(p.errors));
  if (p.ok) {
    const rs = solveAudit(p.ops, p.stations);
    check('该检查点冲突', rs[0].feasible === false);
    const refused = auditCheckpoint(rs[0], p.stations, rs[0].activeEdges);
    check('超上限审计被明确拒绝（too_many_active）', refused.status === 'too_many_active',
      refused.status);
    check('拒绝结论给出实际条数 19 与受理上限 18',
      refused.activeCount === 19 && refused.limit === MAX_AUDIT_ACTIVE &&
      MAX_AUDIT_ACTIVE === 18,
      JSON.stringify({ n: refused.activeCount, limit: refused.limit }));
  }

  // 恰好 18 条必须受理（17 条一致边 + 1 条冲突边 z）
  const okLines = lines.slice(0, -3).concat(['z: A→B=2', 'checkpoint']);
  const p18 = parseScript(okLines.join('\n'));
  const r18 = solveAudit(p18.ops, p18.stations);
  const a18 = auditCheckpoint(r18[0], p18.stations, r18[0].activeEdges);
  check('恰好 18 条活动关系仍受理', a18.status === 'ok' && a18.activeCount === 18,
    a18.status);
}

section('阶段 1b（续）：编辑 / 重校核 / 切换检查点时旧审计立即失效，迟到结果不覆盖');
{
  // 复刻页面 createAuditRunner 的代际门控：在途计算晚到时只能走 onStale
  const events = [];
  let finishOld;
  const compute = (payload) => new Promise((resolve) => {
    if (payload === 'old') finishOld = () => resolve('OLD-RESULT');
    else setTimeout(() => resolve('NEW-RESULT'), 5);
  });
  const runner = createAuditRunner(compute, {
    onBegin: (key) => events.push(['begin', key]),
    onResolve: (key, val) => events.push(['resolve', key, val]),
    onStale: (key) => events.push(['stale', key]),
  });

  runner.start(2, 'old');         // 在检查点 2 发起审计（在途）
  runner.invalidate();            // 编辑脚本：旧审计立即失效
  finishOld();                    // 迟到计算完成
  await new Promise((r) => setTimeout(r, 20));
  check('失效后迟到结果不产生 resolve',
    !events.some(([t]) => t === 'resolve'));
  check('迟到结果走 onStale', events.some(([t, k]) => t === 'stale' && k === 2));
  check('失效后无当前选择', runner.currentKey() === null);

  // 切换检查点：旧检查点的在途结果同样不得覆盖
  events.length = 0;
  let finishCp2;
  const compute2 = (payload) => new Promise((resolve) => {
    if (payload === 'cp2') finishCp2 = () => resolve('CP2');
    else setTimeout(() => resolve('CP3'), 5);
  });
  const runner2 = createAuditRunner(compute2, {
    onResolve: (key, val) => events.push(['resolve', key, val]),
    onStale: (key) => events.push(['stale', key]),
  });
  runner2.start(2, 'cp2');
  runner2.start(3, 'cp3');        // 切换到另一检查点
  finishCp2();
  await new Promise((r) => setTimeout(r, 20));
  check('切换后只接受当前检查点结果',
    events.some(([t, k, v]) => t === 'resolve' && k === 3 && v === 'CP3') &&
    !events.some(([t, k]) => t === 'resolve' && k === 2));
  check('被切换的旧检查点结果判为 stale',
    events.some(([t, k]) => t === 'stale' && k === 2));
}

/* ---------- 阶段 2：代码测试 ---------- */
section('阶段 2：代码测试 node --test test/');
const testCode = await run('node', ['--test', 'test/']);
check('全部单元测试通过', testCode === 0, `退出码 ${testCode}`);

/* ---------- 阶段 3：构建产物检查 ---------- */
section('阶段 3：构建产物与清单校验');
const buildCode = await run('node', ['tools/build.mjs']);
check('构建成功', buildCode === 0, `退出码 ${buildCode}`);
const checkCode = await run('node', ['tools/build.mjs', '--check']);
check('产物 sha256 清单与资源引用检查通过', checkCode === 0, `退出码 ${checkCode}`);

/* ---------- 阶段 4：HTTP 冒烟 ---------- */
async function waitReady(base) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return true;
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw lastErr;
}

async function smoke(base, label) {
  section(`阶段 4：HTTP 冒烟（${label}） ${base}`);
  await waitReady(base);

  const home = await fetch(`${base}/`);
  const homeText = await home.text();
  check(`${label} GET / 返回 200`, home.status === 200, `HTTP ${home.status}`);
  check(`${label} 页面包含校核台标题`, homeText.includes('站间偏移校核台'));
  check(`${label} 页面已挂载审计调度脚本 audit-runner.js`,
    homeText.includes('js/audit-runner.js'));

  const health = await fetch(`${base}/healthz`);
  const healthText = await health.text();
  let healthJson = null;
  try { healthJson = JSON.parse(healthText); } catch { /* 下面报错 */ }
  check(`${label} GET /healthz 返回 200`, health.status === 200, `HTTP ${health.status}`);
  check(`${label} 健康状态为 ok`, healthJson && healthJson.status === 'ok', healthText);

  const asset = await fetch(`${base}/js/solver.js`);
  check(`${label} 静态资源 js/solver.js 返回 200`, asset.status === 200, `HTTP ${asset.status}`);

  const auditJs = await fetch(`${base}/js/audit-runner.js`);
  check(`${label} 静态资源 js/audit-runner.js 返回 200`,
    auditJs.status === 200, `HTTP ${auditJs.status}`);
}

try {
  await smoke(INTERNAL_URL, '容器网络');
} catch (e) {
  check(`容器网络冒烟就绪并通过`, false, e.message);
}

if (!SKIP_PUBLISHED) {
  try {
    await smoke(PUBLISHED_URL, '宿主机映射端口');
  } catch (e) {
    check('宿主机映射端口冒烟就绪并通过', false,
      `${e.message}（可用 SMOKE_SKIP_PUBLISHED=1 跳过）`);
  }
} else {
  console.log('\n=== 阶段 4：宿主机映射端口冒烟已按配置跳过 ===');
}

/* ---------- 结论 ---------- */
section('验收结论');
if (failures === 0) {
  console.log('ACCEPTED ✅  全部验收项通过');
  process.exit(0);
} else {
  console.error(`REJECTED ❌  共 ${failures} 个验收项失败`);
  process.exit(1);
}
