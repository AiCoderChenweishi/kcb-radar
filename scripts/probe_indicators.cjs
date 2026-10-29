'use strict';
const { callTool } = require('../src/connector');

(async () => {
  // 1) 估值分位
  try {
    const t0 = Date.now();
    const d = await callTool('connector__thsifind__get_security_indicators', {
      market: 'A股',
      query: '亚虹医药、澜起科技、中微公司、传音控股、石头科技 的最新市盈率(PE,TTM)、市盈率近三年分位数、市净率(PB)、总市值、营业总收入同比增长率',
    });
    console.log('=== indicators elapsed_ms=', Date.now() - t0, 'len=', d.length);
    console.log(String(d).slice(0, 1800));
  } catch (e) { console.log('=== indicators FAIL:', e.message); }

  // 2) 公告
  try {
    const t0 = Date.now();
    const d = await callTool('connector__thsifind__search_notice', {
      query: '亚虹医药 公告 重大事项 授权 合同',
      time_start: '2026-10-01', time_end: '2026-10-21', size: 5,
    });
    console.log('=== notice elapsed_ms=', Date.now() - t0, 'type=', typeof d, 'len=', (d && d.length) || 0);
    console.log(String(d).slice(0, 1500));
  } catch (e) { console.log('=== notice FAIL:', e.message); }
})();
