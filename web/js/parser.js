/*
 * parser.js — 检修脚本解析与一次性校验
 *
 * 脚本文法（每行一条，空行与 # 注释行忽略；箭头 → 与 -> 等价）：
 *   stations: A,B,C            可选，至多一行，显式声明全部站点（≤64）
 *   [id:] u→v=d                登记关系 x_v - x_u = d，id 省略时自动编号 #1、#2…
 *   withdraw id                撤回关系（亦接受 “撤回 id” / “drop id”）
 *   checkpoint                 检查点（亦接受 “检查点” / “cp”）
 *
 * 标识规则：^[A-Za-z_][A-Za-z0-9_-]{0,31}$（自动标识 #n 不可能与之冲突）。
 * 整数范围：±9007199254740991（Number 安全整数界；内核内部按 BigInt 运算）。
 *
 * 校验策略：扫描全文一次性定位所有错误，不做“遇错即停”。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_STATIONS = 64;
  const MAX_LINES = 180;
  const D_MIN = -9007199254740991n;
  const D_MAX = 9007199254740991n;
  const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
  const NAME_RE = /^[A-Za-z0-9_一-龥][A-Za-z0-9_.一-龥-]{0,31}$/;
  const INT_RE = /^[+-]?\d+$/;
  const ARROW = /→|->/;

  const ERROR_MESSAGES = {
    too_many_lines: `脚本超过 ${MAX_LINES} 行上限`,
    syntax: '无法识别的语句（应为登记 [id:] u→v=d、withdraw id、checkpoint 或 stations: 声明）',
    duplicate_stations: 'stations 站点声明只能出现一次',
    bad_station_list: '站点列表为空或存在空项',
    invalid_station_name: '站点名无效（1–32 位字母/数字/下划线/中划线/点/汉字，须字母数字下划线或汉字开头）',
    duplicate_station: '站点声明中存在重复站点',
    too_many_stations: `站点数量超过 ${MAX_STATIONS} 个上限`,
    invalid_id: '关系标识无效（须以字母或下划线开头，仅含字母数字下划线中划线，长度 1–32）',
    empty_endpoint: '端点名不能为空',
    invalid_endpoint: '端点名格式无效',
    same_endpoint: '关系两端不能是同一站点',
    not_integer: '偏移量必须是十进制整数',
    integer_out_of_range: `整数超出允许范围 [${D_MIN}, ${D_MAX}]`,
    duplicate_registration: '重复登记：该标识当前仍处于活动状态（如需改值请先 withdraw）',
    unknown_id: '撤回失败：标识从未登记过',
    withdrawn_id: '撤回失败：该标识对应的关系已经撤回',
    unknown_endpoint: '未知端点：站点未在 stations 声明中',
  };

  function err(line, code, extra) {
    return Object.assign({ line, code, message: ERROR_MESSAGES[code] || code }, extra || {});
  }

  function splitLines(text) {
    return text.replace(/\r\n?/g, '\n').split('\n');
  }

  /**
   * 解析并校验整段脚本。
   * @returns {{ok:boolean, errors:Array, ops:Array, stations:string[], declared:boolean}}
   */
  function parseScript(text) {
    const lines = splitLines(text);
    const errors = [];
    const ops = [];

    let declared = false;
    let declaredStations = null;
    let stationsDeclLine = 0;
    const implicitSet = new Map(); // name -> 首次出现行
    let effectiveCount = 0;

    // id 生命周期：unseen / active / withdrawn
    const idState = new Map();
    let autoSeq = 0;
    let codeLineCount = 0;
    let lineLimitReported = false;

    const touchEndpoint = (name, line) => {
      if (declaredStations && !declaredStations.has(name)) {
        errors.push(err(line, 'unknown_endpoint', { token: name }));
      } else if (!declaredStations && !implicitSet.has(name)) {
        implicitSet.set(name, line);
        effectiveCount += 1;
        if (effectiveCount > MAX_STATIONS) {
          errors.push(err(line, 'too_many_stations', { token: name }));
        }
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const lineNo = i + 1;
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) continue;

      codeLineCount += 1;
      if (codeLineCount > MAX_LINES) {
        if (!lineLimitReported) {
          errors.push(err(lineNo, 'too_many_lines'));
          lineLimitReported = true;
        }
        continue;
      }

      // ---- stations 声明 ----
      if (/^stations\s*:/i.test(line)) {
        if (declared) {
          errors.push(err(lineNo, 'duplicate_stations'));
          continue;
        }
        declared = true;
        stationsDeclLine = lineNo;
        const body = line.slice(line.indexOf(':') + 1);
        const parts = body.split(',').map((s) => s.trim());
        if (parts.length === 0 || parts.some((p) => p === '')) {
          errors.push(err(lineNo, 'bad_station_list'));
          declaredStations = new Set();
          continue;
        }
        const set = new Set();
        let bad = false;
        for (const p of parts) {
          if (!NAME_RE.test(p)) {
            errors.push(err(lineNo, 'invalid_station_name', { token: p }));
            bad = true;
          } else if (set.has(p)) {
            errors.push(err(lineNo, 'duplicate_station', { token: p }));
            bad = true;
          } else set.add(p);
        }
        if (set.size > MAX_STATIONS) {
          errors.push(err(lineNo, 'too_many_stations'));
          bad = true;
        }
        declaredStations = set;
        continue;
      }

      // ---- 检查点 ----
      if (/^(checkpoint|cp|检查点)$/i.test(line)) {
        ops.push({ kind: 'checkpoint', line: lineNo });
        continue;
      }

      // ---- 撤回 ----
      const wd = line.match(/^(?:withdraw|drop|撤回)\s+(.+)$/i);
      if (wd) {
        const id = wd[1].trim();
        if (!ID_RE.test(id) && !/^#\d+$/.test(id)) {
          errors.push(err(lineNo, 'invalid_id', { token: id }));
          continue;
        }
        const st = idState.get(id);
        if (st === undefined) errors.push(err(lineNo, 'unknown_id', { token: id }));
        else if (st === 'withdrawn') errors.push(err(lineNo, 'withdrawn_id', { token: id }));
        else {
          idState.set(id, 'withdrawn');
          ops.push({ kind: 'withdraw', id, line: lineNo });
        }
        continue;
      }

      // ---- 登记 [id:] u→v=d ----
      let explicitId = null;
      let rest = line;
      const colon = line.indexOf(':');
      if (colon !== -1) {
        const head = line.slice(0, colon).trim();
        if (ID_RE.test(head)) {
          explicitId = head;
          rest = line.slice(colon + 1).trim();
        } else {
          // 站点名不允许含冒号：冒号前又不是合法标识，整行语法无效
          errors.push(err(lineNo, 'syntax'));
          continue;
        }
      }
      if (explicitId !== null && idState.get(explicitId) === 'active') {
        errors.push(err(lineNo, 'duplicate_registration', { token: explicitId }));
      }

      const arrowMatch = rest.match(ARROW);
      const eqPos = rest.lastIndexOf('=');
      if (!arrowMatch || eqPos === -1 || eqPos < arrowMatch.index) {
        errors.push(err(lineNo, 'syntax'));
        continue;
      }

      const u = rest.slice(0, arrowMatch.index).trim();
      const v = rest.slice(arrowMatch.index + arrowMatch[0].length, eqPos).trim();
      const dText = rest.slice(eqPos + 1).trim();

      let endpointFatal = false;
      if (u === '' || v === '') {
        errors.push(err(lineNo, 'empty_endpoint'));
        endpointFatal = true;
      } else {
        if (!NAME_RE.test(u)) {
          errors.push(err(lineNo, 'invalid_endpoint', { token: u }));
          endpointFatal = true;
        }
        if (!NAME_RE.test(v)) {
          errors.push(err(lineNo, 'invalid_endpoint', { token: v }));
          endpointFatal = true;
        }
        if (u === v && NAME_RE.test(u)) {
          errors.push(err(lineNo, 'same_endpoint', { token: u }));
          endpointFatal = true;
        }
      }
      let integerFatal = false;
      if (!INT_RE.test(dText)) {
        errors.push(err(lineNo, 'not_integer', { token: dText }));
        integerFatal = true;
      } else {
        let d;
        try {
          d = BigInt(dText);
        } catch (_) {
          d = null;
        }
        if (d === null || d < D_MIN || d > D_MAX) {
          errors.push(err(lineNo, 'integer_out_of_range', { token: dText }));
          integerFatal = true;
        }
      }

      // 端点格式合法即可定位“未知端点”，不依赖整数是否合法（一次定位全部问题）
      if (!endpointFatal) {
        touchEndpoint(u, lineNo);
        touchEndpoint(v, lineNo);
      }
      if (endpointFatal || integerFatal) continue;

      // 显式活动 id 已记 duplicate 错误，跳过该操作；自动 id 永不冲突
      let id;
      if (explicitId !== null) {
        if (idState.get(explicitId) === 'active') continue;
        id = explicitId;
      } else {
        autoSeq += 1;
        id = `#${autoSeq}`;
      }

      idState.set(id, 'active');
      ops.push({ kind: 'reg', id, u, v, d: BigInt(dText), line: lineNo });
    }

    // 汇总站点列表：声明按声明顺序保留，隐式按首次出现行排序
    let stations;
    if (declared) {
      stations = Array.from(declaredStations || []);
    } else {
      stations = Array.from(implicitSet.entries())
        .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))
        .map((e) => e[0]);
    }

    return {
      ok: errors.length === 0,
      errors,
      ops: errors.length === 0 ? ops : [],
      stations,
      declared,
      stationsDeclLine,
      limits: { MAX_STATIONS, MAX_LINES, D_MIN: D_MIN.toString(), D_MAX: D_MAX.toString() },
    };
  }

  return { parseScript, MAX_STATIONS, MAX_LINES, D_MIN, D_MAX, ID_RE, NAME_RE, ERROR_MESSAGES };
});
