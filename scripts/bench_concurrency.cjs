'use strict';
/**
 * 并发安全基线测试：在不同并发档位下测 iFinD 连接器的成功率。
 * 目的是找到"不触发 connector_tool_error 瞬时拒绝"的并发上限，
 * 而不是靠猜（实测 16 路会失败 608/1500）。
 */
const { callTool, throttleStats } = require('../src/connector');

const LEVELS = [4, 6, 8, 12];
const PER_LEVEL = 24;

function pool(items, limit, worker) {
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try { await worker(items[i]); } catch { /* ignore */ }
    }
  });
  return Promise.all(runners);
}

(async () => {
  // 预热
  await callTool('connector__thsifind__get_stock_summary', { query: '亚虹医药 估值水平' }, { timeoutMs: 60000, retries: 1 });

  for (const level of LEVELS) {
    const before = throttleStats();
    const items = Array.from({ length: PER_LEVEL }, (_, i) => i);
    const t0 = Date.now();
    let ok = 0, fail = 0;
    const errs = [];
    await pool(items, level, async (i) => {
      try {
        const d = await callTool('connector__thsifind__search_news', {
          query: `688${String(100 + i).padStart(3, '0')} 测试 公司 研报`,
          time_start: '2026-10-14', time_end: '2026-10-21', size: 3,
        }, { timeoutMs: 60000, retries: 1 });
        if (d) ok++; else fail++;
      } catch (e) { fail++; errs.push(String(e.message).slice(0, 60)); }
    });
    const after = throttleStats();
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`并发 ${String(level).padStart(2)} | 成功 ${ok}/${PER_LEVEL} (${(ok / PER_LEVEL * 100).toFixed(0)}%) | 失败 ${fail} | ${dt}s | 间隔 ${after.gapMs}ms | 错误样本: ${errs[0] || '-'}`);
  }
})();
