/**
 * dedupe.mjs — 同会话通知合并器（SPEC 5.5）。
 *
 * 语义：窗口 windowMs 内对同一 sessionId 的多次 push 只保留最后一次，
 * 窗口到期时触发该次 fire 恰好一次（setTimeout 宏任务）。
 * dispose() 清空全部 pending 定时器；dispose 后再 push 直接忽略。
 *
 * 测试：node --test 的 t.mock.timers.enable() 可替换全局 setTimeout/clearTimeout，
 * 因此这里不做时钟抽象，直接用全局定时器 + 可注入的 now（SPEC 签名要求）。
 */

/**
 * @param {number} windowMs 合并窗口毫秒数
 * @param {() => number} [now] 时钟注入（默认 Date.now），用于记录入队时刻，便于测试与诊断
 * @param {(error: unknown) => void} [onError] fire 回调抛错时的兜底出口；
 *   默认 console.error——绝不向宿主事件循环抛未捕获异常
 */
export function createCoalescer(windowMs, now = Date.now, onError = defaultOnError) {
  /** @type {Map<string|symbol, { timer: NodeJS.Timeout, fire: () => void, at: number }>} */
  const pending = new Map();
  let disposed = false;

  return {
    /**
     * 为 sessionId 入队/刷新一次通知。
     * 若该 id 已有 pending，则取消旧定时器、以新 fire 重置整个窗口（「保留最后一次」）。
     * @returns {boolean} 是否成功入队（disposed 后返回 false）
     */
    push(sessionId, fire) {
      if (disposed || typeof fire !== 'function') return false;
      const previous = pending.get(sessionId);
      if (previous !== undefined) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        pending.delete(sessionId); // 先出队再触发：fire 内若再 push 同一 id 可重新入队
        try {
          fire();
        } catch (error) {
          // fire 的异常若放任会成为宿主进程的未捕获异常；转发给兜底出口。
          onError(error);
        }
      }, Math.max(0, Number(windowMs) || 0));
      pending.set(sessionId, { timer, fire, at: now() });
      return true;
    },

    /** 清空所有 pending 定时器；此后 push 一律忽略。幂等。 */
    dispose() {
      disposed = true;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },

    /** 当前等待中的会话数量（诊断/测试用）。 */
    get size() {
      return pending.size;
    },

    get disposed() {
      return disposed;
    },
  };
}

function defaultOnError(error) {
  console.error('[task-notify] coalesced notification failed:', error);
}
