'use strict';
const { callTool } = require('../src/connector');

(async () => {
  const t0 = Date.now();
  try {
    const d = await callTool('connector__thsifind__get_stock_summary', {
      query: '亚虹医药、澜起科技 最新估值水平',
    });
    console.log('OK elapsed_ms=', Date.now() - t0, 'len=', d.length);
    const m = d.match(/# A股股票最新估值水平([\s\S]*?)# A股股票最新市值规模/);
    console.log(m ? m[1].trim().slice(0, 700) : 'SECTION_NOT_FOUND');
  } catch (e) {
    console.log('FAIL elapsed_ms=', Date.now() - t0, 'err=', e.message);
  }
})();
