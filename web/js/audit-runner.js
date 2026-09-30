/*
 * audit-runner.js — 最小停用集审计的发起 / 失效调度（无 DOM 依赖）
 *
 * 页面在“既有校核完成”之后，由工程师选择某一个冲突检查点发起审计。
 * 编辑脚本、重新校核或切换到另一个检查点时，旧审计必须立即失效；
 * 已经在途、晚到的计算结果不得覆盖当前选择。
 *
 * 实现为单调递增的“代际令牌”：
 *   - start(key) 使代际 +1 并成为当前选择；
 *   - invalidate() 使代际 +1 且清空当前选择（编辑脚本 / 重新校核）；
 *   - 计算结果到达时核对令牌与 key，不匹配即走 onStale，绝不调用 onResolve。
 *
 * compute 可以同步返回结果，也可以返回 Promise / thenable（页面用 setTimeout
 * 让出一帧，使“在途切换”真实可发生）。
 *
 * 同一份文件既可作为浏览器普通脚本（window.DSAuditRunner），
 * 也可在 Node 中被测试 / 验收引用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSAuditRunner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * @param {(payload:any)=>any|Promise<any>} compute 真正的审计计算（如 auditCheckpoint）
   * @param {{onBegin?:Function, onResolve?:Function, onStale?:Function,
   *          onError?:Function}} handlers 生命周期回调，均收到 key 作为首参
   */
  function createAuditRunner(compute, handlers) {
    let generation = 0;
    let currentKey = null;
    const h = handlers || {};

    function accept(token, key, payload) {
      // 同步发起计算（页面中 compute 内部用 setTimeout 让出一帧），再在结果
      // 到达时核对令牌：过期 / 已切换的迟到结果一律走 onStale，绝不覆盖当前选择。
      let pending;
      try {
        pending = Promise.resolve(compute(payload));
      } catch (err) {
        if (token !== generation || currentKey !== key) {
          if (h.onStale) h.onStale(key);
          return;
        }
        if (h.onError) h.onError(key, err);
        return;
      }
      pending.then(
        (result) => {
          if (token !== generation || currentKey !== key) {
            if (h.onStale) h.onStale(key);
            return;
          }
          if (h.onResolve) h.onResolve(key, result);
        },
        (err) => {
          if (token !== generation || currentKey !== key) {
            if (h.onStale) h.onStale(key);
            return;
          }
          if (h.onError) h.onError(key, err);
        }
      );
    }

    return {
      /** 发起一次新审计：旧审计立即失效（令牌自然过期）。 */
      start(key, payload) {
        generation += 1;
        currentKey = key;
        const token = generation;
        if (h.onBegin) h.onBegin(key);
        accept(token, key, payload);
        return token;
      },

      /** 使当前审计立即失效（编辑脚本 / 重新校核 / 载入示例）。 */
      invalidate() {
        generation += 1;
        currentKey = null;
      },

      /** 切换选择是否仍有效。 */
      isCurrent(key) {
        return currentKey === key;
      },

      currentKey() {
        return currentKey;
      },

      generation() {
        return generation;
      },
    };
  }

  return { createAuditRunner };
});
