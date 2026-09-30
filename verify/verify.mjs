#!/usr/bin/env node
/**
 * verify.mjs — 一次性验收服务（Compose 服务名：verify）
 *
 * 依次完成：
 *   1. 复现登记 A→B=5、B→C=-2 ⇒ 可行且 A→C=3；
 *      再登记 A→C=4 ⇒ 推导值 3 与冲突值 4 的矛盾环（逐项相加复算）；
 *      撤回后下一检查点恢复可行。
 *   2. 运行全部代码测试（node --test test/）。
 *   3. 构建产物并做清单/校验和检查（tools/build.mjs --check）。
 *   4. 对页面与健康状态做 HTTP 冒烟：
 *      - 容器网络地址 WEB_BASE_URL（默认 http://web:8080）
 *      - 宿主机映射端口地址 WEB_PUBLISHED_URL（默认
 *        http://host.docker.internal:${WEB_PORT:-8080}，验证可配置宿主机端口）
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
const { parseScript } = DSParser;
const { solveAudit, deriveAt } = DSCable;

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

  const health = await fetch(`${base}/healthz`);
  const healthText = await health.text();
  let healthJson = null;
  try { healthJson = JSON.parse(healthText); } catch { /* 下面报错 */ }
  check(`${label} GET /healthz 返回 200`, health.status === 200, `HTTP ${health.status}`);
  check(`${label} 健康状态为 ok`, healthJson && healthJson.status === 'ok', healthText);

  const asset = await fetch(`${base}/js/solver.js`);
  check(`${label} 静态资源 js/solver.js 返回 200`, asset.status === 200, `HTTP ${asset.status}`);
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
