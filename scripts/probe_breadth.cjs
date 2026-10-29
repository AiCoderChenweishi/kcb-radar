'use strict';
const { callTool } = require('../src/connector');

(async () => {
  const qs = [
    '科创板今日涨幅大于5%的股票',
    '科创板今日跌幅大于5%的股票',
    '科创板今日上涨的股票',
    '科创板今日下跌的股票',
    '科创板总市值大于200亿元的股票',
  ];
  for (const q of qs) {
    try {
      const t0 = Date.now();
      const d = await callTool('connector__thsifind__search_securities', { market: '股票', query: q });
      const total = d && d.selectedSecuritiesCount;
      const dataTotal = d && d.dataTotalVolume;
      console.log(`${q}  => 命中 ${total} 家 / 全市场 ${dataTotal}  (${Date.now() - t0}ms)`);
    } catch (e) { console.log(`${q} => FAIL ${e.message}`); }
  }
})();
