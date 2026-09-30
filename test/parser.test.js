/**
 * parser.test.js — 脚本解析与一次性错误定位
 * 运行：node --test test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseScript, MAX_STATIONS, MAX_LINES } = require('../web/js/parser.js');

function codes(text) {
  return parseScript(text).errors.map((e) => ({ line: e.line, code: e.code, token: e.token }));
}

test('标准场景脚本解析成功，操作类型正确', () => {
  const r = parseScript([
    'stations: A,B,C',
    'r1: A→B=5',
    'r2: B->C=-2',
    '# 这是注释',
    '',
    'checkpoint',
    'withdraw r1',
  ].join('\n'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.stations, ['A', 'B', 'C']);
  assert.deepEqual(r.ops.map((o) => o.kind), ['reg', 'reg', 'checkpoint', 'withdraw']);
  assert.equal(r.ops[0].d, 5n);
  assert.equal(r.ops[1].d, -2n);
});

test('省略标识时自动编号，省略 stations 时隐式收集站点', () => {
  const r = parseScript('A→B=1\nB→C=2\ncheckpoint');
  assert.equal(r.ok, true);
  assert.deepEqual(r.stations, ['A', 'B', 'C']);
  assert.deepEqual(r.ops.filter((o) => o.kind === 'reg').map((o) => o.id), ['#1', '#2']);
});

test('重复登记一次定位（活动中同标识）', () => {
  const errs = codes('stations: A,B\nk: A→B=1\nk: A→B=2\ncheckpoint');
  assert.ok(errs.some((e) => e.line === 3 && e.code === 'duplicate_registration' && e.token === 'k'));
});

test('未知标识与已撤回标识分别定位，可同批报告', () => {
  const errs = codes([
    'stations: A,B',
    'k: A→B=1',
    'withdraw k',
    'withdraw k',   // 已撤回
    'withdraw q',   // 从未登记
  ].join('\n'));
  assert.ok(errs.some((e) => e.line === 4 && e.code === 'withdrawn_id'));
  assert.ok(errs.some((e) => e.line === 5 && e.code === 'unknown_id'));
});

test('无效标识一次定位', () => {
  const errs = codes('stations: A,B\n1bad: A→B=1\nwithdraw 中文标识');
  assert.ok(errs.some((e) => e.line === 2 && e.code === 'syntax'));
  assert.ok(errs.some((e) => e.line === 3 && e.code === 'invalid_id'));
});

test('未知端点（声明了 stations 时）一次定位', () => {
  const errs = codes('stations: A,B\nA→Z=1\nZ→A=2');
  const unknown = errs.filter((e) => e.code === 'unknown_endpoint');
  assert.deepEqual(unknown.map((e) => ({ line: e.line, token: e.token })), [
    { line: 2, token: 'Z' },
    { line: 3, token: 'Z' },
  ]);
});

test('超界整数与非整数一次定位', () => {
  const errs = codes('stations: A,B\nA→B=9007199254740992\nA→B=1.5\nA→B=9007199254740991');
  assert.ok(errs.some((e) => e.line === 2 && e.code === 'integer_out_of_range'));
  assert.ok(errs.some((e) => e.line === 3 && e.code === 'not_integer'));
  // 恰好边界值合法
  const r = parseScript('stations: A,B\nA→B=-9007199254740991\ncheckpoint');
  assert.equal(r.ok, true);
});

test('一段问题脚本中多类错误同时定位，且不输出任何旧/半成品审计操作', () => {
  const text = [
    'stations: A,B',
    'k: A→B=1',
    'k: B→A=2',                      // 重复登记
    'A→Z=abc',                       // 未知端点 + 非整数（两条）
    'withdraw nobody',               // 未知标识
    'stations: A',                   // 重复声明
    'A→A=1',                         // 两端相同
    '!!!',                           // 语法错误
  ].join('\n');
  const r = parseScript(text);
  assert.equal(r.ok, false);
  assert.deepEqual(r.ops, []);
  const got = r.errors.map((e) => e.line).sort((a, b) => a - b);
  for (const ln of [3, 4, 4, 5, 6, 7, 8]) assert.ok(got.includes(ln), `第 ${ln} 行应被定位`);
  const codeSet = new Set(r.errors.map((e) => e.code));
  for (const c of ['duplicate_registration', 'unknown_endpoint', 'not_integer',
    'unknown_id', 'duplicate_stations', 'same_endpoint', 'syntax']) {
    assert.ok(codeSet.has(c), `应包含 ${c}`);
  }
});

test('站点与行数上限', () => {
  const tooManyStations = `stations: ${Array.from({ length: MAX_STATIONS + 1 }, (_, i) => `S${i}`).join(',')}\ncheckpoint`;
  assert.ok(codes(tooManyStations).some((e) => e.code === 'too_many_stations'));

  const lines = [];
  for (let i = 0; i < MAX_LINES; i += 1) lines.push('checkpoint');
  assert.equal(parseScript(lines.join('\n')).ok, true);
  lines.push('checkpoint');
  assert.ok(codes(lines.join('\n')).some((e) => e.code === 'too_many_lines'));
});

test('隐式站点超过 64 个定位', () => {
  const lines = [];
  for (let i = 0; i < MAX_STATIONS + 1; i += 1) lines.push(`X${i}→Y${i}=1`);
  assert.ok(codes(lines.join('\n')).some((e) => e.code === 'too_many_stations'));
});

test('撤回后重新登记同一标识合法', () => {
  const r = parseScript('stations: A,B\nk: A→B=1\nwithdraw k\nk: A→B=2\ncheckpoint');
  assert.equal(r.ok, true);
  assert.equal(r.ops.length, 4);
});

test('支持中文关键字 撤回/检查点', () => {
  const r = parseScript('stations: A,B\nk: A→B=1\n检查点\n撤回 k\n检查点');
  assert.equal(r.ok, true);
  assert.deepEqual(r.ops.map((o) => o.kind), ['reg', 'checkpoint', 'withdraw', 'checkpoint']);
});
