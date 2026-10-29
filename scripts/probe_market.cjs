'use strict';
const { callTool } = require('../src/connector');

(async () => {
  // A) iFinD 取科创50指数
  try {
    const d = await callTool('connector__thsifind__get_security_indicators', {
      market: 'A股',
      query: '科创50指数、科创综指 的最新收盘价、涨跌幅、成交额、换手率',
    });
    const a = d && d.answer ? d.answer : JSON.stringify(d);
    console.log('=== A iFinD index ===');
    console.log(String(a).slice(0, 1200));
  } catch (e) { console.log('=== A FAIL:', e.message); }

  // B) 快查 A股特色市场
  try {
    const d = await callTool('connector__kuaicha365__call', {
      tool_id: 'iwencai_astock_special',
      params_to_tool: JSON.stringify({
        query: '科创板今日整体行情 科创50指数 涨跌幅 上涨家数 下跌家数 涨停 跌停 成交额',
        domain: 'stock', limit: 20,
      }),
    });
    console.log('=== B kuaicha astock_special ===');
    console.log(String(d.raw || d).slice(0, 1800));
  } catch (e) { console.log('=== B FAIL:', e.message); }
})();
